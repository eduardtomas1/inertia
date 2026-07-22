import { z } from "zod";

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
  installState: ProviderInstallState;
  authState: ProviderAuthState;
  canRun: boolean;
  statusMessage: string | null;
  models: ProviderModel[];
  rateLimits: ProviderRateLimit[];
  metadataState: ProviderMetadataState;
}

export interface ChatAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
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
  showUsage: boolean;
  autoOpenPlan: boolean;
  confirmDestructiveActions: boolean;
  defaultReasoningEffort: string;
  defaultInteractionMode: InteractionMode;
}

export interface Project {
  id: string;
  name: string;
  path: string;
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
  model: string;
  reasoningEffort: string;
  interactionMode: InteractionMode;
  accessMode: AccessMode;
  status: ThreadStatus;
  branch: string | null;
  worktreePath: string | null;
  providerSessionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadUsageSnapshot {
  conversationId: string;
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

export interface AgentReasoning {
  id: string;
  conversationId: string;
  runId: string;
  content: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  attachments: ChatAttachment[];
  createdAt: string;
}

export interface AgentActivity {
  id: string;
  conversationId: string;
  runId: string;
  kind: "status" | "tool" | "command" | "file" | "reasoning" | "error";
  title: string;
  detail: string | null;
  status: "running" | "completed" | "failed";
  createdAt: string;
}

export interface AgentApprovalRequest {
  id: string;
  conversationId: string;
  runId: string;
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
  label: string;
  description: string;
}

export interface AgentInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: AgentInputOption[];
}

export interface AgentInputRequest {
  id: string;
  conversationId: string;
  runId: string;
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
  explanation: string | null;
  steps: AgentPlanStep[];
}

export interface CheckpointSummary {
  id: string;
  conversationId: string;
  ref: string;
  label: string;
  turnIndex: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  createdAt: string;
}

export interface AppSnapshot {
  projects: Project[];
  conversations: Conversation[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  reasonings: AgentReasoning[];
  usage: ThreadUsageSnapshot[];
  plans: AgentPlan[];
  checkpoints: CheckpointSummary[];
  reviewSummaries: DiffReviewSummary[];
  runs: WorkspaceRun[];
  providers: ProviderInfo[];
  settings: AppSettings;
  activeProjectId: string | null;
  activeConversationId: string | null;
}

export interface ChangedFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  untracked: boolean;
}

export interface GitStatusSnapshot {
  isRepository: boolean;
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

export interface DiffLine {
  id: string;
  kind: "context" | "addition" | "deletion" | "meta";
  content: string;
  patchLine: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  newInsertionIndex: number;
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

export interface DiffReviewSummary {
  conversationId: string;
  fingerprint: string;
  providerId: ProviderId;
  overall: string;
  files: Array<{
    path: string;
    summary: string;
    hunks: Array<{ hunkId: string; summary: string }>;
  }>;
  generatedAt: string;
}

export interface WorkspaceRun {
  id: string;
  kind: "agent" | "check" | "service" | "source-control";
  projectId: string;
  conversationId: string | null;
  label: string;
  detail: string | null;
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
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

const providerIdSchema = z.enum(["codex", "claude", "cursor", "opencode"]);
const accessModeSchema = z.enum(["supervised", "auto-edit", "full"]);
const interactionModeSchema = z.enum(["build", "plan"]);
const attachmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(255),
    path: z.string().min(1).max(4096),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    size: z.number().int().min(1).max(10 * 1024 * 1024),
  })
  .strict();

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
      type: z.literal("conversation.create"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          title: z.string().trim().min(1).max(120),
          providerId: providerIdSchema.optional(),
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
      type: z.literal("conversation.update"),
      payload: z
        .object({
          conversationId: z.string().uuid(),
          title: z.string().trim().min(1).max(120).optional(),
          providerId: providerIdSchema.optional(),
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
      type: z.enum(["conversation.archive", "conversation.unarchive", "conversation.delete"]),
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
          attachments: z.array(attachmentSchema).max(8).default([]),
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
          z.array(z.string().min(1).max(4_000)).min(1).max(5),
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
          showUsage: z.boolean().optional(),
          autoOpenPlan: z.boolean().optional(),
          confirmDestructiveActions: z.boolean().optional(),
          defaultReasoningEffort: z.string().trim().max(40).optional(),
          defaultInteractionMode: interactionModeSchema.optional(),
        })
        .strict(),
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
      type: z.literal("git.selection.revert"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid().optional(),
        fingerprint: z.string().regex(/^[0-9a-f]{8}$/u),
        filePath: z.string().min(1).max(4096),
        hunkId: z.string().min(1).max(128),
        lineIds: z.array(z.string().min(1).max(160)).min(1).max(500),
        comment: z.string().trim().max(2_000).optional(),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.summary.generate"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid(),
        fingerprint: z.string().regex(/^[0-9a-f]{8}$/u),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
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
      payload: z.object({ projectId: z.string().uuid(), conversationId: z.string().uuid().optional(), query: z.string().trim().max(256).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("workspace.file.read"),
      payload: z.object({ projectId: z.string().uuid(), conversationId: z.string().uuid().optional(), path: z.string().min(1).max(512) }).strict(),
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

export type ServerEvent =
  | { type: "server.welcome"; protocolVersion: typeof PROTOCOL_VERSION; snapshot: AppSnapshot }
  | { type: "request.ok"; requestId: string }
  | { type: "request.error"; requestId: string; message: string }
  | {
      type: "request.result";
      requestId: string;
      result:
        | { kind: "git.status"; status: GitStatusSnapshot }
        | { kind: "git.diff"; diff: GitDiffSnapshot }
        | { kind: "review.summary"; summary: DiffReviewSummary }
        | { kind: "git.branches"; branches: GitBranchInfo[] }
        | { kind: "workspace.entries"; entries: WorkspaceEntry[]; truncated: boolean }
        | { kind: "workspace.file"; file: WorkspaceFilePreview }
        | { kind: "project.actions"; actions: ProjectAction[] }
        | { kind: "worktree.created"; path: string; branch: string }
        | { kind: "git.action"; message: string }
        | { kind: "external.url"; url: string; label: string };
    }
  | { type: "snapshot.updated"; snapshot: AppSnapshot }
  | { type: "agent.started"; conversationId: string; runId: string }
  | { type: "agent.text"; conversationId: string; runId: string; text: string }
  | { type: "agent.reasoning"; conversationId: string; runId: string; text: string }
  | { type: "agent.usage"; usage: ThreadUsageSnapshot }
  | { type: "agent.activity"; activity: AgentActivity }
  | { type: "agent.approval.requested"; request: AgentApprovalRequest }
  | { type: "agent.approval.resolved"; conversationId: string; requestId: string; decision: "approve" | "deny" | "cancel" | "cancelled" }
  | { type: "agent.input.requested"; request: AgentInputRequest }
  | { type: "agent.input.resolved"; conversationId: string; requestId: string }
  | { type: "agent.plan.updated"; plan: AgentPlan }
  | { type: "agent.completed"; conversationId: string; runId: string }
  | { type: "agent.failed"; conversationId: string; runId: string; message: string }
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
  showUsage: true,
  autoOpenPlan: true,
  confirmDestructiveActions: true,
  defaultReasoningEffort: "",
  defaultInteractionMode: "build",
};
