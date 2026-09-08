import type { AppSnapshot, Conversation, ServerEvent } from "@shared/contracts";
import type { MessageSearchHit, MessageSearchTarget } from "@shared/message-search";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { DetachedChatWindowsController } from "../hooks/useDetachedChatWindows";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { requestMessageSearchFocus } from "./messageSearchFocus";

export function openMessageSearchResult(hit: MessageSearchHit, {
  snapshot, conversationSelectionGenerationRef, intent, detachedChats, request,
  selectConversationInMain, setActionError, onReady,
}: {
  snapshot: AppSnapshot | null;
  conversationSelectionGenerationRef: RefObject<number>;
  intent: number;
  detachedChats: DetachedChatWindowsController;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  selectConversationInMain: (conversation: Conversation, options?: { focusComposer?: boolean; preserveDraft?: boolean }) => Promise<boolean>;
  setActionError: Dispatch<SetStateAction<string | null>>;
  onReady?: () => void;
}): void {
  const nextConversation = snapshot?.conversations.find(({ id, projectId, archivedAt }) =>
    id === hit.conversationId && projectId === hit.projectId && archivedAt === null);
  if (!nextConversation) {
    setActionError("This search result is no longer available.");
    return;
  }
  const target: MessageSearchTarget = {
    projectId: hit.projectId, conversationId: hit.conversationId, turnId: hit.turnId, messageId: hit.messageId,
  };
  let navigationGeneration = intent;
  setActionError(null);
  void (async () => {
    // Validate persisted ownership before changing the selected chat or window.
    // A stale result must leave the user's current workspace in place.
    await request({ type: "conversation.message.reveal", payload: target });
    if (intent !== conversationSelectionGenerationRef.current) return;
    if (detachedChats.conversationIds.has(hit.conversationId) && await detachedChats.focus(hit.conversationId)) {
      if (intent === conversationSelectionGenerationRef.current) {
        await request({ type: "conversation.message.reveal", payload: { ...target, focusDetached: true } });
      }
      return;
    }
    if (intent !== conversationSelectionGenerationRef.current) return;
    onReady?.();
    const selection = selectConversationInMain(nextConversation, { focusComposer: false, preserveDraft: true });
    const generation = conversationSelectionGenerationRef.current;
    navigationGeneration = generation;
    if (!await selection || generation !== conversationSelectionGenerationRef.current) return;
    if (generation === conversationSelectionGenerationRef.current) requestMessageSearchFocus(target, () => generation === conversationSelectionGenerationRef.current);
  })().catch(() => {
    if (navigationGeneration === conversationSelectionGenerationRef.current) {
      setActionError("This search result could not be opened. Search again to refresh it.");
    }
  });
}
