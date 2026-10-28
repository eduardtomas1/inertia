import type { RuntimeProcessRecord, RuntimeSupervisorOptions } from
  "./runtime-supervisor-types.js";
import { persistRuntimeGenerationCleanup } from "./runtime-generation-cleanup.js";
import type { RuntimeCleanupReceiptJournal } from "./runtime-cleanup-receipts.js";
import type { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import type { RuntimeOwnedProcessJournal } from "../node/runtime-owned-processes.js";
import type { RuntimeWorkerOptions } from "../node/runtime-process-protocol.js";

export interface RuntimeStopAttemptState {
  promise: Promise<boolean> | null;
  retryEligible: boolean;
}

export function runtimeStopAttemptState(): RuntimeStopAttemptState {
  return { promise: null, retryEligible: false };
}

export function trackRuntimeStopAttempt(
  state: RuntimeStopAttemptState,
  attempt: Promise<boolean>,
): Promise<boolean> {
  const reset = (): void => {
    if (state.promise === tracked) {
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

export type RuntimePriorCleanupEvidence = Pick<RuntimeWorkerOptions,
  "priorRuntimeCleanupUnconfirmed" | "exitedUnconfirmedRuntimeGenerationIds">;

const MAX_EXITED_UNCONFIRMED_GENERATIONS = 32;

export function runtimePriorCleanupEvidence(
  records: Iterable<RuntimeProcessRecord>,
): RuntimePriorCleanupEvidence {
  const quarantined = [...records];
  const exited = quarantined
    .filter((record) => record.exited && !record.utilityCleanupUnconfirmed)
    .map(({ runtimeGenerationId }) => runtimeGenerationId);
  const named = exited.length <= MAX_EXITED_UNCONFIRMED_GENERATIONS;
  return {
    ...(!named || exited.length < quarantined.length
      ? { priorRuntimeCleanupUnconfirmed: true as const }
      : {}),
    ...(named && exited.length > 0
      ? { exitedUnconfirmedRuntimeGenerationIds: exited }
      : {}),
  };
}

export interface RuntimeQuarantineReconciliationOptions {
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
}

export class RuntimeQuarantineReconciliation {
  private active: Promise<boolean> | null = null;

  constructor(private readonly options: RuntimeQuarantineReconciliationOptions) {}

  reconcile(): Promise<boolean> {
    if (this.active) return this.active;
    if (this.options.records.size === 0) return Promise.resolve(true);
    const active = reconcileStoppedRuntimeQuarantine(this.options)
      .catch(() => false);
    this.active = active;
    void active.then(() => {
      if (this.active === active) this.active = null;
    });
    return active;
  }
}

export async function reconcileStoppedRuntimeQuarantine(
  options: RuntimeQuarantineReconciliationOptions,
): Promise<boolean> {
  for (const record of options.records) {
    if (await reconcileQuarantinedRecord(options, record)) {
      options.clear(record);
      options.records.delete(record);
    }
  }
  return options.records.size === 0;
}

async function reconcileQuarantinedRecord(
  options: RuntimeQuarantineReconciliationOptions,
  record: RuntimeProcessRecord,
): Promise<boolean> {
  if (!await options.drain(record)) return false;
  record.utilityCleanupUnconfirmed = false;
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
  if (persistRuntimeGenerationCleanup(
    record,
    options.cleanupReceipts,
    options.runtimeGenerationLeases,
    options.runtimeOwnedProcesses,
  )) return true;
  options.onPersistenceFailure();
  return false;
}
