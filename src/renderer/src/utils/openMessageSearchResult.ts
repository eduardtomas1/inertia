import type { AppSnapshot, Conversation, ServerEvent } from "@shared/contracts";
import type { MessageSearchTarget } from "@shared/message-search";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { DetachedChatWindowsController } from "../hooks/useDetachedChatWindows";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { requestMessageSearchFocus } from "./messageSearchFocus";

export interface MessageNavigationCopy {
  unavailable: string;
  failed: string;
}

export const MESSAGE_SEARCH_NAVIGATION_COPY: MessageNavigationCopy = {
  unavailable: "This search result is no longer available.",
  failed: "This search result could not be opened. Search again to refresh it.",
};

export async function openMessageSearchResult(hit: MessageSearchTarget, {
  snapshot, conversationSelectionGenerationRef, intent, detachedChats, request,
  selectConversationInMain, setActionError, onReady, signal, copy = MESSAGE_SEARCH_NAVIGATION_COPY,
}: {
  snapshot: AppSnapshot | null;
  conversationSelectionGenerationRef: RefObject<number>;
  intent: number;
  detachedChats: DetachedChatWindowsController;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  selectConversationInMain: (conversation: Conversation, options?: { focusComposer?: boolean; preserveDraft?: boolean }) => Promise<number | false>;
  setActionError: Dispatch<SetStateAction<string | null>>;
  onReady?: () => void;
  signal?: AbortSignal;
  copy?: MessageNavigationCopy;
}): Promise<boolean> {
  if (signal?.aborted || intent !== conversationSelectionGenerationRef.current) return false;
  const nextConversation = snapshot?.conversations.find(({ id, projectId, archivedAt }) =>
    id === hit.conversationId && projectId === hit.projectId && archivedAt === null);
  if (!nextConversation) {
    setActionError(copy.unavailable);
    return false;
  }
  const target: MessageSearchTarget = {
    projectId: hit.projectId, conversationId: hit.conversationId, turnId: hit.turnId, messageId: hit.messageId,
  };
  let navigationGeneration = intent;
  const cancel = () => {
    if (navigationGeneration === conversationSelectionGenerationRef.current) conversationSelectionGenerationRef.current += 1;
  };
  signal?.addEventListener("abort", cancel, { once: true });
  setActionError(null);
  try {
    // Validate persisted ownership before changing the selected chat or window.
    // A stale result must leave the user's current workspace in place.
    await request({ type: "conversation.message.reveal", payload: target });
    if (signal?.aborted || intent !== conversationSelectionGenerationRef.current) return false;
    if (detachedChats.conversationIds.has(hit.conversationId) && await detachedChats.focus(hit.conversationId)) {
      if (!signal?.aborted && intent === conversationSelectionGenerationRef.current) {
        await request({ type: "conversation.message.reveal", payload: { ...target, focusDetached: true } });
        if (signal?.aborted || intent !== conversationSelectionGenerationRef.current) return false;
        // Native focus proved liveness only before the asynchronous reveal.
        // Recheck without stealing focus again; a docked/closed owner needs main.
        const windows = await window.inertia.getDetachedChatWindows();
        if (signal?.aborted || intent !== conversationSelectionGenerationRef.current) return false;
        if (windows.some(({ conversationId }) => conversationId === hit.conversationId)) return true;
      } else return false;
    }
    if (signal?.aborted || intent !== conversationSelectionGenerationRef.current) return false;
    const selection = selectConversationInMain(nextConversation, { focusComposer: false, preserveDraft: true });
    const generation = conversationSelectionGenerationRef.current;
    navigationGeneration = generation;
    const committedGeneration = await selection;
    if (committedGeneration === false) {
      if (generation === conversationSelectionGenerationRef.current) throw new Error("Selection failed");
      return false;
    }
    navigationGeneration = committedGeneration;
    if (signal?.aborted || committedGeneration !== conversationSelectionGenerationRef.current) return false;
    onReady?.();
    requestMessageSearchFocus(target, () => committedGeneration === conversationSelectionGenerationRef.current);
    return true;
  } catch {
    if (!signal?.aborted && navigationGeneration === conversationSelectionGenerationRef.current) {
      setActionError(copy.failed);
    }
    return false;
  } finally { signal?.removeEventListener("abort", cancel); }
}
