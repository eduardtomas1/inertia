import { RuntimeGenerationLeaseJournal } from
  "../node/runtime-generation-leases.js";
import { RuntimeOwnedProcessJournal } from
  "../node/runtime-owned-processes.js";
import { RuntimeCleanupReceiptJournal } from "./runtime-cleanup-receipts.js";
import { recoverRuntimeOwnedProcesses } from
  "./runtime-owned-process-recovery.js";
import { forceKillRuntimeProcessTree } from "./runtime-process-tree.js";
import { RuntimeSupervisorRecoveryAdmission } from
  "./runtime-supervisor-recovery-admission.js";
import { RuntimeSupervisorStartupRecovery } from
  "./runtime-supervisor-startup-recovery.js";
import {
  RuntimeProcessContainmentAdmission,
  type RuntimeProcessContainmentAdmissionOptions,
} from
  "./runtime-process-containment-admission.js";
import type {
  RuntimeProcessRecord,
  RuntimeSupervisorOptions,
} from "./runtime-supervisor-types.js";
import { publicProcessError } from "./runtime-supervisor-values.js";
import { armWindowsRuntimeJob } from "./windows-runtime-job.js";

export function createRuntimeSupervisorProcessSafety(options: {
  readonly configuration: RuntimeSupervisorOptions;
  readonly systemBootId: string;
  readonly forceKillWaitMs: number;
  readonly leases: RuntimeGenerationLeaseJournal;
  readonly ownedProcesses: RuntimeOwnedProcessJournal;
  readonly receipts: RuntimeCleanupReceiptJournal;
  readonly manualModernRecovery?: RuntimeSupervisorOptions["workerOptions"][
    "manualModernDarwinRecovery"
  ];
}) {
  const configuration = options.configuration;
  const guardianPath = configuration.workerOptions.runtimeProcessGuardianPath;
  const forceKill = configuration.forceKill
    ?? ((pid: number, deadlineAt: number) =>
      forceKillRuntimeProcessTree(pid, { deadlineAt }));
  const recoverOwnedProcesses = configuration.recoverOwnedProcesses
    ?? ((runtimeGenerationId: string, systemBootId: string, deadlineAt: number) =>
      recoverRuntimeOwnedProcesses(
        configuration.workerOptions.dataDirectory,
        runtimeGenerationId,
        systemBootId,
        {
          deadlineAt,
          ...(guardianPath ? { darwinGuardianPath: guardianPath } : {}),
        },
      ));
  const armProcessContainment = configuration.armProcessContainment
    ?? (process.platform === "win32"
      ? ((runtimeGenerationId: string, runtimePid: number) =>
          armWindowsRuntimeJob(runtimeGenerationId, runtimePid))
      : (() => null));
  return {
    forceKill,
    recoverOwnedProcesses,
    armProcessContainment,
    recoveryAdmission: new RuntimeSupervisorRecoveryAdmission({
      dataDirectory: configuration.workerOptions.dataDirectory,
      systemBootId: options.systemBootId,
      leases: options.leases,
      ownedProcesses: options.ownedProcesses,
      ...(guardianPath ? { guardianPath } : {}),
      ...(options.manualModernRecovery
        ? { manualModernRecovery: options.manualModernRecovery }
        : {}),
    }),
    startupRecovery: new RuntimeSupervisorStartupRecovery({
      dataDirectory: configuration.workerOptions.dataDirectory,
      systemBootId: options.systemBootId,
      forceKillWaitMs: options.forceKillWaitMs,
      leases: options.leases,
      receipts: options.receipts,
      ...(guardianPath ? { darwinGuardianPath: guardianPath } : {}),
    }),
  };
}

export function createRuntimeProcessContainmentAdmission(options: {
  readonly arm: NonNullable<RuntimeSupervisorOptions["armProcessContainment"]>;
  readonly systemBootId: string;
  readonly workerOptions: RuntimeSupervisorOptions["workerOptions"];
  readonly isCurrent: (record: RuntimeProcessRecord) => boolean;
  readonly isRunningDesired: () => boolean;
  readonly hasQuarantinedProcesses: () => boolean;
  readonly persist: RuntimeProcessContainmentAdmissionOptions["persist"];
  readonly post: RuntimeProcessContainmentAdmissionOptions["post"];
  readonly reject: (record: RuntimeProcessRecord, message: string) => void;
}) {
  return new RuntimeProcessContainmentAdmission({
    ...options,
    reject: (record, error) => options.reject(record, publicProcessError(
      error, "The runtime process containment could not be armed.",
    )),
  });
}
