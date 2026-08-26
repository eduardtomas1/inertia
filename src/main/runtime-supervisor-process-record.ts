import type { RuntimeProcessRecord } from "./runtime-supervisor-types.js";

export function createRuntimeProcessRecord(options: {
  child: RuntimeProcessRecord["child"];
  generation: number;
  runtimeGenerationId: string;
  cleanupReceiptIds: readonly string[];
}): RuntimeProcessRecord {
  return {
    child: options.child,
    generation: options.generation,
    runtimeGenerationId: options.runtimeGenerationId,
    cleanupReceiptIds: new Set(options.cleanupReceiptIds),
    ready: false,
    acceptingReady: true,
    cleanupConfirmed: false,
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
