import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ServerEvent } from "@shared/contracts";
import type { PullRequestsResult, StackReview } from "@shared/pull-requests";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
export type PullRequestCommand = Extract<CommandWithoutId, { type: `conversation.prs.${string}` | `conversation.stack.${string}` }>;
export type PullRequestRunner = (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
export function usePullRequests(conversationId: string, run: PullRequestRunner, active: boolean, disabled: boolean) {
  const [result, setResult] = useState<PullRequestsResult | null>(null);
  const [review, setReview] = useState<StackReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = useRef(0), revision = useRef(0), inFlight = useRef(false);
  const cached = useRef<PullRequestsResult | null>(null);
  useLayoutEffect(() => {
    owner.current++; revision.current++; inFlight.current = false;
    cached.current = null;
    setResult(null); setReview(null); setError(null); setBusy(false);
    return () => { owner.current += 1; revision.current += 1; };
  }, [conversationId, run]);
  const invoke = useCallback(async (command: PullRequestCommand): Promise<boolean> => {
    if (inFlight.current || disabled) return false;
    const generation = owner.current, request = ++revision.current;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const event = await run(command.type, command);
      if (owner.current !== generation || revision.current !== request) return false;
      if (event.type === "request.error") throw new Error(event.message);
      if (event.type !== "request.result") throw new Error("The local service returned an unexpected response.");
      if (event.result.kind === "conversation.pull-requests" && event.result.conversationId === conversationId) { cached.current = event.result; setResult(event.result); }
      else if (event.result.kind === "conversation.stack-review" && event.result.review.conversationId === conversationId) setReview(event.result.review);
      else throw new Error("The pull request response belongs to another chat.");
      return true;
    } catch (cause) {
      if (owner.current === generation && revision.current === request) setError(cause instanceof Error ? cause.message : "The pull request action failed.");
      return false;
    } finally {
      if (owner.current === generation && revision.current === request) { inFlight.current = false; setBusy(false); }
    }
  }, [conversationId, disabled, run]);
  useEffect(() => {
    if (active && !disabled) void invoke({ type: "conversation.prs.get", payload: { conversationId } }).then((loaded) => {
      if (loaded && cached.current?.links.some((link) => link.snapshot === null)) {
        void invoke({ type: "conversation.prs.refresh", payload: { conversationId } });
      }
    });
  }, [active, conversationId, disabled, invoke]);
  useEffect(() => {
    if (!active || disabled || review) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void invoke({ type: "conversation.prs.refresh", payload: { conversationId } });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [active, conversationId, disabled, invoke, review]);
  return { result, review, error, busy, invoke, dismissReview: () => setReview(null) };
}
