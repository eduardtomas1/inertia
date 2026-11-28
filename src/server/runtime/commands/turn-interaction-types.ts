import type WebSocket from "ws";

import type { ConversationAttachmentStore } from "../../../node/conversation-attachment-store";
import type {
  AccessMode,
  AgentApprovalRequest,
  AgentInputRequest,
  ChatAttachment,
  InteractionMode,
  ProviderInfo,
  RuntimeMutationEvent,
  ServerEvent,
} from "../../../shared/contracts";
import type { MessageQueueResult, QueuedMessage } from "../../../shared/queued-messages";
import type { QueueItemProjection } from "../../../shared/orchestration-queue";
import type { RuntimeStore } from "../../database";
import type { ProviderTerminalResumeRegistry } from "../../provider/terminal-resume";
import type { prepareDocumentAttachments } from "../attachments/document-attachment-context";
import type { PrivateGeneratedAttachmentStore } from "../attachments/private-generated-attachments";
import type { TrustedAttachmentResolver } from "../attachments/trusted-attachment-resolver";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { IsolatedRunController } from "../reviews/isolated-run-controller";
import type { TurnController } from "../turns/turn-controller";
import type { WorkspaceRunController } from "../workspace-run-controller";
import type { AgentWorkflowController } from "../agent-workflow-controller";
import type { WatcherNoteDelivery } from "../watcher/watcher-note-instruction";
import type { DelegatedDelivery } from "../delegation/delivery-instruction";

export interface CompactionHandoff {
  conversationId: string;
  attachments: Awaited<ReturnType<TrustedAttachmentResolver["resolvePayloads"]>>;
  attachmentsTaken: boolean;
}

export interface UndeliveredFollowUp {
  conversationId: string;
  id: string;
  content: string;
  attachments: ChatAttachment[];
}

export type QueuedMessagePersistence = (insert: () => void) => Promise<void>;

export interface ScheduledDelivery {
  taskId: string;
  runId: string;
  title: string;
  accessMode: AccessMode;
  interactionMode: InteractionMode;
  freshContext?: boolean;
  requirePrivateConnectPromptSafety?: boolean;
}

export interface TurnInteractionCommandDependencies {
  queuedMessage?: QueuedMessage;
  assertQueuedAttributionCurrent?(item: QueueItemProjection): void;
  undeliveredFollowUps?: {
    enqueue(input: UndeliveredFollowUp, handoffId: string, persist?: QueuedMessagePersistence): Promise<MessageQueueResult>;
    adopt(input: UndeliveredFollowUp, unconfirmed: string | null): MessageQueueResult;
    result?(conversationId: string, id: string): MessageQueueResult;
  };
  limitResetDispatch?: { planId: string; assertCurrent(): void };
  watcherDelivery?: WatcherNoteDelivery;
  delegatedDelivery?: DelegatedDelivery;
  scheduledDelivery?: ScheduledDelivery;
  restartContinuationDispatch?: { planId: string; assertCurrent(): void };
  compactionHandoff?: CompactionHandoff;
  store: RuntimeStore;
  conversationAttachments: ConversationAttachmentStore;
  backendProfileController: BackendProfileController;
  turns: TurnController;
  isolatedRuns: IsolatedRunController<WebSocket>;
  workspaceRuns: WorkspaceRunController<WebSocket>;
  pendingApprovals: Map<string, AgentApprovalRequest>;
  pendingInputs: Map<string, AgentInputRequest>;
  dataDirectory: string;
  enableProviders: boolean;
  attachmentResolver: TrustedAttachmentResolver | null;
  generatedAttachments: PrivateGeneratedAttachmentStore;
  prepareDocumentAttachments?: typeof prepareDocumentAttachments;
  workflows: AgentWorkflowController;
  providerTerminalResumes: ProviderTerminalResumeRegistry;
  providerInfo(): readonly ProviderInfo[];
  verifyProviderInstallation?(providerId: ProviderInfo["id"]): Promise<void>;
  prepareForkSession?(conversationId: string, signal: AbortSignal): Promise<void>;
  broadcast(event: RuntimeMutationEvent): void;
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}
