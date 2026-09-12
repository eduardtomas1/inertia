import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AppSnapshot, Conversation, ServerEvent } from "@shared/contracts";
import type { MessageSearchHit } from "@shared/message-search";
import type { DetachedChatWindowsController } from "./useDetachedChatWindows";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { splitConversationAfterPrimaryChange } from "../utils/splitConversation";

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
  exitGlobalChat: (preserveDraft?: boolean) => void;
  conversationSelectionGenerationRef: RefObject<number>;
  splitSelectionTransitionsRef: RefObject<number>;
  setSuppressedMainConversationIds: Dispatch<SetStateAction<Set<string>>>;
  setSecondaryPaneFirst: Dispatch<SetStateAction<boolean>>;
  selectConversationCommand: (key: string, conversationId: string, isCurrent?: () => boolean) => Promise<ServerEvent>;
  updateSplitConversationId: (id: string | null) => void;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  setActionError: Dispatch<SetStateAction<string | null>>;
}) {
  const selectConversationInMain = useCallback((
    nextConversation: Conversation,
    { focusComposer = true, preserveDraft = false } = {},
  ): Promise<number | false> => {
    if (!preserveDraft) exitGlobalChat();
    const selectionGeneration = ++conversationSelectionGenerationRef.current;
    const commitSelection = (): number => {
      if (preserveDraft) exitGlobalChat(true);
      setSuppressedMainConversationIds((current) => {
        if (!current.has(nextConversation.id)) return current;
        const next = new Set(current);
        next.delete(nextConversation.id);
        return next;
      });
      return conversationSelectionGenerationRef.current;
    };
    // A pending selection may already have reached the runtime while this
    // snapshot still shows the old chat. Serialize an explicit return to it.
    if (nextConversation.id === conversation?.id && splitSelectionTransitionsRef.current === 0) return Promise.resolve(commitSelection());
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
      return Promise.resolve(commitSelection());
    }
    const nextSplitConversationId = splitConversationAfterPrimaryChange(
      conversation,
      nextConversation,
      splitConversation,
    );
    if (!preserveDraft) setSecondaryPaneFirst(false);
    splitSelectionTransitionsRef.current += 1;
    return selectConversationCommand(
      "conversation.select",
      nextConversation.id,
      preserveDraft ? () => selectionGeneration === conversationSelectionGenerationRef.current : undefined,
    ).then((): number | false => {
      if (
        selectionGeneration === conversationSelectionGenerationRef.current
      ) {
        const committedGeneration = commitSelection();
        if (preserveDraft) setSecondaryPaneFirst(false);
        updateSplitConversationId(nextSplitConversationId);
        return committedGeneration;
      }
      return false;
    }).catch(() => false as const).finally(() => {
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
  const selectMessage = useCallback((hit: MessageSearchHit, onReady?: () => void, signal?: AbortSignal): Promise<boolean> => {
    const intent = ++conversationSelectionGenerationRef.current;
    return import("../utils/openMessageSearchResult").then(({ openMessageSearchResult }) => {
      return openMessageSearchResult(hit, { snapshot, conversationSelectionGenerationRef, intent,
        detachedChats, request, selectConversationInMain, setActionError, onReady, signal });
    }).catch(() => {
      if (!signal?.aborted && intent === conversationSelectionGenerationRef.current) setActionError("Search navigation is unavailable. Try again.");
      return false;
    });
  }, [snapshot, conversationSelectionGenerationRef, detachedChats, request, selectConversationInMain, setActionError]);
  return { selectConversation, selectMessage };
}
