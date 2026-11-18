import type {
  AgentHarness,
  AgentHarnessCallbacks,
  AgentHarnessEvent,
  AgentHarnessRun,
  AgentHarnessStartOptions,
} from "./agent-harness";
import {
  providerRunTerminal,
  type ProviderEvent,
  type ProviderFreshSessionFallback,
  type ProviderFreshSessionPrior,
  type ProviderHistoryInjection,
  type ProviderRunFailure,
  type ProviderRunResult,
} from "./contracts";

export const FRESH_SESSION_START_FAILED_MESSAGE = "The fresh provider session could not start.";

export interface HarnessFreshSessionReplacement {
  prompt: string;
  /** The replacement attempt's own event route; defaults to the first attempt's. */
  callbacks?: AgentHarnessCallbacks;
  /** The replacement attempt's own injection authority, already admitted for the run. */
  historyInjection?: ProviderHistoryInjection;
}

/**
 * Adapts the turn's fallback for the wrapper below: when the turn gives the
 * replacement attempt its own event route, `route` builds that attempt's
 * harness callbacks, so each attempt keeps reporting under its own identity.
 */
export function routedFreshSessionFallback(
  fallback: ((prior: ProviderFreshSessionPrior) => ProviderFreshSessionFallback | null) | undefined,
  route: (onEvent: (event: ProviderEvent) => void) => AgentHarnessCallbacks,
  historyInjectionAdmitted: () => boolean = () => false,
): ((prior: ProviderFreshSessionPrior) => HarnessFreshSessionReplacement | null) | undefined {
  return fallback && ((prior) => {
    const replacement = fallback(prior);
    if (!replacement) return null;
    const historyInjection = replacement.historyInjection && historyInjectionAdmitted() ? replacement.historyInjection : undefined;
    return { prompt: replacement.prompt, ...(replacement.onEvent ? { callbacks: route(replacement.onEvent) } : {}),
      ...(historyInjection ? { historyInjection } : {}) };
  });
}

/**
 * The replacement's own failure once the restart committed, never the rejected
 * attempt's result. `start()` returned no run, and every harness sends its
 * prompt only after `start()` returns, so nothing was delivered. Whether a
 * process was left is unknown, so cleanup is not claimed, as the run
 * coordinator treats any throw after a harness start was invoked.
 */
function replacementStartFailed(input: AgentHarnessStartOptions["input"]): ProviderRunResult {
  const failure: ProviderRunFailure = { reason: "provider-error", message: FRESH_SESSION_START_FAILED_MESSAGE,
    notDelivered: true };
  return { ...providerRunTerminal(input, "failed", failure), text: "", textTruncated: false, exitCode: null,
    signal: null, cleanupConfirmed: false, error: FRESH_SESSION_START_FAILED_MESSAGE, failure };
}

function isTerminalStatus(event: AgentHarnessEvent): boolean {
  return event.type === "status"
    && (event.status === "completed" || event.status === "failed" || event.status === "cancelled");
}

export function startHarnessWithFreshSessionFallback(
  harness: AgentHarness,
  options: AgentHarnessStartOptions,
  fallback: ((prior: ProviderFreshSessionPrior) => HarnessFreshSessionReplacement | null) | undefined,
): AgentHarnessRun {
  if (
    !fallback
    || options.input.sessionId === undefined
    || options.input.operation !== undefined
    || options.input.goalStart !== undefined
  ) return harness.start(options);

  const environment = { ...options.environment };
  const release = (): void => {
    for (const key of Object.keys(environment)) delete environment[key];
  };
  const forward = options.callbacks?.onEvent;
  let withheld: AgentHarnessEvent[] | null = [];
  // Set once the fallback has committed the restart: the rejected attempt is
  // superseded, so its late events (capability observations, protocol policy
  // and metadata included) go nowhere.
  let firstSuperseded = false;
  const settleFirstAttempt = (deliver: boolean): void => {
    const events = withheld ?? [];
    withheld = null;
    if (deliver) for (const event of events) forward?.(event);
  };
  const first = harness.start({
    ...options,
    callbacks: {
      onEvent: (event) => {
        if (firstSuperseded) return;
        if (withheld && isTerminalStatus(event)) withheld.push(event);
        else forward?.(event);
      },
    },
  });
  let current = first;
  let cancelled = false;
  const result = first.result.then((
    outcome,
  ): ProviderRunResult | Promise<ProviderRunResult> => {
    const keep = (): ProviderRunResult => {
      release();
      settleFirstAttempt(true);
      return outcome;
    };
    if (
      cancelled
      || outcome.status !== "failed"
      || outcome.failure?.sessionUnavailable !== true
      || !outcome.cleanupConfirmed
    ) return keep();
    let replacement: HarnessFreshSessionReplacement | null;
    try {
      // Checked above: the rejected attempt's process cleanup is confirmed.
      replacement = fallback({ priorCleanup: "confirmed" });
    } catch {
      return keep();
    }
    if (!replacement) return keep();
    // The restart is committed: the turn now belongs to the replacement.
    firstSuperseded = true;
    settleFirstAttempt(false);
    const route = replacement.callbacks?.onEvent ?? forward;
    try {
      const {
        sessionId: _sessionId,
        performanceModeTransition: _performanceModeTransition,
        goalContinuationExpected: _goalContinuationExpected,
        nativeContinuation: _nativeContinuation,
        ...input
      } = options.input;
      // The rejected attempt's injection authority is bound to that attempt; only the replacement's own may be used.
      const { nativeContinuation: _startContinuation, historyInjection: _firstInjection, ...fresh } = options;
      const next = harness.start({
        ...fresh,
        environment,
        ...(replacement.historyInjection ? { historyInjection: replacement.historyInjection } : {}),
        input: { ...input, prompt: replacement.prompt },
        callbacks: {
          onEvent: (event) => {
            if (event.type === "status" && event.status === "starting") return;
            route?.(event);
          },
        },
      });
      current = next;
      if (cancelled) next.cancel(false);
      return next.result;
    } catch {
      release();
      return replacementStartFailed(options.input);
    }
  }, (error: unknown) => {
    release();
    settleFirstAttempt(true);
    throw error;
  });
  return {
    harnessId: first.harnessId,
    providerId: first.providerId,
    result,
    cancel: (force) => {
      cancelled = true;
      current.cancel(force);
    },
    get extension() {
      return current.extension;
    },
  };
}
