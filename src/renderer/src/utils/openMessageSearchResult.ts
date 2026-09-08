import type { AppSnapshot, Conversation, ServerEvent } from "@shared/contracts";
import type { MessageSearchHit, MessageSearchTarget } from "@shared/message-search";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { DetachedChatWindowsController } from "../hooks/useDetachedChatWindows";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { requestMessageSearchFocus } from "./messageSearchFocus";

export async function openMessageSearchResult(hit: MessageSearchHit, {
  snapshot, conversationSelectionGenerationRef, intent, detachedChats, request,
  selectConversationInMain, setActionError, onReady, signal,
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
}): Promise<boolean> {
  if (signal?.aborted || intent !== conversationSelectionGenerationRef.current) return false;
  const nextConversation = snapshot?.conversations.find(({ id, projectId, archivedAt }) =>
    id === hit.conversationId && projectId === hit.projectId && archivedAt === null);
  if (!nextConversation) {
    setActionError("This search result is no longer available.");
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
        return !signal?.aborted && intent === conversationSelectionGenerationRef.current;
      }
      return false;
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
      setActionError("This search result could not be opened. Search again to refresh it.");
    }
    return false;
  } finally { signal?.removeEventListener("abort", cancel); }
}
