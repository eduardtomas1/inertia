import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ConversationDetail, ConversationDetailViewState, ServerEvent } from "@shared/contracts";
import type { ConversationHistoryCursor, ConversationHistoryRequest } from "@shared/conversation-history";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { mergeConversationHistory } from "../utils/conversationHistory";
import { prepareConversationHistoryPrepend } from "../utils/conversationHistoryNavigation";
import { MESSAGE_SEARCH_FOCUS_EVENT, pendingMessageSearchFocus } from "../utils/messageSearchFocus";
import { pendingTimelineFocus, TIMELINE_FOCUS_EVENT } from "../utils/timelineFocus";

interface PrefetchedOlderPage {
  conversationId: string;
  before: ConversationHistoryCursor;
  response: Promise<ServerEvent>;
  detail: ConversationDetail | null;
  at: number;
}

const PREFETCHED_PAGE_MAX_AGE_MS = 60_000;

function historyPage(conversationId: string, event: ServerEvent): ConversationDetail {
  if (event.type !== "request.result" || event.result.kind !== "conversation.detail"
    || event.result.conversationId !== conversationId) throw new Error("The chat history response was not recognized.");
  const result = event.result;
  if (result.state !== "ready") throw new Error(result.state === "failed" ? result.message : "This chat history is no longer available.");
  return result.detail;
}

function sameCursor(left: ConversationHistoryCursor, right: ConversationHistoryCursor | undefined): boolean {
  return Boolean(right) && left.at === right!.at && left.id === right!.id && left.kind === right!.kind;
}

function whenIdle(callback: () => void): (() => void) | null {
  if (typeof window.requestIdleCallback !== "function" || typeof window.cancelIdleCallback !== "function") return null;
  const handle = window.requestIdleCallback(callback, { timeout: 1_000 });
  return () => window.cancelIdleCallback(handle);
}

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
  const interruptedOlder = useRef<string | null>(null);
  const prefetched = useRef<PrefetchedOlderPage | null>(null);
  const applied = useRef<ConversationHistoryCursor | null>(null);
  const cancelPrefetch = useRef<(() => void) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    applied.current = null;
    failedTarget.current = null;
    if (interruptedOlder.current !== conversationId) interruptedOlder.current = null;
    setLoading(false);
    setError(null);
    return () => {
      generation.current += 1;
      cancelPrefetch.current?.();
      cancelPrefetch.current = null;
      prefetched.current = null;
    };
  }, [conversationId, online]);
  useEffect(() => { applied.current = null; }, [detailState]);
  const prefetchOlder = useCallback((before: ConversationHistoryCursor | null | undefined) => {
    cancelPrefetch.current?.();
    cancelPrefetch.current = null;
    if (!before || !conversationId) return;
    const owner = generation.current;
    cancelPrefetch.current = whenIdle(() => {
      cancelPrefetch.current = null;
      if (owner !== generation.current || pending.current) return;
      const response = request({ type: "conversation.detail.load", payload: { conversationId, history: { before } } });
      const page: PrefetchedOlderPage = { conversationId, before, response, detail: null, at: Date.now() };
      const discard = () => { if (prefetched.current === page) prefetched.current = null; };
      prefetched.current = page;
      response.then((event) => {
        try { page.detail = historyPage(conversationId, event); } catch { discard(); }
      }, discard);
    });
  }, [conversationId, request]);
  const applyOlder = useCallback((owner: string, detail: ConversationDetail) => {
    prepareConversationHistoryPrepend(owner);
    setDetailState((previous) => previous?.state === "ready" && previous.conversationId === owner
      ? { ...previous, detail: mergeConversationHistory(previous.detail, detail, "older") }
      : previous);
    prefetchOlder(detail.history?.older);
  }, [prefetchOlder, setDetailState]);
  const load = useCallback(async (history: ConversationHistoryRequest, mode: "older" | "target") => {
    if (!conversationId || !online || pending.current) return;
    if (mode === "older" && history.before && applied.current && sameCursor(history.before, applied.current)) return;
    const owner = generation.current;
    const targetKey = history.messageId ?? history.turnId ?? null;
    const early = mode === "older" ? prefetched.current : null;
    if (mode === "older") prefetched.current = null;
    const reusable = early?.conversationId === conversationId && sameCursor(early.before, history.before)
      && Date.now() - early.at <= PREFETCHED_PAGE_MAX_AGE_MS
      ? early
      : null;
    if (reusable?.detail) {
      applied.current = history.before ?? null;
      applyOlder(conversationId, reusable.detail);
      return;
    }
    pending.current = true;
    if (mode === "older") interruptedOlder.current = conversationId;
    setLoading(true);
    setError(null);
    try {
      const event = await (reusable?.response
        ?? request({ type: "conversation.detail.load", payload: { conversationId, history } }));
      if (owner !== generation.current) return;
      if (mode === "older") interruptedOlder.current = null;
      const detail = historyPage(conversationId, event);
      if (mode === "older") {
        applied.current = history.before ?? null;
        applyOlder(conversationId, detail);
        return;
      }
      if (targetKey && !detail.messages.some(({ id }) => id === targetKey)
        && !detail.agentTurns.some(({ id }) => id === targetKey)) failedTarget.current = targetKey;
      setDetailState((previous) => previous?.state === "ready" && previous.conversationId === conversationId
        ? { ...previous, detail: mergeConversationHistory(previous.detail, detail, mode) }
        : previous);
    } catch (failure) {
      if (owner === generation.current) {
        failedTarget.current = targetKey;
        setError(failure instanceof Error ? failure.message : "Earlier messages could not be loaded.");
      }
    } finally {
      if (owner === generation.current) { pending.current = false; setLoading(false); }
    }
  }, [applyOlder, conversationId, online, request, setDetailState]);
  const loadOlder = useCallback(() => {
    const state = current.current;
    if (state?.state !== "ready" || state.conversationId !== conversationId) return;
    const before = state.detail.history?.older;
    if (before) void load({ before }, "older");
  }, [conversationId, load]);
  const ready = detailState?.state === "ready" && detailState.conversationId === conversationId;
  useEffect(() => {
    if (online && ready && conversationId && interruptedOlder.current === conversationId) loadOlder();
  }, [conversationId, loadOlder, online, ready]);
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
  const omittedTurnIds = detailState?.state === "ready" ? detailState.detail.history?.omittedTurnIds : undefined;
  return useMemo(() => ({ hasOlder, loading, error, loadOlder, omittedTurnIds, online }),
    [hasOlder, loading, error, loadOlder, omittedTurnIds, online]);
}
