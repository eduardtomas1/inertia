import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCommand, ServerEvent } from "@shared/contracts";
import { MESSAGE_SEARCH_QUERY_MAX, type MessageSearchResult } from "@shared/message-search";

export type MessageSearchCommand = (command: ClientCommand) => Promise<ServerEvent>;

type MessageSearchState = {
  query: string; result: MessageSearchResult | null; error: string | null;
  loadingMore: boolean; moreError: string | null;
};

function searchResult(event: ServerEvent, query: string): MessageSearchResult {
  if (event.type !== "request.result" || event.result.kind !== "conversation.messages.search" || event.result.query !== query) {
    throw new Error("The local service returned an unexpected search response.");
  }
  return event.result;
}

function appendPage(current: MessageSearchResult, next: MessageSearchResult): MessageSearchResult {
  const seen = new Set(current.hits.map(({ messageId }) => messageId));
  return { ...next, hits: [...current.hits, ...next.hits.filter(({ messageId }) => !seen.has(messageId))] };
}

export function useMessageSearch(open: boolean, query: string, sendCommand?: MessageSearchCommand) {
  const normalized = query.trim();
  const eligible = open && Boolean(sendCommand) && normalized.length >= 2 && normalized.length <= MESSAGE_SEARCH_QUERY_MAX && !normalized.includes("\0");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<MessageSearchState | null>(null);
  const olderRequest = useRef<string | null>(null);
  const cancelOlder = useCallback(() => {
    const requestId = olderRequest.current;
    olderRequest.current = null;
    if (requestId && sendCommand) {
      void sendCommand({ type: "conversation.messages.search.cancel", requestId: crypto.randomUUID(), payload: { searchRequestId: requestId } }).catch(() => undefined);
    }
  }, [sendCommand]);
  useEffect(() => {
    setState(null);
    if (!eligible || !sendCommand) return;
    let disposed = false;
    let started = false;
    let settled = false;
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      started = true;
      void sendCommand({ type: "conversation.messages.search", requestId, payload: { query: normalized } }).then((event) => {
        settled = true;
        if (disposed) return;
        setState({ query: normalized, result: searchResult(event, normalized), error: null, loadingMore: false, moreError: null });
      }).catch(() => {
        settled = true;
        if (!disposed) setState({ query: normalized, result: null, error: "Message search is unavailable. Try again.", loadingMore: false, moreError: null });
      });
    }, 200);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      cancelOlder();
      if (started && !settled) {
        void sendCommand({ type: "conversation.messages.search.cancel", requestId: crypto.randomUUID(), payload: { searchRequestId: requestId } }).catch(() => undefined);
      }
    };
  }, [eligible, normalized, sendCommand, attempt, cancelOlder]);
  const current = eligible && state?.query === normalized ? state : null;
  const continuation = current?.result?.continuation ?? null;
  const searched = current?.result ? current.query : null;
  const loadMore = useCallback((): void => {
    if (searched === null || !continuation || !sendCommand || olderRequest.current) return;
    const requestId = crypto.randomUUID();
    olderRequest.current = requestId;
    const update = (change: (state: MessageSearchState & { result: MessageSearchResult }) => MessageSearchState): void => {
      setState((previous) => previous?.query === searched && previous.result ? change({ ...previous, result: previous.result }) : previous);
    };
    update((previous) => ({ ...previous, loadingMore: true, moreError: null }));
    void sendCommand({ type: "conversation.messages.search", requestId, payload: { query: searched, continuation } }).then((event) => {
      if (olderRequest.current !== requestId) return;
      const page = searchResult(event, searched);
      olderRequest.current = null;
      update((previous) => ({ ...previous, result: appendPage(previous.result, page), loadingMore: false }));
    }).catch(() => {
      if (olderRequest.current !== requestId) return;
      olderRequest.current = null;
      update((previous) => ({ ...previous, loadingMore: false, moreError: "Older messages could not be searched. Try again." }));
    });
  }, [continuation, searched, sendCommand]);
  return {
    retry: () => { setState(null); setAttempt((value) => value + 1); },
    loadMore,
    result: current?.result ?? null,
    error: current?.error ?? null,
    loading: eligible && current === null,
    loadingMore: current?.loadingMore ?? false,
    moreError: current?.moreError ?? null,
  };
}
