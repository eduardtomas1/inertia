import type { UtilityProcess } from "electron";

import type { BackendCredentialStatus } from "../shared/backend-credentials";
import type { PrivateConnectRuntimeResponse } from "../shared/private-connect/runtime-contract";
import type {
  RuntimeDatabaseRecoveryOperation,
  RuntimeDatabaseRecoverySummary,
  RuntimeDatabaseStartupRecoveryReport,
  RuntimeCredentialOperation,
  RuntimeWorkerOptions,
} from "../node/runtime-process-protocol.js";
import type {
  RuntimeOwnedProcessContainment,
} from "../node/runtime-owned-processes.js";
import type {
  ModernDarwinRecoveryAuthorityDescriptor,
} from "../node/runtime-modern-recovery-authorities.js";
import type { SecureFileRequest, SecureFileResult } from "../node/secure-file-protocol.js";
import type {
  AgentBrowserCommand,
  AgentBrowserResult,
  AgentBrowserRunIdentity,
} from "../shared/agent-browser.js";
import type { RuntimeAttachmentBroker } from "./runtime-attachment-broker.js";
import type {
  ConversationAttachmentStoreAnyOperationRunner,
  ConversationAttachmentStoreAuthority,
} from "../node/conversation-attachment-store-child.js";

export type RuntimeSupervisorTimer = ReturnType<typeof setTimeout>;

export interface RuntimeProcessRecord {
  child: UtilityProcess;
  generation: number;
  runtimeGenerationId: string;
  cleanupReceiptIds: Set<string>;
  legacyRecoveryAuthorityIds: Set<string>;
  modernDarwinRecoveryAuthority:
    ModernDarwinRecoveryAuthorityDescriptor | null;
  ready: boolean;
  acceptingReady: boolean;
  cleanupConfirmed: boolean;
  generationCleanupConfirmed: boolean;
  processTreeTerminationConfirmed: boolean;
  processTreeTermination: Promise<boolean> | null;
  processTreeTerminationSettled: boolean;
  shutdownDeadlineAt: number | null;
  reportedFailure: string | null;
  credentialRequestIds: Set<string>;
  secureFileRequestIds: Set<string>;
  agentBrowserRequestIds: Set<string>;
  attachmentRequestIds: Set<string>;
  attachmentClaimCounts: Map<string, number>;
  deferredAttachmentReleaseIds: Set<string>;
  deletingAttachmentIds: Set<string>;
  attachmentOperationTails: Map<string, Promise<void>>;
}

export interface PendingProjectPath {
  record: RuntimeProcessRecord;
  timer: RuntimeSupervisorTimer;
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

export interface PendingCredentialRequest {
  record: RuntimeProcessRecord;
  operation: RuntimeCredentialOperation;
  timer: RuntimeSupervisorTimer;
  controller: AbortController;
}

export interface PendingPrivateConnectRuntimeRequest {
  record: RuntimeProcessRecord;
  timer: RuntimeSupervisorTimer;
  resolve: (response: PrivateConnectRuntimeResponse) => void;
  reject: (error: Error) => void;
}

export interface PendingDatabaseRecoveryRequest {
  record: RuntimeProcessRecord;
  operation: RuntimeDatabaseRecoveryOperation;
  timer: RuntimeSupervisorTimer;
  timedOut: boolean;
  resolve: (summary: RuntimeDatabaseRecoverySummary | null) => void;
  reject: (error: Error) => void;
}

export interface PendingSecureFileRequest {
  record: RuntimeProcessRecord;
  controller: AbortController;
}

export interface RuntimeCredentialBroker {
  resolve(secretReference: string, signal?: AbortSignal): Promise<string | null>;
  status(secretReference: string, signal?: AbortSignal): Promise<BackendCredentialStatus>;
  clear(secretReference: string, signal?: AbortSignal): Promise<boolean>;
  forget(secretReference: string, signal?: AbortSignal): Promise<boolean>;
}

export interface RuntimeSecureFileBroker {
  perform(request: SecureFileRequest, signal?: AbortSignal): Promise<SecureFileResult>;
  shutdown?(): Promise<boolean>;
}

export interface RuntimeAgentBrowserBroker {
  perform(
    identity: AgentBrowserRunIdentity,
    command: AgentBrowserCommand,
    signal?: AbortSignal,
  ): Promise<AgentBrowserResult>;
}

export type RuntimeSupervisorPhase =
  | "idle"
  | "starting"
  | "ready"
  | "restarting"
  | "stopping"
  | "stopped";

export interface RuntimeSupervisorSnapshot {
  phase: RuntimeSupervisorPhase;
  generation: number;
  pid: number | null;
  websocketUrl: string | null;
  restartAttempt: number;
  restartScheduled: boolean;
  lastError: string | null;
  databaseRecovery?: RuntimeDatabaseStartupRecoveryReport | null;
}

export interface RuntimeSupervisorOptions {
  spawn: () => UtilityProcess;
  workerOptions: Omit<
    RuntimeWorkerOptions,
    | "runtimeGenerationId"
    | "systemBootId"
    | "confirmedTerminatedRuntimeGenerationIds"
    | "manuallyRetiredRuntimeGenerationIds"
    | "priorRuntimeCleanupUnconfirmed"
  >;
  systemBootId?: string;
  /** Main-owned user decision gate; no process recovery or worker spawn occurs. */
  runtimeRecoveryBlocked?: boolean;
  startupTimeoutMs?: number;
  stableUptimeMs?: number;
  shutdownGraceMs?: number;
  forceKillWaitMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  forceKill?: (pid: number, deadlineAt: number) => boolean | Promise<boolean>;
  recoverOwnedProcesses?: (
    runtimeGenerationId: string,
    systemBootId: string,
    deadlineAt: number,
  ) => boolean | Promise<boolean> | null;
  armProcessContainment?: (
    runtimeGenerationId: string,
    runtimePid: number,
  ) => RuntimeOwnedProcessContainment | Promise<RuntimeOwnedProcessContainment | null> | null;
  credentialBroker?: RuntimeCredentialBroker;
  credentialRequestTimeoutMs?: number;
  secureFileBroker?: RuntimeSecureFileBroker;
  agentBrowserBroker?: RuntimeAgentBrowserBroker;
  conversationAttachmentStoreRunner?: ConversationAttachmentStoreAnyOperationRunner;
  conversationAttachmentStoreAuthority?: ConversationAttachmentStoreAuthority;
  attachmentBroker?: RuntimeAttachmentBroker;
  attachmentRequestTimeoutMs?: number;
  databaseRecoveryRequestTimeoutMs?: number;
  databaseRecoveryCancelTimeoutMs?: number;
  onSystemSuspendResult?: (
    id: string,
    generation: number,
    recorded: boolean,
  ) => void;
  onStateChange?: (snapshot: RuntimeSupervisorSnapshot) => void;
}
