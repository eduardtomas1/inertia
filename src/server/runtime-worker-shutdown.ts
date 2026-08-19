import type { RuntimeWorkerEvent } from "../node/runtime-process-protocol.js";
import type { RunningRuntime } from "./index.js";

interface RuntimeWorkerShutdownOptions {
  runtime: RunningRuntime | null;
  cause: "runtime-shutdown" | "runtime-crash";
  exitCode: number;
  closeBrokers: () => void;
  ownedProcessCleanupConfirmed?: () => boolean;
  post: (event: RuntimeWorkerEvent) => void;
  exit: (code: number) => void;
}

/**
 * A failed runtime close means owned process cleanup was not confirmed. Keep
 * the utility process alive so its supervisor can still discover and
 * terminate the complete descendant tree.
 */
export async function completeRuntimeWorkerShutdown(
  options: RuntimeWorkerShutdownOptions,
): Promise<void> {
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
      shutdownConfirmed = options.ownedProcessCleanupConfirmed?.() ?? true;
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
