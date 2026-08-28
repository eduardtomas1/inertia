import type { RuntimeOwnedProcessContainment } from "../node/runtime-owned-processes.js";
import type { RuntimeWorkerCommand } from "../node/runtime-process-protocol.js";
import type {
  RuntimeProcessRecord,
  RuntimeSupervisorOptions,
} from "./runtime-supervisor-types.js";

export interface RuntimeProcessContainmentAdmissionOptions {
  readonly arm: NonNullable<RuntimeSupervisorOptions["armProcessContainment"]>;
  readonly systemBootId: string;
  readonly workerOptions: RuntimeSupervisorOptions["workerOptions"];
  readonly isCurrent: (record: RuntimeProcessRecord) => boolean;
  readonly isRunningDesired: () => boolean;
  readonly hasQuarantinedProcesses: () => boolean;
  readonly persist: (
    record: RuntimeProcessRecord,
    containment: RuntimeOwnedProcessContainment,
  ) => boolean;
  readonly post: (
    record: RuntimeProcessRecord,
    command: RuntimeWorkerCommand,
  ) => boolean;
  readonly onStartPosted: (record: RuntimeProcessRecord) => void;
  readonly reject: (record: RuntimeProcessRecord, error: unknown) => void;
}

export class RuntimeProcessContainmentAdmission {
  constructor(private readonly options: RuntimeProcessContainmentAdmissionOptions) {}

  bind(record: RuntimeProcessRecord): void {
    record.child.once("spawn", () => this.spawned(record));
  }

  private spawned(record: RuntimeProcessRecord): void {
    if (!this.options.isCurrent(record)) return;
    if (!this.options.isRunningDesired()) {
      this.options.post(record, { type: "runtime.shutdown" });
      return;
    }
    const runtimePid = record.child.pid;
    if (!Number.isSafeInteger(runtimePid) || Number(runtimePid) <= 1) {
      this.options.reject(
        record,
        new Error("The runtime process identity is unavailable."),
      );
      return;
    }
    const isAdmissionCurrent = (): boolean =>
      this.options.isCurrent(record)
      && this.options.isRunningDesired()
      && record.child.pid === runtimePid;
    try {
      const armed = this.options.arm(record.runtimeGenerationId, runtimePid!, {
        isCurrent: isAdmissionCurrent,
      });
      if (armed instanceof Promise) {
        void armed.then((containment) => {
          if (!isAdmissionCurrent()) return;
          this.admit(record, containment);
        })
          .catch((error: unknown) => {
            if (!isAdmissionCurrent()) return;
            this.options.reject(record, error);
          });
      } else {
        if (!isAdmissionCurrent()) return;
        this.admit(record, armed);
      }
    } catch (error) {
      this.options.reject(record, error);
    }
  }

  private admit(
    record: RuntimeProcessRecord,
    containment: RuntimeOwnedProcessContainment | null,
  ): void {
    if (
      !this.options.isCurrent(record)
      || !this.options.isRunningDesired()
    ) return;
    if (containment && !this.options.persist(record, containment)) {
      throw new Error("The runtime process containment could not be persisted.");
    }
    if (process.platform === "win32" && !containment) {
      throw new Error("The Windows runtime Job Object is unavailable.");
    }
    const posted = this.options.post(record, {
      type: "runtime.start",
      options: {
        ...this.options.workerOptions,
        runtimeGenerationId: record.runtimeGenerationId,
        systemBootId: this.options.systemBootId,
        ...(record.cleanupReceiptIds.size > 0
          ? {
              confirmedTerminatedRuntimeGenerationIds:
                [...record.cleanupReceiptIds],
            }
          : {}),
        ...(record.legacyRecoveryAuthorityIds.size > 0
          ? {
              manuallyRetiredRuntimeGenerationIds:
                [...record.legacyRecoveryAuthorityIds],
            }
          : {}),
        ...(record.modernDarwinRecoveryAuthority
          ? {
              manualModernDarwinRecovery:
                record.modernDarwinRecoveryAuthority,
            }
          : {}),
        ...(this.options.hasQuarantinedProcesses()
          ? { priorRuntimeCleanupUnconfirmed: true }
          : {}),
      },
    });
    // Containment has its own bounded admission window. Worker readiness begins
    // only after the ownership record is durable and runtime.start was posted.
    if (posted) this.options.onStartPosted(record);
  }
}
