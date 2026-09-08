import { useEffect, useState } from "react";
import type { ClientCommand, ServerEvent } from "@shared/contracts";
import { MESSAGE_SEARCH_QUERY_MAX, type MessageSearchResult } from "@shared/message-search";

export type MessageSearchCommand = (command: ClientCommand) => Promise<ServerEvent>;

export function useMessageSearch(open: boolean, query: string, sendCommand?: MessageSearchCommand) {
  const normalized = query.trim();
  const eligible = open && Boolean(sendCommand) && normalized.length >= 2 && normalized.length <= MESSAGE_SEARCH_QUERY_MAX && !normalized.includes("\0");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    query: string; result: MessageSearchResult | null; error: string | null;
  } | null>(null);
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
        if (event.type !== "request.result" || event.result.kind !== "conversation.messages.search" || event.result.query !== normalized) {
          throw new Error("The local service returned an unexpected search response.");
        }
        setState({ query: normalized, result: event.result, error: null });
      }).catch(() => {
        settled = true;
        if (!disposed) setState({ query: normalized, result: null, error: "Message search is unavailable. Try again." });
      });
    }, 200);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (started && !settled) {
        void sendCommand({ type: "conversation.messages.search.cancel", requestId: crypto.randomUUID(), payload: { searchRequestId: requestId } }).catch(() => undefined);
      }
    };
  }, [eligible, normalized, sendCommand, attempt]);
  const current = eligible && state?.query === normalized ? state : null;
  return { retry: () => { setState(null); setAttempt((value) => value + 1); }, result: current?.result ?? null, error: current?.error ?? null, loading: eligible && current === null };
}
