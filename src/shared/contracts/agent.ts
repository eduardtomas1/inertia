import type { ChatAttachmentMimeType } from "../attachments";
import type {
  ContinuationIdentity,
  HarnessId,
  ModelBackendProfileId,
  ModelSelection,
} from "../model-routing";
import type {
  AccessMode,
  AgentApprovalDecision,
  InteractionMode,
  MessageRole,
  ProviderId,
} from "./app";
import type {
  AgentTurnAssociation,
  AgentTurnStatus,
} from "../turn-lifecycle";

export {
  AGENT_TURN_STATUSES,
  agentTurnAssociationSchema,
  agentTurnStatusSchema,
  canTransitionAgentTurnStatus,
  isAgentTurnTerminalStatus,
  type AgentTurnAssociation,
  type AgentTurnStatus,
  type AgentTurnTerminalStatus,
} from "../turn-lifecycle";

export interface TurnFileReference {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface TurnDiffSelectionContext {
  path: string;
  hunkHeader: string;
  content: string;
  selectedLineCount: number;
  truncated?: boolean;
}

export interface TurnTerminalContext {
  terminalId: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  content: string;
}

export interface TurnPreviewContext {
  url: string;
  title?: string;
  selector?: string;
  componentName?: string;
  sourcePath?: string;
  sourceLine?: number;
  html?: string;
  styles?: string;
}

export interface TurnReviewNoteContext {
  noteId?: string;
  path: string;
  hunkId?: string;
  lineIds?: string[];
  body: string;
  stale?: boolean;
}

/**
 * Context selected by the user for provider execution. None of these fields
 * are user-authored chat prose; renderers must keep them separate from the
 * visible message content and present them as attachment metadata instead.
 */
export interface TurnRequestContext {
  fileReferences?: TurnFileReference[];
  diffSelections?: TurnDiffSelectionContext[];
  terminalContexts?: TurnTerminalContext[];
  previewContexts?: TurnPreviewContext[];
  reviewNotes?: TurnReviewNoteContext[];
}

export interface ChatAttachment {
  id: string;
  name: string;
  /** Renderer projections use the opaque attachment id; only privileged code may carry a local path. */
  path: string;
  mimeType: ChatAttachmentMimeType;
  size: number;
}

export interface ThreadUsageSnapshot {
  conversationId: string;
  /** Null only for legacy snapshots that predate authoritative turn ownership. */
  turnId: string | null;
  /** Current context occupancy. Null means the provider did not report it. */
  usedTokens: number | null;
  /** Processed-token total at the provider-defined scope below. */
  totalProcessedTokens: number | null;
  totalProcessedScope: "thread" | "session" | "run" | null;
  maxTokens: number | null;
  /** Latest provider-reported token breakdown; it is not necessarily the live context. */
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  /** Null means the provider has not explicitly reported its auto-compaction state. */
  compactsAutomatically: boolean | null;
  updatedAt: string;
}

/** Point-in-time provider usage captured at a turn boundary. */
export interface AgentTurnUsageSnapshot {
  usedTokens: number | null;
  totalProcessedTokens: number | null;
  totalProcessedScope: ThreadUsageSnapshot["totalProcessedScope"];
  maxTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  compactsAutomatically: boolean | null;
  capturedAt: string;
}

/**
 * A durable, immutable unit of requested agent work. Conversation settings
 * remain mutable, so every turn captures the exact execution configuration
 * that was selected when the request was queued.
 */
export interface AgentTurn {
  id: string;
  conversationId: string;
  runId: string;
  userMessageId: string;
  terminalAssistantMessageId: string | null;
  providerId: ProviderId;
  /** Canonical immutable execution selection captured when this turn queued. */
  modelSelection: ModelSelection;
  continuationIdentity: ContinuationIdentity;
  /** @deprecated Read-only compatibility projections of modelSelection. */
  harnessId: HarnessId;
  backendProfileId: ModelBackendProfileId;
  /** Exact provider model identifier used for this turn. */
  model: string;
  /** User-facing or provider alias requested before exact model resolution. */
  modelAlias: string | null;
  reasoningEffort: string;
  interactionMode: InteractionMode;
  accessMode: AccessMode;
  providerSessionBefore: string | null;
  providerSessionAfter: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: AgentTurnStatus;
  terminalReason: string | null;
  checkpointId: string | null;
  usageAtStart: AgentTurnUsageSnapshot | null;
  usageAtCompletion: AgentTurnUsageSnapshot | null;
  configurationRevision: number;
  association: AgentTurnAssociation;
  createdAt: string;
  updatedAt: string;
}

/**
 * Definite renderer acknowledgement for one durably accepted message send.
 * The runtime emits this only after the user message and its authoritative
 * turn association can be reconciled after refresh or reconnect.
 */
export interface MessageSendAcceptance {
  kind: "message.accepted";
  conversationId: string;
  turnId: string;
  userMessageId: string;
  disposition: "new-turn" | "follow-up";
}

export interface AgentReasoning {
  id: string;
  conversationId: string;
  runId: string;
  /** Null only for legacy reasoning records. */
  turnId: string | null;
  content: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  /** System messages may be conversation-scoped; user/assistant turn messages are explicit. */
  turnId: string | null;
  role: MessageRole;
  content: string;
  attachments: ChatAttachment[];
  createdAt: string;
}

export interface AgentActivity {
  id: string;
  conversationId: string;
  runId: string;
  /** Null only for legacy or conversation-scoped system activity. */
  turnId: string | null;
  kind: "status" | "tool" | "command" | "file" | "reasoning" | "error";
  title: string;
  detail: string | null;
  status: "running" | "completed" | "failed";
  createdAt: string;
}

export type SubagentTraceStatus =
  | "queued"
  | "spawned"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown"
  | "lost";

/**
 * A bounded, provider-authored projection of one delegated agent. Provider
 * task and agent identities remain separate because neither transport
 * guarantees that they are interchangeable.
 */
export interface SubagentTrace {
  id: string;
  conversationId: string;
  runId: string;
  turnId: string;
  providerId: ProviderId;
  providerTaskId: string | null;
  providerAgentId: string | null;
  parentTraceId: string | null;
  parentProviderAgentId: string | null;
  parentProviderToolUseId: string | null;
  providerToolUseId: string | null;
  providerRole: string | null;
  providerName: string | null;
  /** Exact bounded provider status when the transport exposes one. */
  providerStatus: string | null;
  status: SubagentTraceStatus;
  /**
   * Authoritative lifecycle liveness. This is separate from status because a
   * future provider state can be truthfully unknown while still representing
   * active, drainable work.
   */
  isLive: boolean;
  description: string | null;
  progress: string | null;
  result: string | null;
  /** Monotonic within the provider run; stale/replayed patches are ignored. */
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentApprovalRequest {
  id: string;
  /** Captured when the request is emitted; provider switches must not relabel it. */
  providerId: ProviderId;
  conversationId: string;
  runId: string;
  turnId: string;
  kind: "command" | "file-change" | "permissions";
  title: string;
  detail: string | null;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  networkScope: {
    host: string;
    protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
  } | null;
  permissionRoots: Array<{
    path: string;
    access: "read" | "write";
  }>;
  availableDecisions: AgentApprovalDecision[];
}

export interface AgentInputOption {
  /** Stable provider-native option identity when one exists. */
  id: string;
  label: string;
  description: string;
}

export interface AgentInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  allowMultiple: boolean;
  options: AgentInputOption[];
}

export interface AgentInputRequest {
  id: string;
  /** Captured when the request is emitted; provider switches must not relabel it. */
  providerId: ProviderId;
  conversationId: string;
  runId: string;
  turnId: string;
  questions: AgentInputQuestion[];
  autoResolutionMs: number | null;
}

export interface AgentPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface AgentPlan {
  conversationId: string;
  runId: string;
  /** Null only for legacy plans. */
  turnId: string | null;
  explanation: string | null;
  steps: AgentPlanStep[];
}

export interface CheckpointSummary {
  id: string;
  conversationId: string;
  /** Null only for legacy or manually-created conversation checkpoints. */
  turnId: string | null;
  ref: string;
  label: string;
  turnIndex: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  createdAt: string;
}
