import { z } from "zod";

import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  type ChatAttachmentMimeType,
} from "./attachments";
import {
  modelBackendProfileIdSchema,
  modelSelectionSchema,
  type ContinuationIdentity,
  type HarnessId,
  type ModelBackendProfileId,
  type ModelSelection,
} from "./model-routing";
import {
  modelBackendCredentialRevisionSchema,
  modelBackendDefaultInputSchema,
  modelBackendProfileDraftSchema,
  modelBackendProfileProbeSchema,
  modelBackendProfileUpdateSchema,
  type ModelBackendDefault,
  type ModelBackendProfileDetail,
  type ModelBackendProfileView,
} from "./backend-profile-settings";
import {
  providerMaintenanceOperationIdSchema,
  providerMaintenanceProviderIdSchema,
  type ProviderMaintenanceOperation,
  type ProviderMaintenanceStatus,
} from "./provider-maintenance";

export * from "./model-routing";
export * from "./backend-profile-settings";
export * from "./attachments";
export * from "./provider-maintenance";

export const PROTOCOL_VERSION = 1 as const;

export type ThemePreference = "system" | "light" | "dark";
export type ProjectStatus = "ready" | "working" | "attention";
export type MessageRole = "user" | "assistant" | "system";
export type ProviderId = "codex" | "claude" | "cursor" | "opencode";
export type ProviderInstallState = "checking" | "installed" | "not-installed" | "error";
export type ProviderAuthState = "checking" | "authenticated" | "unauthenticated" | "configured" | "unknown" | "error";
export type InteractionMode = "build" | "plan";
export type AccessMode = "supervised" | "auto-edit" | "full";
export type ThreadStatus = "idle" | "running" | "needs-input" | "completed" | "failed";
export type AgentApprovalDecision = "approve" | "deny" | "cancel";
export type ResponseDensity = "compact" | "default" | "comfortable";
export type InterfaceScale = "compact" | "default" | "comfortable" | "large";
export type UsageDisplayMode = "expanded" | "compact" | "hidden";
export type SidebarMode = "classic" | "activity";
export type ProjectGroupingMode = "repository" | "repository-path" | "separate";
export type ThreadAttentionKind = "approval" | "input";
export type AttentionState = "unseen" | "seen" | "acknowledged" | "dismissed";

export const AGENT_TURN_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting-for-approval",
  "waiting-for-input",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AgentTurnStatus = (typeof AGENT_TURN_STATUSES)[number];
export type AgentTurnTerminalStatus = Extract<
  AgentTurnStatus,
  "completed" | "failed" | "cancelled" | "interrupted"
>;
export type AgentTurnAssociation = "authoritative" | "inferred";

export const agentTurnStatusSchema = z.enum(AGENT_TURN_STATUSES);
export const agentTurnAssociationSchema = z.enum(["authoritative", "inferred"]);

