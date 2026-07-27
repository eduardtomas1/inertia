import type {
  ModelBackendDefault,
  ModelBackendProfileDetail,
} from "../backend-profile-settings";
import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceStatus,
} from "../provider-maintenance";
import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  SubagentTrace,
  ThreadUsageSnapshot,
} from "./agent";
import type {
  AppSnapshot,
  RuntimeSyncCursor,
} from "./app";
import type { ConversationDetailResult } from "./conversation-detail";
import type {
  DiffReversalOperation,
  DiffReversalPlan,
  DiffReviewSummary,
  DiffSelectionReviewAnswer,
  GitDiffSnapshot,
  GitStatusSnapshot,
  TurnGitDiffSnapshot,
  WorkspaceGitDiffSnapshot,
  WorkspaceGitSnapshot,
} from "./git";
import type {
  GitBranchInfo,
  ProjectAction,
  WorkspaceEntriesPage,
  WorkspaceFilePreview,
} from "./workspace";

export const PROTOCOL_VERSION = 1 as const;

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
  | {
      type: "server.welcome";
      protocolVersion: typeof PROTOCOL_VERSION;
      snapshot: AppSnapshot;
      sync?: RuntimeSyncCursor;
    }
  | {
      type: "runtime.resumed";
      protocolVersion: typeof PROTOCOL_VERSION;
      sync: RuntimeSyncCursor;
    }
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
