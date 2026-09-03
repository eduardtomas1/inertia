import type { RuntimeWorkerEvent } from "../node/runtime-process-protocol.js";
import type { RuntimeShutdownUnconfirmedReason } from
  "../node/runtime-process-protocol.js";
import type { RunningRuntime } from "./index.js";
import { isGitProcessTreeTerminationFailure } from "./git/runner.js";
import { RUNTIME_SHUTDOWN_DEADLINE_MS } from "./runtime-shutdown.js";

interface RuntimeWorkerShutdownOptions {
  runtime: RunningRuntime | null;
  cause: "runtime-shutdown" | "runtime-crash";
  exitCode: number;
  closeBrokers: () => void;
  ownedProcessCleanupConfirmed?: () => boolean | Promise<boolean>;
  noRuntimeCleanupProof?: {
    readonly kind: "pre-registry-no-runtime";
  };
  post: (event: RuntimeWorkerEvent) => void;
  awaitStoppedAcknowledgement: () => Promise<void>;
  exit: (code: number) => void;
}

async function cleanupConfirmedBefore(
  confirmation: Promise<boolean>,
  deadlineAt: number,
): Promise<boolean> {
  type Settlement =
    | { kind: "pending" }
    | { kind: "resolved"; confirmed: boolean }
    | { kind: "rejected"; error: unknown };
  const settlement: { current: Settlement } = {
    current: { kind: "pending" },
  };
  void confirmation.then(
    (confirmed) => {
      settlement.current = { kind: "resolved", confirmed };
    },
    (error: unknown) => {
      settlement.current = { kind: "rejected", error };
    },
  );
  const observed = (): boolean | null => {
    if (settlement.current.kind === "resolved") {
      return settlement.current.confirmed;
    }
    if (settlement.current.kind === "rejected") throw settlement.current.error;
    return null;
  };

  // runtime.close() owns its own bounded shutdown phases and can safely use
  // the whole shared budget. Observe a cleanup check that has already settled
  // before treating an exhausted wall-clock budget as unconfirmed.
  await Promise.resolve();
  const immediate = observed();
  if (immediate !== null) return immediate;

  const remainingMs = Math.trunc(deadlineAt - Date.now());
  if (remainingMs <= 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return observed() ?? false;
  }
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
  // A failed/partial startup after ownership activation has no returned
  // runtime whose full owner set can be drained. Only the explicit
  // pre-registry path can prove that no runtime cleanup is required.
  const preRegistryNoRuntime = options.runtime === null
    && options.noRuntimeCleanupProof?.kind === "pre-registry-no-runtime";
  let shutdownConfirmed = options.runtime !== null || preRegistryNoRuntime;
  let unconfirmedReason: RuntimeShutdownUnconfirmedReason =
    "incomplete-startup";
  try {
    await options.runtime?.close(options.cause);
  } catch (error) {
    shutdownConfirmed = false;
    unconfirmedReason = isGitProcessTreeTerminationFailure(error)
      ? "owned-process-cleanup"
      : error instanceof Error
        && /shutdown deadline|before its shutdown deadline/iu.test(error.message)
        ? "runtime-close-deadline"
        : "runtime-close";
  }
  options.closeBrokers();
  if (shutdownConfirmed && !preRegistryNoRuntime) {
    try {
      const confirmation = options.ownedProcessCleanupConfirmed?.() ?? true;
      if (typeof confirmation === "boolean") shutdownConfirmed = confirmation;
      else shutdownConfirmed = await cleanupConfirmedBefore(
        confirmation,
        deadlineAt,
      );
      if (!shutdownConfirmed) unconfirmedReason = "owned-process-cleanup";
    } catch {
      shutdownConfirmed = false;
      unconfirmedReason = "owned-process-cleanup";
    }
  }
  if (!shutdownConfirmed) {
    options.post({
      type: "runtime.shutdown-unconfirmed",
      reason: unconfirmedReason,
    });
    return;
  }
  options.post({ type: "runtime.stopped" });
  await options.awaitStoppedAcknowledgement();
  options.exit(options.exitCode);
}
