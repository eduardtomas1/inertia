import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationContentResult, ConversationDetail, ConversationHistoryRequest, ServerEvent } from "@shared/contracts";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { MESSAGE_SEARCH_FOCUS_EVENT, pendingMessageSearchFocus } from "../utils/messageSearchFocus";

export const MAX_HISTORY_NAVIGATION_SELECTIONS = 32;
interface HistorySelection {
  request: ConversationHistoryRequest;
  revision: number;
  handledSearchFocus: ReturnType<typeof pendingMessageSearchFocus>;
}
function rememberSelection(current: Map<string, HistorySelection>, conversationId: string, selection: HistorySelection): Map<string, HistorySelection> {
  const selections = new Map(current);
  selections.delete(conversationId);
  selections.set(conversationId, selection);
  while (selections.size > MAX_HISTORY_NAVIGATION_SELECTIONS) selections.delete(selections.keys().next().value!);
  return selections;
}

export function useConversationHistoryNavigation(
  conversationId: string | null,
  detail: ConversationDetail | null,
  request: (command: CommandWithoutId) => Promise<ServerEvent>,
) {
  // Retain only navigation metadata, never the loaded history pages themselves.
  const [selections, setSelections] = useState(() => new Map<string, HistorySelection>());
  const selection = conversationId ? selections.get(conversationId) : undefined;
  const pendingSearchFocus = conversationId ? pendingMessageSearchFocus(conversationId) : null;
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyRequest = useMemo(() => {
    if (pendingSearchFocus && pendingSearchFocus !== selection?.handledSearchFocus) return { anchorMessageId: pendingSearchFocus.messageId };
    return selection?.request ?? {};
  }, [pendingSearchFocus, selection]);
  useEffect(() => {
    if (!conversationId || !pendingSearchFocus || pendingSearchFocus === selection?.handledSearchFocus) return;
    // Search focus is transient; preserve its anchor after the transcript consumes it.
    // Keep the request object and revision so adoption does not repeat the load.
    setSelections((current) => current.get(conversationId)?.handledSearchFocus === pendingSearchFocus
      ? current
      : rememberSelection(current, conversationId, { request: historyRequest, revision: selection?.revision ?? 0, handledSearchFocus: pendingSearchFocus }));
  }, [conversationId, historyRequest, pendingSearchFocus, selection]);
  const select = useCallback((next: ConversationHistoryRequest) => {
    if (!conversationId) return;
    setHistoryError(null);
    const handledSearchFocus = pendingMessageSearchFocus(conversationId);
    setSelections((current) => rememberSelection(current, conversationId, {
      request: next, revision: (current.get(conversationId)?.revision ?? 0) + 1, handledSearchFocus,
    }));
  }, [conversationId]);
  const loadLatestHistory = useCallback(() => select({}), [select]);
  const resetHistoryNavigation = useCallback(() => {
    setHistoryError(null);
    setSelections((current) => conversationId ? new Map([[conversationId, {
      request: {}, revision: (current.get(conversationId)?.revision ?? 0) + 1,
      handledSearchFocus: pendingMessageSearchFocus(conversationId),
    }]]) : new Map());
  }, [conversationId]);
  const loadOlderHistory = useCallback(() => {
    if (detail?.history?.olderCursor) select({ cursor: detail.history.olderCursor });
  }, [detail?.history?.olderCursor, select]);
  const loadNewerHistory = useCallback(() => {
    if (detail?.history?.newerCursor) select({ cursor: detail.history.newerCursor });
  }, [detail?.history?.newerCursor, select]);
  useEffect(() => {
    if (!conversationId) return;
    const focus = (): void => {
      const target = pendingMessageSearchFocus(conversationId);
      if (target && !detail?.messages.some((message) => message.id === target.messageId)) {
        select({ anchorMessageId: target.messageId });
      }
    };
    window.addEventListener(MESSAGE_SEARCH_FOCUS_EVENT, focus);
    return () => window.removeEventListener(MESSAGE_SEARCH_FOCUS_EVENT, focus);
  }, [conversationId, detail?.messages, select]);
  const readDeferredContent = useCallback(async (cursor: string): Promise<ConversationContentResult> => {
    if (!conversationId) throw new Error("Choose a chat first.");
    const event = await request({ type: "conversation.content.read", payload: { conversationId, cursor } });
    if (event.type !== "request.result" || event.result.kind !== "conversation.content" || event.result.conversationId !== conversationId) {
      throw new Error(event.type === "request.error" ? event.message : "The requested text could not be loaded.");
    }
    return event.result;
  }, [conversationId, request]);
  return { historyRequest, historyRevision: selection?.revision ?? 0,
    historyLoading, setHistoryLoading, historyError, setHistoryError,
    loadOlderHistory, loadNewerHistory, loadLatestHistory, resetHistoryNavigation, readDeferredContent };
}
