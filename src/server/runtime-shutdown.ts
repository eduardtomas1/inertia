import { runtimeShutdownDeadlineMs } from "../node/runtime-shutdown-deadline.js";

export const RUNTIME_SHUTDOWN_DEADLINE_MS = runtimeShutdownDeadlineMs();

export interface RuntimeShutdownContext {
  readonly deadlineAt: number;
}

type ShutdownOperation = (
  context: RuntimeShutdownContext,
) => void | Promise<void>;

export interface RuntimeShutdownPhases {
  /** Stops command admission and drains work that could create new owned resources. */
  quiesceRuntimeWork?: ShutdownOperation;
  independentDrains: readonly ShutdownOperation[];
  stopIsolatedRuns: ShutdownOperation;
  disposeTurnsAndProviders: ShutdownOperation;
  settleArtifacts: ShutdownOperation;
  terminateClients: ShutdownOperation;
  closeServer: ShutdownOperation;
  closeStore: ShutdownOperation;
}

export class RuntimeShutdownDeadlineError extends Error {
  constructor(readonly phase: string = "cleanup") {
    super(
      `The runtime did not finish ${phase} before its shutdown deadline.`,
    );
    this.name = "RuntimeShutdownDeadlineError";
  }
}

async function beforeDeadline(
  operation: Promise<void>,
  deadlineAt: number,
  phase: string,
): Promise<void> {
  type Settlement =
    | { kind: "pending" }
    | { kind: "resolved" }
    | { kind: "rejected"; error: unknown };
  const settlement: { current: Settlement } = {
    current: { kind: "pending" },
  };
  const observedSettlement = (): Settlement => settlement.current;
  void operation.then(
    () => { settlement.current = { kind: "resolved" }; },
    (error: unknown) => {
      settlement.current = { kind: "rejected", error };
    },
  );

  // Observe already-settled work before consulting wall time. Under heavy
  // host contention, the event loop can resume after the nominal deadline
  // even though the owned operation completed and no unsafe work remains.
  await Promise.resolve();
  const immediate = observedSettlement();
  if (immediate.kind === "resolved") return;
  if (immediate.kind === "rejected") throw immediate.error;

  const remainingMs = Math.trunc(deadlineAt - Date.now());
  if (remainingMs <= 0) {
    // Give completion callbacks that became runnable in the same delayed loop
    // one turn to settle. A genuinely active operation still fails closed.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const delayed = observedSettlement();
    if (delayed.kind === "resolved") return;
    if (delayed.kind === "rejected") throw delayed.error;
    throw new RuntimeShutdownDeadlineError(phase);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RuntimeShutdownDeadlineError(phase)),
      remainingMs,
    );
    timer.unref();
    void operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Drains independent owned resources alongside the ordered isolated-run ->
 * turn/provider teardown, then preserves the strict artifact -> clients ->
 * server -> store dependency order. Command quiescence gets an initial bounded
 * wait before cancellation drains start; artifact/store work still requires
 * both commands and owned-resource drains to finish.
 */
export async function runRuntimeShutdownPhases(
  phases: RuntimeShutdownPhases,
  timeoutMs = RUNTIME_SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  const startedAt = Date.now();
  const budgetMs = Math.max(1, Math.trunc(timeoutMs));
  const deadlineAt = startedAt + budgetMs;
  const context: RuntimeShutdownContext = { deadlineAt };
  let shutdownError: unknown;
  let hasShutdownError = false;
  const recordError = (error: unknown): void => {
    if (hasShutdownError) return;
    hasShutdownError = true;
    shutdownError = error;
  };
  let ownedResourceCleanupConfirmed = true;
  const attempt = async (
    operation: ShutdownOperation,
    ownsRuntimeResource = false,
  ): Promise<void> => {
    try {
      await operation(context);
    } catch (error) {
      if (ownsRuntimeResource) ownedResourceCleanupConfirmed = false;
      recordError(error);
    }
  };
  const drainAgents = async (): Promise<void> => {
    await attempt(phases.stopIsolatedRuns, true);
    await attempt(phases.disposeTurnsAndProviders, true);
  };

  const quiescence = phases.quiesceRuntimeWork
    ? Promise.resolve().then(() => phases.quiesceRuntimeWork!(context))
    : Promise.resolve();
  if (phases.quiesceRuntimeWork) {
    try {
      // Preserve the established 2.5-second command allowance on desktop
      // platforms, leaving time for cancellation within the same total budget.
      await beforeDeadline(
        quiescence,
        startedAt + Math.min(2_500, Math.max(1, Math.trunc(budgetMs / 3))),
        "runtime command cleanup",
      );
    } catch (error) {
      // Expiring this initial wait starts cancellation, not an unconfirmed
      // final outcome. The complete command promise is checked again below
      // against the original deadline; a real rejection remains a failure.
      if (!(error instanceof RuntimeShutdownDeadlineError)) recordError(error);
    }
  }
  try {
    await beforeDeadline(
      Promise.all([
        ...phases.independentDrains.map((operation) => attempt(operation, true)),
        drainAgents(),
      ]).then(() => undefined),
      deadlineAt,
      "owned-resource cleanup",
    );
    // Cancellation may release the admitted command. A timeout/rejection still
    // retains its database and artifact authority; never close underneath it.
    await beforeDeadline(quiescence, deadlineAt, "runtime command cleanup");
    await beforeDeadline(
      attempt(phases.settleArtifacts, true),
      deadlineAt,
      "artifact cleanup",
    );
    for (const [phase, operation] of [
      ["client cleanup", phases.terminateClients],
      ["server cleanup", phases.closeServer],
    ] as const) {
      await beforeDeadline(attempt(operation), deadlineAt, phase);
    }
    if (ownedResourceCleanupConfirmed) {
      await beforeDeadline(attempt(phases.closeStore), deadlineAt, "database cleanup");
    }
  } catch (error) {
    recordError(error);
  }
  if (hasShutdownError) throw shutdownError;
}