const AGENT_TURN_TERMINAL_STATUSES: ReadonlySet<AgentTurnStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const AGENT_TURN_STATUS_TRANSITIONS: Readonly<Record<AgentTurnStatus, ReadonlySet<AgentTurnStatus>>> = {
  queued: new Set(["starting", "running", "completed", "failed", "cancelled", "interrupted"]),
  starting: new Set(["running", "waiting-for-approval", "waiting-for-input", "completed", "failed", "cancelled", "interrupted"]),
  running: new Set(["waiting-for-approval", "waiting-for-input", "completed", "failed", "cancelled", "interrupted"]),
  "waiting-for-approval": new Set(["running", "waiting-for-input", "completed", "failed", "cancelled", "interrupted"]),
  "waiting-for-input": new Set(["running", "waiting-for-approval", "completed", "failed", "cancelled", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

export function isAgentTurnTerminalStatus(status: AgentTurnStatus): status is AgentTurnTerminalStatus {
  return AGENT_TURN_TERMINAL_STATUSES.has(status);
}

/**
 * Lifecycle writes may be replayed with the same state, but terminal states
 * cannot be replaced by a different outcome.
 */
export function canTransitionAgentTurnStatus(from: AgentTurnStatus, to: AgentTurnStatus): boolean {
  return from === to || AGENT_TURN_STATUS_TRANSITIONS[from].has(to);
}

export interface ProviderReasoningOption {
  value: string;
  label: string;
  description: string;
}

export interface ProviderModel {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
  inputModalities: Array<"text" | "image">;
  reasoningOptions: ProviderReasoningOption[];
  defaultReasoningEffort: string;
}

export interface ProviderRateLimit {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export type ProviderMetadataFreshness = "unavailable" | "fresh" | "stale";
export type ProviderMetadataProvenance = "provider" | "session" | "persistent-cache";

export interface ProviderMetadataFieldState {
  freshness: ProviderMetadataFreshness;
  provenance: ProviderMetadataProvenance | null;
  updatedAt: string | null;
  lastAttemptedAt: string | null;
  refreshing: boolean;
}

export interface ProviderMetadataState {
  models: ProviderMetadataFieldState;
  rateLimits: ProviderMetadataFieldState;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  command: string;
  available: boolean;
  version: string | null;
  /** Resolved provider executable selected after discovery. */
  executable?: string | null;
  installState: ProviderInstallState;
  authState: ProviderAuthState;
  canRun: boolean;
  statusMessage: string | null;
  models: ProviderModel[];
  rateLimits: ProviderRateLimit[];
  metadataState: ProviderMetadataState;
  /** Present after the runtime has checked this exact installed CLI. */
  maintenance?: ProviderMaintenanceStatus;
}

export interface ChatAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: ChatAttachmentMimeType;
  size: number;
}

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

export interface AppSettings {
  theme: ThemePreference;
  compactSidebar: boolean;
  showTimestamps: boolean;
  terminalFontSize: number;
  defaultProvider: ProviderId;
  defaultModel: string;
  defaultAccessMode: AccessMode;
  newThreadMode: "local" | "worktree";
  wrapDiffs: boolean;
  ignoreWhitespace: boolean;
  showThinking: boolean;
  usageDisplayMode: UsageDisplayMode;
  interfaceScale: InterfaceScale;
  responseDensity: ResponseDensity;
  defaultCodeWrap: boolean;
  autoCollapseWorkLog: boolean;
  showChangedFileSummaries: boolean;
  sidebarMode: SidebarMode;
  projectGrouping: ProjectGroupingMode;
  autoOpenPlan: boolean;
  confirmDestructiveActions: boolean;
  defaultReasoningEffort: string;
  defaultInteractionMode: InteractionMode;
  /** Empty uses automatic discovery; otherwise an explicitly validated Codex binary or shim. */
  codexBinaryPath: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  normalizedPath: string;
  repositoryIdentity: string | null;
  repositoryRoot: string | null;
  repositoryRelativePath: string;
  groupingMode: ProjectGroupingMode | null;
  color: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  providerId: ProviderId;
  /** Canonical harness/backend/model configuration for the next turn. */
  modelSelection: ModelSelection;
  continuationIdentity: ContinuationIdentity | null;
  /** @deprecated Read-only compatibility projection of modelSelection.modelId. */
  model: string;
  reasoningEffort: string;
  interactionMode: InteractionMode;
  accessMode: AccessMode;
  status: ThreadStatus;
  attentionKind: ThreadAttentionKind | null;
  branch: string | null;
  worktreePath: string | null;
  providerSessionId: string | null;
  archivedAt: string | null;
  settledAt: string | null;
  completedAt: string | null;
  lastViewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Lightweight navigation metadata. Shells are safe to keep for every
 * conversation because they never contain transcript, reasoning, plan, or
 * artifact payloads.
 */
export interface ConversationLatestTurnSummary {
  id: string;
  runId: string;
  status: AgentTurnStatus;
  providerId: ProviderId;
  harnessId: HarnessId;
  backendProfileId: ModelBackendProfileId;
  modelSelection: ModelSelection;
  continuationIdentity: ContinuationIdentity;
  model: string;
  reasoningEffort: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  terminalReason: string | null;
  updatedAt: string;
}

export type ConversationShell = Conversation & {
  latestTurn: ConversationLatestTurnSummary | null;
  pendingApproval: boolean;
  pendingInput: boolean;
};

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
  | "spawned"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
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
  status: SubagentTraceStatus;
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

/**
 * Identifies one runtime-process projection and the latest authoritative
 * mutation incorporated into it. Runtime generations are deliberately opaque:
 * clients may compare them for equality but must not derive ordering from them.
 */
export interface RuntimeSyncCursor {
  runtimeGeneration: string;
  latestSequence: number;
}

export interface AppSnapshot {
  projects: Project[];
  conversations: ConversationShell[];
  runs: WorkspaceRun[];
  providers: ProviderInfo[];
  /** Safe backend configuration only; credential values and references are forbidden. */
  backendProfiles?: ModelBackendProfileView[];
  backendDefaults?: ModelBackendDefault[];
  settings: AppSettings;
  activeProjectId: string | null;
  activeConversationId: string | null;
  /** Present on authoritative runtime snapshots; optional for legacy fixtures. */
  sync?: RuntimeSyncCursor;
}

/**
 * Heavy state for one conversation. This is loaded independently from the
 * app shell so transcript growth does not inflate navigation snapshots.
 */
export interface ConversationDetail {
  conversation: Conversation;
  agentTurns: AgentTurn[];
  turnGitArtifacts: TurnGitArtifact[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  subagents: SubagentTrace[];
  reasonings: AgentReasoning[];
  usage: ThreadUsageSnapshot[];
  plans: AgentPlan[];
  checkpoints: CheckpointSummary[];
  reviewSummaries: DiffReviewSummary[];
  reviewStates: DiffReviewState[];
  reviewNotes: DiffReviewNote[];
}

export type ConversationDetailResult =
  | { kind: "conversation.detail"; conversationId: string; state: "ready"; detail: ConversationDetail; sync?: RuntimeSyncCursor }
  | { kind: "conversation.detail"; conversationId: string; state: "missing"; sync?: RuntimeSyncCursor }
  | { kind: "conversation.detail"; conversationId: string; state: "deleted"; sync?: RuntimeSyncCursor }
  | { kind: "conversation.detail"; conversationId: string; state: "failed"; message: string; sync?: RuntimeSyncCursor };

export type ConversationDetailViewState =
  | { conversationId: string; state: "loading" }
  | ConversationDetailResult;

export interface ChangedFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  untracked: boolean;
  staged: boolean;
  unstaged: boolean;
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatusSnapshot {
  isRepository: boolean;
  /** Canonical Git toplevel actually inspected for this status snapshot. */
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  files: ChangedFile[];
  insertions: number;
  deletions: number;
}

export interface GitDiffSnapshot {
  patch: string;
  truncated: boolean;
  files: ChangedFile[];
}

export type WorkspaceGitRepositoryState = "ready" | "error";

/**
 * Status for one Git toplevel discovered inside the active workspace.
 * `repositoryPath` is a safe, POSIX-style path relative to that workspace;
 * the workspace root itself is represented by ".".
 */
export interface WorkspaceGitRepositorySnapshot {
  repositoryPath: string;
  state: WorkspaceGitRepositoryState;
  error: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  files: ChangedFile[];
  insertions: number;
  deletions: number;
  clean: boolean;
  truncated: boolean;
}

export interface WorkspaceGitIssue {
  repositoryPath: string;
  message: string;
}

/**
 * Bounded, workspace-wide Git discovery result. It deliberately remains
 * separate from immutable per-turn Git artifacts.
 */
export interface WorkspaceGitSnapshot {
  repositories: WorkspaceGitRepositorySnapshot[];
  files: number;
  insertions: number;
  deletions: number;
  scannedDirectories: number;
  skippedDirectories: number;
  partial: boolean;
  truncated: boolean;
  issues: WorkspaceGitIssue[];
}

export interface WorkspaceGitDiffSnapshot extends GitDiffSnapshot {
  repositoryPath: string;
}

export type TurnGitArtifactStatus = "pending" | "ready" | "partial" | "unavailable" | "failed";
export type TurnGitArtifactCompleteness = "complete" | "truncated" | "partial" | "unavailable";
export type TurnGitPatchState = "none" | "available" | "truncated" | "expired" | "failed";
export type TurnGitArtifactAbsenceReason = "not-repository";

export interface TurnGitArtifactFile extends ChangedFile {
  previousPath: string | null;
  binary: boolean;
}

/**
 * Immutable historical Git metadata captured for one authoritative agent turn.
 * Raw patches live in bounded content-addressed storage and are fetched only
 * through an explicit request; ordinary snapshots contain metadata only.
 */
export interface TurnGitArtifact {
  id: string;
  turnId: string;
  conversationId: string;
  runId: string;
  repositoryIdentity: string | null;
  worktreeIdentity: string | null;
  branch: string | null;
  beforeCheckpointId: string | null;
  beforeFingerprint: string | null;
  afterFingerprint: string | null;
  files: TurnGitArtifactFile[];
  insertions: number;
  deletions: number;
  status: TurnGitArtifactStatus;
  completeness: TurnGitArtifactCompleteness;
  patchState: TurnGitPatchState;
  patchDigest: string | null;
  capturedAt: string | null;
  terminalAssistantMessageId: string | null;
  failureReason: string | null;
  /**
   * Expected absence at the selected project root. Optional for snapshots
   * produced before the typed classification was introduced.
   */
  absenceReason?: TurnGitArtifactAbsenceReason | null;
}

export interface TurnGitDiffSnapshot extends GitDiffSnapshot {
  artifactId: string;
  turnId: string;
  title: string;
  completeness: TurnGitArtifactCompleteness;
  patchState: TurnGitPatchState;
}

export interface DiffLine {
  id: string;
  kind: "context" | "addition" | "deletion" | "meta";
  content: string;
  patchLine: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  newInsertionIndex: number;
  oldInsertionIndex: number;
  noFinalNewline?: boolean;
}

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
}

export interface StructuredDiff {
  fingerprint: string;
  files: DiffFile[];
}

export type GitDiffLayer = "index" | "worktree";

export interface DiffReversalValidation {
  diffFingerprint: string;
  fileFingerprint: string;
  hunkFingerprint: string;
  selectionFingerprint: string;
  gitStateFingerprint: string;
}

export interface DiffReversalPlan {
  filePath: string;
  hunkId: string;
  hunkHeader: string;
  selectedLineCount: number;
  changedLineCount: number;
  affectedLayers: GitDiffLayer[];
  validation: DiffReversalValidation;
}

export interface DiffReversalOperation {
  id: string;
  filePath: string;
  selectedLineCount: number;
  affectedLayers: GitDiffLayer[];
  createdAt: string;
}

export interface DiffReviewSummary {
  conversationId: string;
  fingerprint: string;
  providerId: ProviderId;
  /** Null only when a pre-v0.0.7 row did not record execution attribution. */
  harnessId: string | null;
  /** Null only when a pre-v0.0.7 row did not record execution attribution. */
  backendProfileId: string | null;
  /** Exact provider model ID, or null when the provider did not expose it. */
  model: string | null;
  overall: string;
  classifications: DiffReviewClassificationHint[];
  files: Array<{
    path: string;
    summary: string;
    classifications: DiffReviewClassificationHint[];
    hunks: Array<{
      hunkId: string;
      summary: string;
      classifications: DiffReviewClassificationHint[];
    }>;
  }>;
  generatedAt: string;
}

/**
 * Ephemeral result of an isolated read-only question about one exact diff
 * selection. It is intentionally not part of the conversation transcript or
 * AgentTurn ledger.
 */
export interface DiffSelectionReviewAnswer {
  conversationId: string;
  /** Workspace-relative Git root used for this answer; "." is the workspace root. */
  repositoryPath?: string;
  fingerprint: string;
  filePath: string;
  hunkId: string;
  selectedLineCount: number;
  question: string;
  answer: string;
  providerId: ProviderId;
  modelSelection: ModelSelection;
  generatedAt: string;
}

export type DiffReviewClassification =
  | "behavior-change"
  | "regression-risk"
  | "security-sensitive"
  | "migration"
  | "test-impact"
  | "performance-sensitive"
  | "documentation-only";

export interface DiffReviewClassificationHint {
  classification: DiffReviewClassification;
  evidence: string;
}

export type DiffReviewScope = "file" | "hunk";

export interface DiffReviewState {
  conversationId: string;
  scope: DiffReviewScope;
  path: string;
  hunkId: string | null;
  targetFingerprint: string;
  reviewed: boolean;
  stale: boolean;
  updatedAt: string;
}

export interface DiffReviewNote {
  id: string;
  conversationId: string;
  path: string;
  hunkId: string | null;
  lineIds: string[];
  targetFingerprint: string;
  body: string;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRun {
  id: string;
  kind: "agent" | "check" | "service" | "source-control";
  projectId: string;
  conversationId: string | null;
  /** Stable package-script identity for safely validated retry/rerun actions. */
  actionId: string | null;
  label: string;
  detail: string | null;
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  /** Durable user disposition; independent from the run lifecycle and thread settlement. */
  attentionState: AttentionState;
  /** Ephemeral runtime capability. False after a restart or when no owned process exists. */
  canStop: boolean;
  port: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  worktreePath: string | null;
}

export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory";
}

export interface WorkspaceEntriesPage {
  /** Project-relative directory for a lazy listing; empty for root and search results. */
  directory: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface WorkspaceFilePreview {
  path: string;
  content: string;
  truncated: boolean;
  language: string;
}

export interface ProjectAction {
  id: string;
  label: string;
  command: string;
  preview: boolean;
}

const requestBase = {
  requestId: z.string().uuid(),
};

function isPortableWorkspacePath(path: string, allowRoot: boolean): boolean {
  if (
    /[\0\r\n]/u.test(path)
    || /^[\\/]/u.test(path)
    || /^[A-Za-z]:/u.test(path)
    || path.split(/[\\/]/u).some((segment) => segment === "..")
  ) return false;
  return allowRoot || (path !== "" && path !== ".");
}

const workspaceDirectoryPathSchema = z.string()
  .min(1)
  .max(4_096)
  .refine((path) => isPortableWorkspacePath(path, true), "Invalid project-relative directory.");
const workspaceFilePathSchema = z.string()
  .min(1)
  .max(4_096)
  .refine((path) => isPortableWorkspacePath(path, false), "Invalid project-relative file.");

const providerIdSchema = z.enum(["codex", "claude", "cursor", "opencode"]);
const accessModeSchema = z.enum(["supervised", "auto-edit", "full"]);
const interactionModeSchema = z.enum(["build", "plan"]);
const attachmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(255),
    path: z.string().min(1).max(4096),
    mimeType: z.enum(CHAT_ATTACHMENT_MIME_TYPES),
    size: z.number().int().min(1).max(MAX_CHAT_ATTACHMENT_BYTES),
  })
  .strict();
const turnRequestContextSchema = z
  .object({
    fileReferences: z.array(z.object({
      path: z.string().trim().min(1).max(4096),
      lineStart: z.number().int().min(1).max(10_000_000).optional(),
      lineEnd: z.number().int().min(1).max(10_000_000).optional(),
    }).strict()).max(16).optional(),
    diffSelections: z.array(z.object({
      path: z.string().trim().min(1).max(4096),
      hunkHeader: z.string().trim().min(1).max(2_000),
      content: z.string().min(1).max(64 * 1024),
      selectedLineCount: z.number().int().min(1).max(500),
      truncated: z.boolean().optional(),
    }).strict()).max(8).optional(),
    terminalContexts: z.array(z.object({
      terminalId: z.string().trim().min(1).max(200),
      terminalLabel: z.string().trim().min(1).max(200),
      lineStart: z.number().int().min(1).max(10_000_000),
      lineEnd: z.number().int().min(1).max(10_000_000),
      content: z.string().min(1).max(64 * 1024),
    }).strict()).max(8).optional(),
    previewContexts: z.array(z.object({
      url: z.string().trim().min(1).max(8_192),
      title: z.string().trim().min(1).max(1_000).optional(),
      selector: z.string().trim().min(1).max(4_000).optional(),
      componentName: z.string().trim().min(1).max(500).optional(),
      sourcePath: z.string().trim().min(1).max(4_096).optional(),
      sourceLine: z.number().int().min(1).max(10_000_000).optional(),
      html: z.string().max(16 * 1024).optional(),
      styles: z.string().max(16 * 1024).optional(),
    }).strict()).max(8).optional(),
    reviewNotes: z.array(z.object({
      noteId: z.string().uuid().optional(),
      path: z.string().trim().min(1).max(4_096),
      hunkId: z.string().trim().min(1).max(128).optional(),
      lineIds: z.array(z.string().min(1).max(160)).max(500).optional(),
      body: z.string().trim().min(1).max(8_000),
      stale: z.boolean().optional(),
    }).strict()).max(16).optional(),
  })
  .strict();
const diffReviewSelectionSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid(),
  repositoryPath: z.string().min(1).max(4096).optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  filePath: z.string().min(1).max(4096),
  hunkId: z.string().min(1).max(128),
  lineIds: z.array(z.string().min(1).max(160)).min(1).max(500),
  comment: z.string().trim().max(2_000).optional(),
  ignoreWhitespace: z.boolean().optional(),
}).strict();

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...requestBase, type: z.literal("app.refresh") }).strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("provider.refresh"),
      payload: z.object({ providerId: providerIdSchema.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("provider.auth.start"),
      payload: z.object({
        providerId: providerIdSchema,
        cols: z.number().int().min(40).max(240),
        rows: z.number().int().min(10).max(80),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("provider.maintenance.refresh"),
      payload: z.object({
        providerId: providerMaintenanceProviderIdSchema.optional(),
        force: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("provider.maintenance.update"),
      payload: z.object({
        providerId: providerMaintenanceProviderIdSchema,
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("provider.maintenance.cancel"),
      payload: z.object({
        operationId: providerMaintenanceOperationIdSchema,
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.create"),
      payload: z.object({ name: z.string().trim().min(1).max(80), path: z.string().min(1).max(4096) }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.select"),
      payload: z.object({ projectId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.remove"),
      payload: z.object({ projectId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.update"),
      payload: z.object({
        projectId: z.string().uuid(),
        name: z.string().trim().min(1).max(80).optional(),
        groupingMode: z.enum(["repository", "repository-path", "separate"]).nullable().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("conversation.create"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          title: z.string().trim().min(1).max(120),
          providerId: providerIdSchema.optional(),
          modelSelection: modelSelectionSchema.optional(),
          model: z.string().trim().max(160).optional(),
          reasoningEffort: z.string().trim().max(40).optional(),
          interactionMode: interactionModeSchema.optional(),
          accessMode: accessModeSchema.optional(),
          useWorktree: z.boolean().optional(),
          branch: z.string().trim().min(1).max(255).nullable().optional(),
          worktreePath: z.string().min(1).max(4096).nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("conversation.select"),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("conversation.detail.load"),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("conversation.update"),
      payload: z
        .object({
          conversationId: z.string().uuid(),
          title: z.string().trim().min(1).max(120).optional(),
          providerId: providerIdSchema.optional(),
          modelSelection: modelSelectionSchema.optional(),
          model: z.string().trim().max(160).optional(),
          reasoningEffort: z.string().trim().max(40).optional(),
          interactionMode: interactionModeSchema.optional(),
          accessMode: accessModeSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.enum(["conversation.archive", "conversation.unarchive", "conversation.settle", "conversation.unsettle", "conversation.delete"]),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("message.send"),
      payload: z
        .object({
          conversationId: z.string().uuid(),
          content: z.string().trim().min(1).max(20_000),
          attachments: z.array(attachmentSchema).max(MAX_CHAT_ATTACHMENTS).default([]),
          context: turnRequestContextSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.stop"),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.subagent.stop"),
      payload: z.object({
        conversationId: z.string().uuid(),
        traceId: z.string().uuid(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("activity.stop"),
      payload: z.object({ runId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("activity.dismiss"),
      payload: z.object({ runId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.enum(["activity.mark-seen", "activity.acknowledge"]),
      payload: z.object({ runId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.approval.respond"),
      payload: z.object({
        conversationId: z.string().uuid(),
        requestId: z.string().uuid(),
        decision: z.enum(["approve", "deny", "cancel"]),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("agent.input.respond"),
      payload: z.object({
        conversationId: z.string().uuid(),
        requestId: z.string().uuid(),
        answers: z.record(
          z.string().trim().min(1).max(120),
          z.array(z.string().min(1).max(4_000)).min(1).max(20),
        ).refine((answers) => Object.keys(answers).length <= 3),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("settings.update"),
      payload: z
        .object({
          theme: z.enum(["system", "light", "dark"]).optional(),
          compactSidebar: z.boolean().optional(),
          showTimestamps: z.boolean().optional(),
          terminalFontSize: z.number().int().min(11).max(22).optional(),
          defaultProvider: providerIdSchema.optional(),
          defaultModel: z.string().trim().max(160).optional(),
          defaultAccessMode: accessModeSchema.optional(),
          newThreadMode: z.enum(["local", "worktree"]).optional(),
          wrapDiffs: z.boolean().optional(),
          ignoreWhitespace: z.boolean().optional(),
          showThinking: z.boolean().optional(),
          usageDisplayMode: z.enum(["expanded", "compact", "hidden"]).optional(),
          interfaceScale: z.enum(["compact", "default", "comfortable", "large"]).optional(),
          responseDensity: z.enum(["compact", "default", "comfortable"]).optional(),
          defaultCodeWrap: z.boolean().optional(),
          autoCollapseWorkLog: z.boolean().optional(),
          showChangedFileSummaries: z.boolean().optional(),
          sidebarMode: z.enum(["classic", "activity"]).optional(),
          projectGrouping: z.enum(["repository", "repository-path", "separate"]).optional(),
          autoOpenPlan: z.boolean().optional(),
          confirmDestructiveActions: z.boolean().optional(),
          defaultReasoningEffort: z.string().trim().max(40).optional(),
          defaultInteractionMode: interactionModeSchema.optional(),
          codexBinaryPath: z.string().trim().max(4096).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.get"),
      payload: z.object({ profileId: modelBackendProfileIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.create"),
      payload: modelBackendProfileDraftSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.update"),
      payload: z.object({
        profileId: modelBackendProfileIdSchema,
        update: modelBackendProfileUpdateSchema,
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.credential-revision"),
      payload: modelBackendCredentialRevisionSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.probe"),
      payload: modelBackendProfileProbeSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.delete"),
      payload: z.object({ profileId: modelBackendProfileIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.default.set"),
      payload: modelBackendDefaultInputSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.default.clear"),
      payload: z.object({ projectId: z.string().uuid().nullable() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.refresh"),
      payload: z.object({ projectId: z.string().uuid(), conversationId: z.string().uuid().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.diff"),
      payload: z
        .object({ projectId: z.string().uuid(), conversationId: z.string().uuid().optional(), path: z.string().max(512).optional(), ignoreWhitespace: z.boolean().optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.workspace.refresh"),
      payload: z.object({ projectId: z.string().uuid(), conversationId: z.string().uuid().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.workspace.diff"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          conversationId: z.string().uuid().optional(),
          repositoryPath: z.string().min(1).max(4096),
          path: z.string().min(1).max(4096).optional(),
          ignoreWhitespace: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.turn.diff"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid(),
        turnId: z.string().min(1).max(200),
        path: z.string().min(1).max(4096).optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.turn.compare"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid(),
        earlierTurnId: z.string().min(1).max(200),
        laterTurnId: z.string().min(1).max(200),
        path: z.string().min(1).max(4096).optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.selection.inspect"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid().optional(),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        filePath: z.string().min(1).max(4096),
        hunkId: z.string().min(1).max(128),
        lineIds: z.array(z.string().min(1).max(160)).min(1).max(500),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.selection.revert"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid().optional(),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        filePath: z.string().min(1).max(4096),
        hunkId: z.string().min(1).max(128),
        lineIds: z.array(z.string().min(1).max(160)).min(1).max(500),
        expected: z.object({
          diffFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
          fileFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
          hunkFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
          selectionFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
          gitStateFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        }).strict(),
        comment: z.string().trim().max(2_000).optional(),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.selection.undo"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid().optional(),
        operationId: z.string().uuid(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.selection.ask"),
      payload: diffReviewSelectionSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.selection.revise"),
      payload: diffReviewSelectionSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.state.set"),
      payload: z.object({
        conversationId: z.string().uuid(),
        scope: z.enum(["file", "hunk"]),
        path: z.string().min(1).max(4096),
        hunkId: z.string().min(1).max(128).nullable(),
        targetFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        reviewed: z.boolean(),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.note.create"),
      payload: z.object({
        conversationId: z.string().uuid(),
        path: z.string().min(1).max(4096),
        hunkId: z.string().min(1).max(128).nullable(),
        lineIds: z.array(z.string().min(1).max(160)).max(500),
        targetFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        body: z.string().trim().min(1).max(8_000),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.note.update"),
      payload: z.object({
        conversationId: z.string().uuid(),
        noteId: z.string().uuid(),
        body: z.string().trim().min(1).max(8_000),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.note.delete"),
      payload: z.object({ conversationId: z.string().uuid(), noteId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.summary.generate"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid(),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.summary.cancel"),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.branches"),
      payload: z.object({ projectId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.branch.create"),
      payload: z.object({ projectId: z.string().uuid(), name: z.string().trim().min(1).max(255) }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.branch.switch"),
      payload: z.object({ projectId: z.string().uuid(), name: z.string().trim().min(1).max(255) }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.worktree.create"),
      payload: z
        .object({ projectId: z.string().uuid(), conversationId: z.string().uuid(), baseBranch: z.string().trim().min(1).max(255), branch: z.string().trim().min(1).max(255) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.pull"),
      payload: z.object({ projectId: z.string().uuid(), conversationId: z.string().uuid().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.commit"),
      payload: z
        .object({ projectId: z.string().uuid(), conversationId: z.string().uuid().optional(), message: z.string().trim().min(1).max(10_000), paths: z.array(z.string().min(1).max(512)).max(500).optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.push"),
      payload: z.object({ projectId: z.string().uuid(), conversationId: z.string().uuid().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.pr.open"),
      payload: z.object({ projectId: z.string().uuid(), conversationId: z.string().uuid().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("workspace.entries"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          conversationId: z.string().uuid().optional(),
          directory: workspaceDirectoryPathSchema.optional(),
          query: z.string().trim().min(1).max(200).optional(),
        })
        .strict()
        .refine(
          ({ directory, query }) => !(directory && query),
          "Choose either a folder listing or a project search.",
        ),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("workspace.file.read"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid().optional(),
        path: workspaceFilePathSchema,
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.actions"),
      payload: z.object({ projectId: z.string().uuid(), conversationId: z.string().uuid().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.action.run"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          conversationId: z.string().uuid().optional(),
          actionId: z.string().trim().min(1).max(200),
          cols: z.number().int().min(20).max(400),
          rows: z.number().int().min(4).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("checkpoint.revert"),
      payload: z.object({ conversationId: z.string().uuid(), checkpointId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("terminal.create"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          conversationId: z.string().uuid().optional(),
          cols: z.number().int().min(20).max(400),
          rows: z.number().int().min(4).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("terminal.input"),
      payload: z.object({ terminalId: z.string().uuid(), data: z.string().max(8192) }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("terminal.resize"),
      payload: z
        .object({
          terminalId: z.string().uuid(),
          cols: z.number().int().min(20).max(400),
          rows: z.number().int().min(4).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("terminal.close"),
      payload: z.object({ terminalId: z.string().uuid() }).strict(),
    })
    .strict(),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;

export type RuntimeEventScope =
  | { kind: "shell" }
  | { kind: "conversation-detail"; conversationId: string };

/**
 * Renderer-safe authoritative mutations. The runtime transports these inside
 * `runtime.event` frames so reconnect replay and live delivery share the same
 * sequence semantics. They remain valid listener events after the connection
 * layer unwraps a frame.
 */
export type RuntimeMutationEvent =
  | { type: "snapshot.updated"; snapshot: AppSnapshot }
  | { type: "provider.maintenance.updated"; providers: ProviderMaintenanceStatus[] }
  | { type: "provider.maintenance.operation"; operation: ProviderMaintenanceOperation }
  | { type: "agent.started"; conversationId: string; runId: string; turnId: string }
  | { type: "agent.text"; conversationId: string; runId: string; turnId: string; text: string }
  | { type: "agent.reasoning"; conversationId: string; runId: string; turnId: string; text: string }
  | { type: "agent.usage"; usage: ThreadUsageSnapshot }
  | { type: "agent.activity"; activity: AgentActivity }
  | { type: "agent.subagent.updated"; trace: SubagentTrace }
  | { type: "agent.approval.requested"; request: AgentApprovalRequest }
  | { type: "agent.approval.resolved"; conversationId: string; runId: string; turnId: string; requestId: string; decision: "approve" | "deny" | "cancel" | "cancelled" }
  | { type: "agent.input.requested"; request: AgentInputRequest }
  | { type: "agent.input.resolved"; conversationId: string; runId: string; turnId: string; requestId: string }
  | { type: "agent.plan.updated"; plan: AgentPlan }
  | { type: "agent.completed"; conversationId: string; runId: string; turnId: string }
  | { type: "agent.failed"; conversationId: string; runId: string; turnId: string; message: string };

export type RuntimeSequencedFrame =
  | {
      type: "runtime.event";
      sync: RuntimeSyncCursor;
      scope: RuntimeEventScope;
      event: RuntimeMutationEvent;
    }
  | {
      /** Advances a filtered subscription without exposing another detail. */
      type: "runtime.cursor";
      sync: RuntimeSyncCursor;
    };

export type ServerEvent =
  | { type: "server.welcome"; protocolVersion: typeof PROTOCOL_VERSION; snapshot: AppSnapshot; sync?: RuntimeSyncCursor }
  | { type: "runtime.resumed"; protocolVersion: typeof PROTOCOL_VERSION; sync: RuntimeSyncCursor }
  | RuntimeSequencedFrame
  | { type: "runtime.sync.completed"; sync: RuntimeSyncCursor }
  | { type: "request.ok"; requestId: string }
  | { type: "request.error"; requestId: string; message: string }
  | {
      type: "request.result";
      requestId: string;
      result:
        | { kind: "git.status"; status: GitStatusSnapshot }
        | { kind: "git.diff"; diff: GitDiffSnapshot }
        | { kind: "git.workspace.status"; status: WorkspaceGitSnapshot }
        | { kind: "git.workspace.diff"; diff: WorkspaceGitDiffSnapshot }
        | { kind: "git.turn.diff"; diff: TurnGitDiffSnapshot }
        | { kind: "git.reversal.plan"; plan: DiffReversalPlan }
        | { kind: "git.reversal"; diff: GitDiffSnapshot; operation: DiffReversalOperation }
        | { kind: "review.selection.answer"; answer: DiffSelectionReviewAnswer }
        | { kind: "review.summary"; summary: DiffReviewSummary }
        | { kind: "git.branches"; branches: GitBranchInfo[] }
        | ({ kind: "workspace.entries" } & WorkspaceEntriesPage)
        | { kind: "workspace.file"; file: WorkspaceFilePreview }
        | { kind: "project.actions"; actions: ProjectAction[] }
        | { kind: "backend.profile"; profile: ModelBackendProfileDetail }
        | { kind: "backend.profile.probe"; profile: ModelBackendProfileDetail }
        | { kind: "backend.default"; value: ModelBackendDefault | null }
        | { kind: "provider.maintenance"; providers: ProviderMaintenanceStatus[] }
        | { kind: "provider.maintenance.operation"; operation: ProviderMaintenanceOperation }
        | { kind: "worktree.created"; path: string; branch: string }
        | { kind: "git.action"; message: string }
        | { kind: "external.url"; url: string; label: string }
        | ConversationDetailResult;
    }
  | RuntimeMutationEvent
  | { type: "terminal.created"; requestId: string; terminalId: string }
  | { type: "terminal.output"; terminalId: string; data: string }
  | { type: "terminal.exit"; terminalId: string; exitCode: number };

export const defaultSettings: AppSettings = {
  theme: "system",
  compactSidebar: false,
  showTimestamps: true,
  terminalFontSize: 13,
  defaultProvider: "codex",
  defaultModel: "",
  defaultAccessMode: "supervised",
  newThreadMode: "local",
  wrapDiffs: true,
  ignoreWhitespace: false,
  showThinking: true,
  usageDisplayMode: "compact",
  interfaceScale: "default",
  responseDensity: "default",
  defaultCodeWrap: false,
  autoCollapseWorkLog: true,
  showChangedFileSummaries: true,
  sidebarMode: "classic",
  projectGrouping: "separate",
  autoOpenPlan: true,
  confirmDestructiveActions: true,
  defaultReasoningEffort: "",
  defaultInteractionMode: "build",
  codexBinaryPath: "",
};
