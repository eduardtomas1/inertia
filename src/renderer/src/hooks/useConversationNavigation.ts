import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AppSnapshot, Conversation, ServerEvent } from "@shared/contracts";
import type { MessageSearchHit, MessageSearchTarget } from "@shared/message-search";
import type { DetachedChatWindowsController } from "./useDetachedChatWindows";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { splitConversationAfterPrimaryChange } from "../utils/splitConversation";
import { clearMessageSearchFocus, requestMessageSearchFocus } from "../utils/messageSearchFocus";

export function useConversationNavigation({
  snapshot, conversation, splitConversation, detachedChats, exitGlobalChat,
  conversationSelectionGenerationRef, splitSelectionTransitionsRef,
  setSuppressedMainConversationIds, setSecondaryPaneFirst,
  selectConversationCommand, updateSplitConversationId, request, setActionError,
}: {
  snapshot: AppSnapshot | null;
  conversation: Conversation | null;
  splitConversation: Conversation | null;
  detachedChats: DetachedChatWindowsController;
  exitGlobalChat: () => void;
  conversationSelectionGenerationRef: RefObject<number>;
  splitSelectionTransitionsRef: RefObject<number>;
  setSuppressedMainConversationIds: Dispatch<SetStateAction<Set<string>>>;
  setSecondaryPaneFirst: Dispatch<SetStateAction<boolean>>;
  selectConversationCommand: (key: string, conversationId: string) => Promise<ServerEvent>;
  updateSplitConversationId: (id: string | null) => void;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  setActionError: Dispatch<SetStateAction<string | null>>;
}) {
  const selectConversationInMain = useCallback((
    nextConversation: Conversation,
    focusComposer = true,
  ): Promise<boolean> => {
    clearMessageSearchFocus();
    exitGlobalChat();
    const selectionGeneration = ++conversationSelectionGenerationRef.current;
    setSuppressedMainConversationIds((current) => {
      if (!current.has(nextConversation.id)) return current;
      const next = new Set(current);
      next.delete(nextConversation.id);
      return next;
    });
    if (nextConversation.id === conversation?.id) return Promise.resolve(true);
    if (nextConversation.id === splitConversation?.id) {
      // A split-pane promotion is visual only. Retargeting the primary and
      // secondary controllers would tear down conversation-owned terminals,
      // previews, attachments, and tool state.
      setSecondaryPaneFirst(true);
      if (focusComposer) window.setTimeout(() => {
        document.querySelector<HTMLElement>(
          "#secondary-conversation-pane textarea",
        )?.focus({ preventScroll: true });
      }, 0);
      return Promise.resolve(true);
    }
    const nextSplitConversationId = splitConversationAfterPrimaryChange(
      conversation,
      nextConversation,
      splitConversation,
    );
    setSecondaryPaneFirst(false);
    splitSelectionTransitionsRef.current += 1;
    return selectConversationCommand(
      "conversation.select",
      nextConversation.id,
    ).then(() => {
      if (
        selectionGeneration === conversationSelectionGenerationRef.current
      ) {
        updateSplitConversationId(nextSplitConversationId);
        return true;
      }
      return false;
    }).catch(() => false).finally(() => {
      splitSelectionTransitionsRef.current = Math.max(
        0,
        splitSelectionTransitionsRef.current - 1,
      );
    });
  }, [
    conversation,
    conversationSelectionGenerationRef,
    splitSelectionTransitionsRef,
    setSuppressedMainConversationIds,
    setSecondaryPaneFirst,
    exitGlobalChat,
    selectConversationCommand,
    splitConversation,
    updateSplitConversationId,
  ]);
  const selectConversation = useCallback((nextConversation: Conversation) => {
    clearMessageSearchFocus();
    const generation = ++conversationSelectionGenerationRef.current;
    if (!detachedChats.conversationIds.has(nextConversation.id)) {
      void selectConversationInMain(nextConversation);
      return;
    }
    void detachedChats.focus(nextConversation.id).then((focused) => {
      // A dock event can overtake React's projection of the native registry.
      // Falling back here makes the explicit return-to-main action race-safe.
      if (!focused && generation === conversationSelectionGenerationRef.current) void selectConversationInMain(nextConversation);
    }).catch(() => {
      if (generation === conversationSelectionGenerationRef.current) void selectConversationInMain(nextConversation);
    });
  }, [conversationSelectionGenerationRef, detachedChats, selectConversationInMain]);
  const selectMessage = useCallback((hit: MessageSearchHit): void => {
    const nextConversation = snapshot?.conversations.find(({ id, projectId, archivedAt }) =>
      id === hit.conversationId && projectId === hit.projectId && archivedAt === null);
    if (!nextConversation) {
      setActionError("This search result is no longer available.");
      return;
    }
    const target: MessageSearchTarget = {
      projectId: hit.projectId, conversationId: hit.conversationId, turnId: hit.turnId, messageId: hit.messageId,
    };
    const intent = ++conversationSelectionGenerationRef.current;
    let navigationGeneration = intent;
    clearMessageSearchFocus();
    setActionError(null);
    void (async () => {
      if (detachedChats.conversationIds.has(hit.conversationId) && await detachedChats.focus(hit.conversationId)) {
        if (intent === conversationSelectionGenerationRef.current) await request({ type: "conversation.message.reveal", payload: target });
        return;
      }
      if (intent !== conversationSelectionGenerationRef.current) return;
      const selection = selectConversationInMain(nextConversation, false);
      const generation = conversationSelectionGenerationRef.current;
      navigationGeneration = generation;
      if (!await selection || generation !== conversationSelectionGenerationRef.current) return;
      await request({ type: "conversation.message.reveal", payload: target });
      if (generation === conversationSelectionGenerationRef.current) requestMessageSearchFocus(target, () => generation === conversationSelectionGenerationRef.current);
    })().catch(() => {
      if (navigationGeneration === conversationSelectionGenerationRef.current) {
        setActionError("This search result could not be opened. Search again to refresh it.");
      }
    });
  }, [snapshot, conversationSelectionGenerationRef, detachedChats, request, selectConversationInMain, setActionError]);
  return { selectConversation, selectMessage };
}
