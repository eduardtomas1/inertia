import type {
  AgentGoal,
  AgentWorkflowState,
  AgentSkillSummary,
} from "./agent-workflows";
import type {
  ModelBackendDefault,
  ModelBackendProfileDetail,
} from "../backend-profile-settings";
import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceStatus,
} from "../provider-maintenance";
import type { ProviderTerminalResumeDescriptor } from "../provider-terminal-resume";
import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  ChatMessage,
  ConversationCompactionResult,
  MessageSendAcceptance,
  SubagentTrace,
  ThreadUsageSnapshot,
} from "./agent";
import type {
  AppSnapshot,
  ConversationShell,
  RuntimeSyncCursor,
  WorkspaceRun,
} from "./app";
import type { ConversationDetailResult } from "./conversation-detail";
import type {
  DuoPendingResult,
  DuoPreparedResult,
  DuoStatusResult,
} from "./duo";
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
import type { UsageDashboard } from "./usage-dashboard";
import type { DailyWorkDashboard } from "./daily-work";
import type {
  ConversationContextPacket,
  ConversationContextSourceTranscript,
} from "../conversation-context";

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
  | {
      type: "conversation.shell.updated";
      conversation: ConversationShell;
      runs: WorkspaceRun[];
    }
  | {
      type: "workspace.git.invalidated";
      requestId: string;
      projectId: string;
      conversationId: string | null;
    }
  | { type: "conversation.detail.invalidated"; conversationId: string }
  | { type: "conversation.message.persisted"; message: ChatMessage }
  | { type: "provider.maintenance.updated"; providers: ProviderMaintenanceStatus[] }
  | { type: "provider.maintenance.operation"; operation: ProviderMaintenanceOperation }
  | { type: "agent.started"; conversationId: string; runId: string; turnId: string }
  | { type: "agent.text"; conversationId: string; runId: string; turnId: string; text: string }
  | { type: "agent.reasoning"; conversationId: string; runId: string; turnId: string; text: string }
  | { type: "agent.commentary.persisted"; message: ChatMessage }
  | { type: "agent.usage"; usage: ThreadUsageSnapshot }
  | { type: "agent.activity"; activity: AgentActivity }
  | { type: "agent.subagent.updated"; trace: SubagentTrace }
  | { type: "agent.approval.requested"; request: AgentApprovalRequest }
  | { type: "agent.approval.resolved"; conversationId: string; runId: string; turnId: string; requestId: string; decision: "approve" | "deny" | "cancel" | "cancelled" }
  | { type: "agent.input.requested"; request: AgentInputRequest }
  | { type: "agent.input.resolved"; conversationId: string; runId: string; turnId: string; requestId: string }
  | { type: "agent.plan.updated"; plan: AgentPlan }
  | { type: "agent.goal.updated"; goal: AgentGoal }
  | {
      type: "agent.goal.cleared";
      conversationId: string;
      source: AgentGoal["source"];
    }
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
        | {
            kind: "workspace.file";
            file: WorkspaceFilePreview;
            usedFallback: boolean;
          }
        | { kind: "project.actions"; actions: ProjectAction[] }
        | { kind: "project.created"; projectId: string }
        | { kind: "conversation.created"; conversationId: string }
        | { kind: "conversation.context.source"; source: ConversationContextSourceTranscript }
        | { kind: "conversation.context.packet"; packet: ConversationContextPacket }
        | MessageSendAcceptance
        | ConversationCompactionResult
        | DuoPreparedResult
        | DuoPendingResult
        | DuoStatusResult
        | { kind: "backend.profile"; profile: ModelBackendProfileDetail }
        | { kind: "backend.profile.probe"; profile: ModelBackendProfileDetail }
        | { kind: "backend.default"; value: ModelBackendDefault | null }
        | { kind: "provider.maintenance"; providers: ProviderMaintenanceStatus[] }
        | { kind: "provider.maintenance.operation"; operation: ProviderMaintenanceOperation }
        | { kind: "usage.dashboard"; dashboard: UsageDashboard }
        | { kind: "daily.work"; dashboard: DailyWorkDashboard }
        | { kind: "agent.workflow"; workflow: AgentWorkflowState }
        | {
            kind: "agent.skills";
            conversationId: string;
            skills: AgentSkillSummary[];
            skillDiscovery: AgentWorkflowState["skillDiscovery"];
          }
        | { kind: "git.action"; message: string }
        | { kind: "external.url"; url: string; label: string }
        | ConversationDetailResult;
    }
  | RuntimeMutationEvent
  | {
      type: "terminal.created";
      requestId: string;
      terminalId: string;
      providerResume?: ProviderTerminalResumeDescriptor;
    }
  | { type: "terminal.output"; terminalId: string; data: string }
  | { type: "terminal.exit"; terminalId: string; exitCode: number };
