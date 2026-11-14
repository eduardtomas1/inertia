import {
  DELEGATION_WAIT_DEFAULT_MS,
  DELEGATION_WAIT_MAX_MS,
  type DelegatedTaskView,
} from "../../../shared/orchestration-delegation";
import type { ProviderId } from "../../../shared/provider";

export type DelegatedWaitOutcome = "terminal" | "needs_action" | "timeout";

export const DEFAULT_DELEGATED_WAIT_POLL_MS = 1_000;

export class DelegatedWaitAbortedError extends Error {
  constructor() {
    super("The wait was cancelled with the calling turn.");
    this.name = "DelegatedWaitAbortedError";
  }
}

export function clampDelegatedWaitTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DELEGATION_WAIT_DEFAULT_MS;
  return Math.min(DELEGATION_WAIT_MAX_MS, Math.max(1, Math.trunc(value)));
}

/**
 * How long one host-tool call may stay silent on providers whose MCP client
 * drops it at 300 s: Inertia's stdio bridge (Cursor, Kimi Code) and Pi's
 * bridge both use Node fetch, whose headers timeout is 300 s, and the host MCP
 * server answers only when the call completes. A dropped call loses the task
 * handle and, on the stdio bridge, ends the bridge for the rest of the turn.
 * The same providers and value bound secret waits.
 */
export const DELEGATED_WAIT_CALL_BUDGET_MS: Readonly<Partial<Record<ProviderId, number>>> = Object.freeze({
  cursor: 270_000,
  kimi: 270_000,
  pi: 270_000,
});

/**
 * The wait a delegated task call may use: the requested or default timeout,
 * and on a provider with a call budget, no more than what is left of it since
 * the call began, so the call returns its task handle before the client gives up.
 */
export function delegatedWaitTimeout(requested: number | undefined, providerId: ProviderId, elapsedMs: number): number {
  const timeout = clampDelegatedWaitTimeout(requested);
  const budget = DELEGATED_WAIT_CALL_BUDGET_MS[providerId];
  if (budget === undefined) return timeout;
  return Math.max(1, Math.min(timeout, Math.trunc(budget - Math.max(0, elapsedMs))));
}

/** The longest a wait can last on this provider, for the approval text. */
export function delegatedWaitLimit(requested: number | undefined, providerId: ProviderId): number {
  return delegatedWaitTimeout(requested, providerId, 0);
}

export function delegatedWaitOutcome(view: DelegatedTaskView): Exclude<DelegatedWaitOutcome, "timeout"> | null {
  if (view.status !== "running") return "terminal";
  return view.needsAction ? "needs_action" : null;
}

export class DelegatedTaskSignals {
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get size(): number {
    return this.listeners.size;
  }

  notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { }
    }
  }
}

export async function waitForDelegatedTask(input: {
  read(): DelegatedTaskView;
  subscribe(listener: () => void): () => void;
  timeoutMs: number;
  signal: AbortSignal;
  pollMs?: number;
}): Promise<{ view: DelegatedTaskView; outcome: DelegatedWaitOutcome }> {
  if (input.signal.aborted) throw new DelegatedWaitAbortedError();
  const initial = input.read();
  const immediate = delegatedWaitOutcome(initial);
  if (immediate) return { view: initial, outcome: immediate };
  return await new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      unsubscribe?.();
      input.signal.removeEventListener("abort", abort);
      settle();
    };
    const check = (timedOut: boolean): void => {
      if (done) return;
      try {
        const view = input.read();
        const outcome = delegatedWaitOutcome(view) ?? (timedOut ? "timeout" : null);
        if (outcome) finish(() => resolve({ view, outcome }));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const abort = (): void => finish(() => reject(new DelegatedWaitAbortedError()));
    input.signal.addEventListener("abort", abort, { once: true });
    unsubscribe = input.subscribe(() => check(false));
    timer = setTimeout(() => check(true), input.timeoutMs);
    poll = setInterval(() => check(false), input.pollMs ?? DEFAULT_DELEGATED_WAIT_POLL_MS);
    timer.unref?.();
    poll.unref?.();
  });
}
