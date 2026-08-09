import type { ClientCommand } from "@shared/contracts";
import {
  AGENT_WORKFLOW_REQUEST_TIMEOUT_MS,
  BACKEND_PROFILE_PROBE_REQUEST_TIMEOUT_MS,
  CONVERSATION_DETAIL_REQUEST_TIMEOUT_MS,
  DUO_CANCEL_REQUEST_TIMEOUT_MS,
  DUO_DISPATCH_REQUEST_TIMEOUT_MS,
  GIT_MUTATION_REQUEST_TIMEOUT_MS,
  GIT_READ_REQUEST_TIMEOUT_MS,
  GIT_REFRESH_REQUEST_TIMEOUT_MS,
  MESSAGE_SEND_REQUEST_TIMEOUT_MS,
  PROVIDER_MAINTENANCE_REFRESH_REQUEST_TIMEOUT_MS,
  PROVIDER_REFRESH_REQUEST_TIMEOUT_MS,
  REVIEW_OPERATION_REQUEST_TIMEOUT_MS,
  WORKSPACE_ENTRY_REQUEST_TIMEOUT_MS,
  WORKSPACE_FILE_MUTATION_REQUEST_TIMEOUT_MS,
  WORKSPACE_FILE_REQUEST_TIMEOUT_MS,
  WORKSPACE_GIT_REFRESH_REQUEST_TIMEOUT_MS,
} from "@shared/runtime-command-timeouts";
import type { RuntimeCommandDelivery } from "./connectionMessages";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const LONG_MUTATION_REQUEST_TIMEOUT_MS = 150_000;

export interface RuntimeCommandPolicy {
  timeoutMs: number;
  timeoutDelivery: Exclude<RuntimeCommandDelivery, "not-sent">;
}

const shortRetrySafe = {
  timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  timeoutDelivery: "rejected",
} as const satisfies RuntimeCommandPolicy;
const shortMutation = {
  timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  timeoutDelivery: "ambiguous",
} as const satisfies RuntimeCommandPolicy;
const longMutation = {
  timeoutMs: LONG_MUTATION_REQUEST_TIMEOUT_MS,
  timeoutDelivery: "ambiguous",
} as const satisfies RuntimeCommandPolicy;
const agentWorkflowRead = {
  timeoutMs: AGENT_WORKFLOW_REQUEST_TIMEOUT_MS,
  timeoutDelivery: "rejected",
} as const satisfies RuntimeCommandPolicy;
const gitRead = {
  timeoutMs: GIT_READ_REQUEST_TIMEOUT_MS,
  timeoutDelivery: "rejected",
} as const satisfies RuntimeCommandPolicy;
const gitMutation = {
  timeoutMs: GIT_MUTATION_REQUEST_TIMEOUT_MS,
  timeoutDelivery: "ambiguous",
} as const satisfies RuntimeCommandPolicy;
const workspaceEntryRead = {
  timeoutMs: WORKSPACE_ENTRY_REQUEST_TIMEOUT_MS,
  timeoutDelivery: "rejected",
} as const satisfies RuntimeCommandPolicy;
const workspaceFileRead = {
  timeoutMs: WORKSPACE_FILE_REQUEST_TIMEOUT_MS,
  timeoutDelivery: "rejected",
} as const satisfies RuntimeCommandPolicy;
const reviewOperation = {
  timeoutMs: REVIEW_OPERATION_REQUEST_TIMEOUT_MS,
  timeoutDelivery: "ambiguous",
} as const satisfies RuntimeCommandPolicy;

