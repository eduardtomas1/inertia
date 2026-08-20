import type { RuntimeWorkerEvent } from "../node/runtime-process-protocol.js";
import type { RunningRuntime } from "./index.js";
import { RUNTIME_SHUTDOWN_DEADLINE_MS } from "./runtime-shutdown.js";

interface RuntimeWorkerShutdownOptions {
  runtime: RunningRuntime | null;
  cause: "runtime-shutdown" | "runtime-crash";
  exitCode: number;
  closeBrokers: () => void;
  ownedProcessCleanupConfirmed?: () => boolean | Promise<boolean>;
  post: (event: RuntimeWorkerEvent) => void;
  exit: (code: number) => void;
}

async function cleanupConfirmedBefore(
  confirmation: Promise<boolean>,
  deadlineAt: number,
): Promise<boolean> {
  const remainingMs = Math.trunc(deadlineAt - Date.now());
  if (remainingMs <= 0) return false;
  return await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), remainingMs);
    timer.unref();
    void confirmation.then(
      (confirmed) => {
        clearTimeout(timer);
        resolve(confirmed);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A failed runtime close means owned process cleanup was not confirmed. Keep
 * the utility process alive so its supervisor can still discover and
 * terminate the complete descendant tree.
 */
export async function completeRuntimeWorkerShutdown(
  options: RuntimeWorkerShutdownOptions,
): Promise<void> {
  const deadlineAt = Date.now() + RUNTIME_SHUTDOWN_DEADLINE_MS;
  // A failed/partial startup has no returned runtime whose full owner set can
  // be drained. Treat it as unconfirmed even when the visible start promise
  // rejected before the supervisor observed a child.
  let shutdownConfirmed = options.runtime !== null;
  try {
    await options.runtime?.close(options.cause);
  } catch {
    shutdownConfirmed = false;
  }
  options.closeBrokers();
  if (shutdownConfirmed) {
    try {
      const confirmation = options.ownedProcessCleanupConfirmed?.() ?? true;
      if (typeof confirmation === "boolean") shutdownConfirmed = confirmation;
      else shutdownConfirmed = await cleanupConfirmedBefore(
        confirmation,
        deadlineAt,
      );
    } catch {
      shutdownConfirmed = false;
    }
  }
  if (!shutdownConfirmed) {
    options.post({ type: "runtime.shutdown-unconfirmed" });
    return;
  }
  options.post({ type: "runtime.stopped" });
  options.exit(options.exitCode);
}
