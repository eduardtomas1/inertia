import type {
  RuntimeProcessRecord,
  RuntimeSupervisorOptions,
} from "./runtime-supervisor-types.js";

interface PendingRuntimeRecordRequest {
  record: RuntimeProcessRecord;
}

export function drainRuntimeRecordRequests<
  Request extends PendingRuntimeRecordRequest,
>(
  requests: Map<string, Request>,
  record: RuntimeProcessRecord | null,
  drain: (request: Request) => void,
): void {
  if (!record) return;
  for (const [requestId, request] of requests) {
    if (request.record !== record) continue;
    requests.delete(requestId);
    drain(request);
  }
}

export type RuntimeCleanupRecoveryOutcome = "recovered" | "blocked";

export function recoverUnconfirmedRuntimeCleanup(options: {
  record: RuntimeProcessRecord;
  recoverOwnedProcesses: NonNullable<RuntimeSupervisorOptions["recoverOwnedProcesses"]>;
  systemBootId: string;
  deadlineAt: number;
  isCurrent: () => boolean;
  onSettled: (outcome: RuntimeCleanupRecoveryOutcome) => void;
}): void {
  const finish = (recovered: boolean): void => {
    if (!options.isCurrent()) return;
    if (recovered) {
      options.record.cleanupConfirmed = true;
      options.record.cleanupRecoveryRequired = false;
      options.onSettled("recovered");
      return;
    }
    options.onSettled("blocked");
  };
  let recovery: boolean | Promise<boolean> | null;
  try {
    recovery = options.recoverOwnedProcesses(
      options.record.runtimeGenerationId,
      options.systemBootId,
      options.deadlineAt,
    );
  } catch {
    finish(false);
    return;
  }
  if (typeof recovery === "boolean") finish(recovery);
  else if (recovery) void recovery.catch(() => false).then(finish);
  else finish(false);
}

export function createRuntimeProcessRecord(options: {
  child: RuntimeProcessRecord["child"];
  generation: number;
  runtimeGenerationId: string;
  cleanupReceiptIds: readonly string[];
  legacyRecoveryAuthorityIds?: readonly string[];
  modernDarwinRecoveryAuthority?: RuntimeProcessRecord[
    "modernDarwinRecoveryAuthority"
  ];
}): RuntimeProcessRecord {
  const legacyRecoveryAuthorityBatchIds = [
    ...(options.legacyRecoveryAuthorityIds ?? []),
  ];
  return {
    child: options.child,
    generation: options.generation,
    runtimeGenerationId: options.runtimeGenerationId,
    cleanupReceiptIds: new Set(options.cleanupReceiptIds),
    legacyRecoveryAuthorityIds: new Set(legacyRecoveryAuthorityBatchIds),
    legacyRecoveryAuthorityBatchIds,
    modernDarwinRecoveryAuthority:
      options.modernDarwinRecoveryAuthority ?? null,
    ready: false,
    acceptingReady: true,
    cleanupConfirmed: false,
    cleanupRecoveryRequired: false,
    generationCleanupConfirmed: false,
    processTreeTerminationConfirmed: true,
    processTreeTermination: null,
    processTreeTerminationSettled: false,
    shutdownDeadlineAt: null,
    reportedFailure: null,
    credentialRequestIds: new Set(),
    secureFileRequestIds: new Set(),
    agentBrowserRequestIds: new Set(),
    attachmentRequestIds: new Set(),
    attachmentClaimCounts: new Map(),
    deferredAttachmentReleaseIds: new Set(),
    deletingAttachmentIds: new Set(),
    attachmentOperationTails: new Map(),
  };
}
