import type { BackendCredentialStatus } from "../shared/backend-credentials.js";
import type { ClaudeCompatibleBackendProfile } from "../shared/claude-backend-profiles.js";
import type { AgentTurn } from "../shared/contracts.js";
import type { OpenProjectPathRequest } from "../shared/desktop.js";
import type {
  PrivateConnectRuntimeAuthorization,
  PrivateConnectRuntimeRequest,
  PrivateConnectRuntimeResponse,
} from "../shared/private-connect/runtime-contract.js";
import type {
  RuntimePrivateConnectForgetScope,
  RuntimePrivateConnectPromptPreparation,
  RuntimeSystemSuspendInterval,
  RuntimeUpdatePreparationResult,
} from "../node/runtime-process-protocol.js";
import type {
  ConversationAttachmentStoreAnyOperationRunner,
} from "../node/conversation-attachment-store-child.js";
import type { RuntimeStore } from "./database.js";
import type { AgentHarnessRegistry } from "./provider/agent-harness-registry.js";
import type { DatabaseRecoveryImportResult } from "./persistence/database-export.js";
import type { RuntimeAttachmentBroker } from "./runtime/attachments/trusted-attachment-resolver.js";
import type { RuntimeSecureFileBroker } from "./secure-files.js";
import type {
  RuntimeAgentBrowserBroker,
} from "./runtime/agent-browser-broker-client.js";

export interface RuntimeOptions {
  dataDirectory: string;
  defaultWorkspacePath: string;
  enableProviders?: boolean;
  codexBinaryPath?: string;
  reviewSummaryTimeoutMs?: number;
  kimiClaudeProfiles?: readonly ClaudeCompatibleBackendProfile[];
  backendCredentials?: RuntimeBackendCredentialBroker;
  attachmentRoot?: string;
  attachments?: RuntimeAttachmentBroker;
  conversationAttachmentStoreOperations?: ConversationAttachmentStoreAnyOperationRunner;
  agentHarnessRegistry?: AgentHarnessRegistry;
  secureFiles?: RuntimeSecureFileBroker;
  agentBrowser?: RuntimeAgentBrowserBroker;
  recoveryImportFault?: {
    phase: "after-staging-publish" | "during-message-import";
    markerPath: string;
    stallMs: number;
  };
  runtimeGenerationId: string;
  systemBootId: string;
  confirmedTerminatedRuntimeGenerationIds?: readonly string[];
  priorRuntimeCleanupUnconfirmed?: boolean;
  onCleanupReceiptConsumed?: (
    receiptRuntimeGenerationId: string,
    currentRuntimeGenerationId: string,
  ) => void;
  testOnlyOnTurnSettled?: (turn: AgentTurn) => void | Promise<void>;
  testOnlyProjectIdentityRefresh?: Promise<void>;
  testOnlyBeforeRuntimeCommand?: () => Promise<void>;
  testOnlyProviderRefresh?: () => Promise<void>;
}

export interface RuntimeBackendCredentialBroker {
  resolve(secretReference: string, signal?: AbortSignal): Promise<string | null>;
  has(secretReference: string, signal?: AbortSignal): Promise<boolean>;
  status(secretReference: string, signal?: AbortSignal): Promise<BackendCredentialStatus>;
  clear(secretReference: string, signal?: AbortSignal): Promise<boolean>;
  forget(secretReference: string, signal?: AbortSignal): Promise<boolean>;
}

export interface RunningRuntime {
  runPackageSmokeImage?: (
    inputPath: string,
    resultPath: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  websocketUrl: string;
  databaseRecovery: ReturnType<RuntimeStore["databaseRecoveryReport"]>;
  recordSystemSuspendInterval: (interval: RuntimeSystemSuspendInterval) => void;
  /**
   * Atomically closes runtime work admission and reports whether shutdown for
   * an application update can begin. A ready result deliberately keeps the
   * gate held until close() stops this runtime generation or the owning
   * operation explicitly rolls back through releaseUpdatePreparation().
   */
  prepareForUpdate: (operationId: string) => Promise<RuntimeUpdatePreparationResult>;
  /** Reopens admission only when operationId owns the held update gate. */
  releaseUpdatePreparation: (operationId: string) => boolean;
  resolveProjectPath: (request: OpenProjectPathRequest) => Promise<string>;
  privateConnectRequest: (
    subject: PrivateConnectRuntimeAuthorization,
    request: Exclude<PrivateConnectRuntimeRequest, { type: "prompt.send" }>,
  ) => Promise<PrivateConnectRuntimeResponse>;
  preparePrivateConnectPrompt: (
    subject: PrivateConnectRuntimeAuthorization,
    request: Extract<PrivateConnectRuntimeRequest, { type: "prompt.send" }>,
  ) => Promise<RuntimePrivateConnectPromptPreparation | PrivateConnectRuntimeResponse>;
  commitPrivateConnectPrompt: (
    subject: PrivateConnectRuntimeAuthorization,
    request: Extract<PrivateConnectRuntimeRequest, { type: "prompt.send" }>,
    preparationId: string,
  ) => PrivateConnectRuntimeResponse;
  forgetPrivateConnectTranscripts: (scope: RuntimePrivateConnectForgetScope) => void;
  exportRecoveryData: (path: string, signal?: AbortSignal) => Promise<void>;
  importRecoveryData: (
    path: string,
    targetDirectory: string,
    signal?: AbortSignal,
    operationId?: string,
  ) => Promise<DatabaseRecoveryImportResult>;
  close: (cause?: "runtime-shutdown" | "runtime-crash") => Promise<void>;
}
