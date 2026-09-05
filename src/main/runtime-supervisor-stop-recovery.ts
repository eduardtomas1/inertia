import type { RuntimeProcessRecord, RuntimeSupervisorOptions } from
  "./runtime-supervisor-types.js";
import { persistRuntimeGenerationCleanup } from "./runtime-generation-cleanup.js";
import type { RuntimeCleanupReceiptJournal } from "./runtime-cleanup-receipts.js";
import type { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import type { RuntimeOwnedProcessJournal } from "../node/runtime-owned-processes.js";

export interface RuntimeStopAttemptState {
  promise: Promise<boolean> | null;
  retryEligible: boolean;
  readonly retryEnabled: boolean;
}

export function runtimeStopAttemptState(
  retryEnabled: boolean,
): RuntimeStopAttemptState {
  return { promise: null, retryEligible: false, retryEnabled };
}

export function trackRuntimeStopAttempt(
  state: RuntimeStopAttemptState,
  attempt: Promise<boolean>,
): Promise<boolean> {
  const reset = (): void => {
    if (state.retryEnabled && state.promise === tracked) {
      state.retryEligible = true;
      state.promise = null;
    }
  };
  const tracked = attempt.then((confirmed) => {
    if (!confirmed) reset();
    return confirmed;
  }, (error: unknown) => {
    reset();
    throw error;
  });
  state.promise = tracked;
  return tracked;
}

export async function reconcileStoppedRuntimeQuarantine(options: {
  readonly enabled: boolean;
  readonly records: Set<RuntimeProcessRecord>;
  readonly drain: (record: RuntimeProcessRecord) => Promise<boolean>;
  readonly recoverOwnedProcesses: NonNullable<
    RuntimeSupervisorOptions["recoverOwnedProcesses"]
  >;
  readonly systemBootId: string;
  readonly recoveryWaitMs: number;
  readonly cleanupReceipts: RuntimeCleanupReceiptJournal;
  readonly runtimeGenerationLeases: RuntimeGenerationLeaseJournal;
  readonly runtimeOwnedProcesses: RuntimeOwnedProcessJournal;
  readonly onPersistenceFailure: () => void;
  readonly clear: (record: RuntimeProcessRecord) => void;
}): Promise<boolean> {
  if (!options.enabled) return false;
  for (const record of options.records) {
    if (!await options.drain(record)) return false;
    if (record.processTreeTermination && !record.processTreeTerminationSettled) {
      return false;
    }
    if (!record.cleanupConfirmed || !record.processTreeTerminationConfirmed) {
      let recovery: boolean | Promise<boolean> | null;
      try {
        recovery = options.recoverOwnedProcesses(
          record.runtimeGenerationId,
          options.systemBootId,
          Date.now() + options.recoveryWaitMs,
        );
      } catch {
        return false;
      }
      const confirmed = typeof recovery === "boolean"
        ? recovery
        : recovery
          ? await recovery.catch(() => false)
          : false;
      if (!confirmed) return false;
      record.cleanupConfirmed = true;
      record.cleanupRecoveryRequired = false;
      record.processTreeTerminationConfirmed = true;
      record.processTreeTerminationSettled = true;
    }
    if (!persistRuntimeGenerationCleanup(
      record,
      options.cleanupReceipts,
      options.runtimeGenerationLeases,
      options.runtimeOwnedProcesses,
    )) {
      options.onPersistenceFailure();
      return false;
    }
    options.clear(record);
    options.records.delete(record);
  }
  return options.records.size === 0;
}
