export const RUNTIME_SHUTDOWN_DEADLINE_MS = 2_500;

type ShutdownOperation = () => void | Promise<void>;

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
 * server -> store dependency order. A deadline while an operation is still
 * active fails closed so later phases never race it.
 */
export async function runRuntimeShutdownPhases(
  phases: RuntimeShutdownPhases,
  timeoutMs = RUNTIME_SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  const deadlineAt = Date.now() + Math.max(1, Math.trunc(timeoutMs));
  let shutdownError: unknown;
  const attempt = async (operation: ShutdownOperation): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      shutdownError ??= error;
    }
  };
  const drainAgents = async (): Promise<void> => {
    await attempt(phases.stopIsolatedRuns);
    await attempt(phases.disposeTurnsAndProviders);
  };

  try {
    if (phases.quiesceRuntimeWork) {
      await beforeDeadline(
        Promise.resolve().then(phases.quiesceRuntimeWork),
        deadlineAt,
        "runtime command cleanup",
      );
    }
    await beforeDeadline(
      Promise.all([
        ...phases.independentDrains.map(attempt),
        drainAgents(),
      ]).then(() => undefined),
      deadlineAt,
      "owned-resource cleanup",
    );
    for (const [phase, operation] of [
      ["artifact cleanup", phases.settleArtifacts],
      ["client cleanup", phases.terminateClients],
      ["server cleanup", phases.closeServer],
      ["database cleanup", phases.closeStore],
    ] as const) {
      await beforeDeadline(attempt(operation), deadlineAt, phase);
    }
  } catch (error) {
    shutdownError ??= error;
  }
  if (shutdownError !== undefined) throw shutdownError;
}