// Keep this total over ClientCommand["type"]. A new protocol command must
// choose its timeout and timeout-delivery semantics before TypeScript accepts
// it; it must never inherit a silent renderer default.
export const RUNTIME_COMMAND_POLICIES = {
  "activity.acknowledge": shortMutation,
  "activity.dismiss": shortMutation,
  "activity.mark-seen": shortMutation,
  "activity.stop": shortMutation,
  "agent.approval.respond": shortMutation,
  "agent.goal.clear": {
    timeoutMs: AGENT_WORKFLOW_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "ambiguous",
  },
  "agent.goal.set": {
    timeoutMs: AGENT_WORKFLOW_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "ambiguous",
  },
  "agent.input.respond": shortMutation,
  "agent.skills.list": agentWorkflowRead,
  "agent.stop": shortMutation,
  "agent.subagent.stop": shortMutation,
  "agent.workflow.load": agentWorkflowRead,
  "app.refresh": shortRetrySafe,
  "backend.default.clear": shortMutation,
  "backend.default.set": shortMutation,
  "backend.profile.create": shortMutation,
  "backend.profile.credential-revision": shortMutation,
  "backend.profile.delete": shortMutation,
  "backend.profile.get": shortRetrySafe,
  "backend.profile.probe": {
    timeoutMs: BACKEND_PROFILE_PROBE_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "ambiguous",
  },
  "backend.profile.update": shortMutation,
  "checkpoint.revert": longMutation,
  "conversation.archive": shortMutation,
  "conversation.create": gitMutation,
  "conversation.delete": gitMutation,
  "conversation.detail.load": {
    timeoutMs: CONVERSATION_DETAIL_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "rejected",
  },
  "conversation.detail.subscription": shortRetrySafe,
  "conversation.select": shortMutation,
  "conversation.settle": shortMutation,
  "conversation.unarchive": shortMutation,
  "conversation.unsettle": shortMutation,
  "conversation.update": shortMutation,
  "duo.acknowledge": shortMutation,
  "duo.comparison.cancel": shortMutation,
  "duo.comparison.retry": shortMutation,
  "duo.cancel": {
    timeoutMs: DUO_CANCEL_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "ambiguous",
  },
  "duo.dispatch": {
    timeoutMs: DUO_DISPATCH_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "ambiguous",
  },
  "duo.pending": shortRetrySafe,
  "duo.prepare": gitMutation,
  "duo.status": shortRetrySafe,
  "git.branch.create": gitMutation,
  "git.branch.switch": gitMutation,
  "git.branches": gitRead,
  "git.commit": gitMutation,
  "git.diff": gitRead,
  "git.pr.open": gitMutation,
  "git.pr.create": gitMutation,
  "git.pull": gitMutation,
  "git.push": gitMutation,
  "git.refresh": {
    timeoutMs: GIT_REFRESH_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "rejected",
  },
  "git.selection.inspect": gitMutation,
  "git.selection.revert": gitMutation,
  "git.selection.undo": gitMutation,
  "git.turn.compare": gitRead,
  "git.turn.diff": shortRetrySafe,
  "git.workspace.diff": gitRead,
  "git.workspace.refresh": {
    timeoutMs: WORKSPACE_GIT_REFRESH_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "rejected",
  },
  "git.worktree.create": gitMutation,
  "message.send": {
    // The server enforces one aggregate preparation deadline before it can
    // queue a turn. Keep the socket pending through that boundary and its
    // bounded rollback/attachment cleanup so a retry cannot duplicate work.
    timeoutMs: MESSAGE_SEND_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "ambiguous",
  },
  "project.action.run": shortMutation,
  "project.actions": shortRetrySafe,
  "project.create": shortMutation,
  "project.remove": shortMutation,
  "project.select": shortMutation,
  "project.update": shortMutation,
  "provider.auth.start": shortMutation,
  "provider.maintenance.cancel": shortMutation,
  "provider.maintenance.refresh": {
    timeoutMs: PROVIDER_MAINTENANCE_REFRESH_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "rejected",
  },
  "provider.maintenance.update": {
    timeoutMs: PROVIDER_MAINTENANCE_REFRESH_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "ambiguous",
  },
  "provider.refresh": {
    timeoutMs: PROVIDER_REFRESH_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "rejected",
  },
  "review.note.create": shortMutation,
  "review.note.delete": shortMutation,
  "review.note.update": shortMutation,
  "review.selection.ask": reviewOperation,
  "review.selection.revise": reviewOperation,
  "review.state.set": shortMutation,
  "review.summary.cancel": shortMutation,
  "review.summary.generate": reviewOperation,
  "settings.update": {
    timeoutMs: PROVIDER_REFRESH_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "ambiguous",
  },
  "terminal.close": shortMutation,
  "terminal.create": shortMutation,
  "terminal.input": shortMutation,
  "terminal.provider.resume": {
    timeoutMs: PROVIDER_REFRESH_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "ambiguous",
  },
  "terminal.resize": shortMutation,
  "workspace.entries": workspaceEntryRead,
  "workspace.file.read": workspaceFileRead,
  "workspace.file.write": {
    timeoutMs: WORKSPACE_FILE_MUTATION_REQUEST_TIMEOUT_MS,
    timeoutDelivery: "ambiguous",
  },
} as const satisfies Readonly<
  Record<ClientCommand["type"], RuntimeCommandPolicy>
>;

export function runtimeCommandPolicy(
  type: ClientCommand["type"],
): RuntimeCommandPolicy {
  return RUNTIME_COMMAND_POLICIES[type];
}

const WORKSPACE_GIT_COMPLETION_PUBLICATIONS = new Set<ClientCommand["type"]>([
  "git.branch.create",
  "git.branch.switch",
  "git.commit",
  "git.pr.open",
  "git.pr.create",
  "git.pull",
  "git.push",
  "git.selection.revert",
  "git.selection.undo",
  "git.worktree.create",
]);

export function publishesWorkspaceGitCompletion(
  type: ClientCommand["type"],
): boolean {
  return WORKSPACE_GIT_COMPLETION_PUBLICATIONS.has(type);
}
