import type {
  AgentHarness,
  AgentHarnessEvent,
  AgentHarnessRun,
  AgentHarnessStartOptions,
} from "./agent-harness";
import type {
  ProviderFreshSessionFallback,
  ProviderRunResult,
} from "./contracts";

function isTerminalStatus(event: AgentHarnessEvent): boolean {
  return event.type === "status"
    && (event.status === "completed" || event.status === "failed" || event.status === "cancelled");
}

export function startHarnessWithFreshSessionFallback(
  harness: AgentHarness,
  options: AgentHarnessStartOptions,
  fallback: (() => ProviderFreshSessionFallback | null) | undefined,
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
  const settleFirstAttempt = (deliver: boolean): void => {
    const events = withheld ?? [];
    withheld = null;
    if (deliver) for (const event of events) forward?.(event);
  };
  const first = harness.start({
    ...options,
    callbacks: {
      onEvent: (event) => {
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
    try {
      const replacement = fallback();
      if (!replacement) return keep();
      const {
        sessionId: _sessionId,
        performanceModeTransition: _performanceModeTransition,
        goalContinuationExpected: _goalContinuationExpected,
        ...input
      } = options.input;
      const next = harness.start({
        ...options,
        environment,
        input: { ...input, prompt: replacement.prompt },
        callbacks: {
          onEvent: (event) => {
            if (event.type === "status" && event.status === "starting") return;
            forward?.(event);
          },
        },
      });
      settleFirstAttempt(false);
      current = next;
      if (cancelled) next.cancel(false);
      return next.result;
    } catch {
      return keep();
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
