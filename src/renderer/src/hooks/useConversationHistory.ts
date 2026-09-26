import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ConversationDetailViewState, ServerEvent } from "@shared/contracts";
import type { ConversationHistoryRequest } from "@shared/conversation-history";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { mergeConversationHistory } from "../utils/conversationHistory";
import { prepareConversationHistoryPrepend } from "../utils/conversationHistoryNavigation";
import { MESSAGE_SEARCH_FOCUS_EVENT, pendingMessageSearchFocus } from "../utils/messageSearchFocus";
import { pendingTimelineFocus, TIMELINE_FOCUS_EVENT } from "../utils/timelineFocus";

export function useConversationHistory({ conversationId, online, detailState, setDetailState, request }: {
  conversationId: string | null;
  online: boolean;
  detailState: ConversationDetailViewState | null;
  setDetailState: Dispatch<SetStateAction<ConversationDetailViewState | null>>;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
}) {
  const current = useRef(detailState);
  current.current = detailState;
  const generation = useRef(0);
  const pending = useRef(false);
  const failedTarget = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    failedTarget.current = null;
    setLoading(false);
    setError(null);
    return () => { generation.current += 1; };
  }, [conversationId, online]);
  const load = useCallback(async (history: ConversationHistoryRequest, mode: "older" | "target") => {
    if (!conversationId || !online || pending.current) return;
    const owner = generation.current;
    const targetKey = history.messageId ?? history.turnId ?? null;
    pending.current = true;
    setLoading(true);
    setError(null);
    try {
      const event = await request({ type: "conversation.detail.load", payload: { conversationId, history } });
      if (owner !== generation.current) return;
      if (event.type !== "request.result" || event.result.kind !== "conversation.detail"
        || event.result.conversationId !== conversationId) throw new Error("The chat history response was not recognized.");
      const result = event.result;
      if (result.state !== "ready") throw new Error(result.state === "failed" ? result.message : "This chat history is no longer available.");
      if (mode === "older") prepareConversationHistoryPrepend(conversationId);
      setDetailState((previous) => previous?.state === "ready" && previous.conversationId === conversationId
        ? { ...previous, detail: mergeConversationHistory(previous.detail, result.detail, mode) }
        : previous);
    } catch (failure) {
      if (owner === generation.current) {
        failedTarget.current = targetKey;
        setError(failure instanceof Error ? failure.message : "Earlier messages could not be loaded.");
      }
    } finally {
      if (owner === generation.current) { pending.current = false; setLoading(false); }
    }
  }, [conversationId, online, request, setDetailState]);
  const loadOlder = useCallback(() => {
    const state = current.current;
    if (state?.state !== "ready" || state.conversationId !== conversationId) return;
    const before = state.detail.history?.older;
    if (before) void load({ before }, "older");
  }, [conversationId, load]);
  useEffect(() => {
    const focusMessage = () => {
      if (!conversationId) return;
      const target = pendingMessageSearchFocus(conversationId);
      const state = current.current;
      if (!target || state?.state !== "ready" || state.conversationId !== conversationId
        || target.messageId === failedTarget.current
        || state.detail.messages.some(({ id }) => id === target.messageId)) return;
      void load({ messageId: target.messageId }, "target");
    };
    const focusTurn = () => {
      if (!conversationId) return;
      const target = pendingTimelineFocus(conversationId);
      const state = current.current;
      if (!target || target.turnId === failedTarget.current
        || state?.state !== "ready" || state.detail.agentTurns.some(({ id }) => id === target.turnId)) return;
      void load({ turnId: target.turnId }, "target");
    };
    const retryMessage = () => { failedTarget.current = null; focusMessage(); };
    const retryTurn = () => { failedTarget.current = null; focusTurn(); };
    window.addEventListener(MESSAGE_SEARCH_FOCUS_EVENT, retryMessage);
    window.addEventListener(TIMELINE_FOCUS_EVENT, retryTurn);
    focusMessage();
    focusTurn();
    return () => {
      window.removeEventListener(MESSAGE_SEARCH_FOCUS_EVENT, retryMessage);
      window.removeEventListener(TIMELINE_FOCUS_EVENT, retryTurn);
    };
  }, [conversationId, detailState?.state, load, loading]);
  const hasOlder = detailState?.state === "ready" && Boolean(detailState.detail.history?.older);
  return useMemo(() => ({ hasOlder, loading, error, loadOlder }), [hasOlder, loading, error, loadOlder]);
}
