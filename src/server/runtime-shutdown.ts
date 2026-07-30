export const RUNTIME_SHUTDOWN_DEADLINE_MS = 2_500;

type ShutdownOperation = () => void | Promise<void>;

export interface RuntimeShutdownPhases {
  independentDrains: readonly ShutdownOperation[];
  stopIsolatedRuns: ShutdownOperation;
  disposeTurnsAndProviders: ShutdownOperation;
  settleArtifacts: ShutdownOperation;
  terminateClients: ShutdownOperation;
  closeServer: ShutdownOperation;
  closeStore: ShutdownOperation;
}

export class RuntimeShutdownDeadlineError extends Error {
  constructor() {
    super("The runtime did not finish cleanup before its shutdown deadline.");
    this.name = "RuntimeShutdownDeadlineError";
  }
}

async function beforeDeadline(
  operation: Promise<void>,
  deadlineAt: number,
): Promise<void> {
  const remainingMs = Math.trunc(deadlineAt - Date.now());
  if (remainingMs <= 0) throw new RuntimeShutdownDeadlineError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RuntimeShutdownDeadlineError()),
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
    if (Date.now() >= deadlineAt) throw new RuntimeShutdownDeadlineError();
    await attempt(phases.disposeTurnsAndProviders);
  };

  try {
    await beforeDeadline(
      Promise.all([
        ...phases.independentDrains.map(attempt),
        drainAgents(),
      ]).then(() => undefined),
      deadlineAt,
    );
    for (const operation of [
      phases.settleArtifacts,
      phases.terminateClients,
      phases.closeServer,
      phases.closeStore,
    ]) {
      await beforeDeadline(attempt(operation), deadlineAt);
    }
  } catch (error) {
    shutdownError ??= error;
  }
  if (shutdownError !== undefined) throw shutdownError;
}
