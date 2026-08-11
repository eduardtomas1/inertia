import type {
  ChatMessage,
  Conversation,
  GitStatusSnapshot,
  Project,
  SubagentTrace,
  WorkspaceGitSnapshot,
  WorkspaceRun,
} from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";

export type EnvironmentSummaryCheck = Pick<
  WorkspaceRun,
  | "id"
  | "kind"
  | "projectId"
  | "conversationId"
  | "label"
  | "status"
  | "canStop"
  | "port"
> & {
  contextLabel: string | null;
  canOpenPreview: boolean;
  canAcknowledge: boolean;
  canDismiss: boolean;
};

export interface EnvironmentSummarySnapshot {
  projectName: string | null;
  runtime: {
    status: ConnectionStatus;
    label: string;
  };
  changes: {
    files: number;
    insertions: number;
    deletions: number;
    repositories: number;
  } | null;
  branch: {
    label: "Branch" | "Branches";
    value: string;
  } | null;
  checks: EnvironmentSummaryCheck[];
  subagents: Array<Pick<
    SubagentTrace,
    "id" | "providerName" | "providerRole" | "status"
  >>;
  attachments: Array<{
    id: string;
    name: string;
    mimeType: ChatMessage["attachments"][number]["mimeType"];
  }>;
}

interface EnvironmentSummaryInput {
  projectId: string | null;
  projectName: string | null;
  conversationId: string | null;
  connectionStatus: ConnectionStatus;
  gitStatus: GitStatusSnapshot | null;
  workspaceGitStatus: WorkspaceGitSnapshot | null;
  runs: readonly WorkspaceRun[];
  subagents: readonly SubagentTrace[];
  messages: readonly ChatMessage[];
  projects?: readonly Pick<Project, "id" | "name">[];
  conversations?: readonly Pick<Conversation, "id" | "projectId">[];
  visibleProjectIds?: readonly string[];
}

function runtimeLabel(status: ConnectionStatus): string {
  if (status === "online") return "Ready";
  if (status === "connecting") return "Connecting";
  return "Offline";
}

function branchSummary(
  gitStatus: GitStatusSnapshot | null,
  workspaceGitStatus: WorkspaceGitSnapshot | null,
): EnvironmentSummarySnapshot["branch"] {
  if (gitStatus?.isRepository && gitStatus.branch) {
    return { label: "Branch", value: gitStatus.branch };
  }
  const branches = new Set(
    workspaceGitStatus?.repositories
      .filter(({ state, branch }) => state === "ready" && branch)
      .map(({ branch }) => branch!)
      ?? [],
  );
  if (branches.size === 1) {
    return { label: "Branch", value: [...branches][0]! };
  }
  if (branches.size > 1) {
    return { label: "Branches", value: `${branches.size} active` };
  }
  return null;
}

function changesSummary(
  gitStatus: GitStatusSnapshot | null,
  workspaceGitStatus: WorkspaceGitSnapshot | null,
): EnvironmentSummarySnapshot["changes"] {
  if (workspaceGitStatus) {
    return {
      files: workspaceGitStatus.files,
      insertions: workspaceGitStatus.insertions,
      deletions: workspaceGitStatus.deletions,
      repositories: workspaceGitStatus.repositories.length,
    };
  }
  if (!gitStatus?.isRepository) return null;
  return {
    files: gitStatus.files.length,
    insertions: gitStatus.insertions,
    deletions: gitStatus.deletions,
    repositories: 1,
  };
}

function recentAttachments(
  messages: readonly ChatMessage[],
): EnvironmentSummarySnapshot["attachments"] {
  const seen = new Set<string>();
  const attachments: EnvironmentSummarySnapshot["attachments"] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    for (let attachmentIndex = message.attachments.length - 1; attachmentIndex >= 0; attachmentIndex -= 1) {
      const attachment = message.attachments[attachmentIndex]!;
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      attachments.push({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
      if (attachments.length === 3) return attachments;
    }
  }
  return attachments;
}

export function workspaceRunPreviewUrl(
  run: Pick<WorkspaceRun, "kind" | "status" | "port">,
): string | null {
  if (
    run.kind !== "service"
    || (run.status !== "running" && run.status !== "waiting")
    || run.port === null
    || !Number.isSafeInteger(run.port)
    || run.port < 1
    || run.port > 65_535
  ) {
    return null;
  }
  return `http://127.0.0.1:${run.port}`;
}

export function buildEnvironmentSummary({
  projectId,
  projectName,
  conversationId,
  connectionStatus,
  gitStatus,
  workspaceGitStatus,
  runs,
  subagents,
  messages,
  projects = [],
  conversations = [],
  visibleProjectIds: additionalVisibleProjectIds = [],
}: EnvironmentSummaryInput): EnvironmentSummarySnapshot {
  const visibleProjectIds = new Set(additionalVisibleProjectIds);
  if (projectId) visibleProjectIds.add(projectId);
  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const knownConversations = new Map(
    conversations.map(({ id, projectId: ownerProjectId }) => [
      id,
      ownerProjectId,
    ]),
  );
  const projectsWithConversations = new Set(
    conversations.map(({ projectId: ownerProjectId }) => ownerProjectId),
  );
  let passiveRows = 0;
  const checks = [...runs]
    .sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt)
      || right.id.localeCompare(left.id))
    .filter((run) => {
      if (run.canStop) return true;
      if (!visibleProjectIds.has(run.projectId) || passiveRows >= 3) {
        return false;
      }
      const attention = workspaceRunAttentionView(run);
      if (
        run.status !== "running"
        && run.status !== "waiting"
        && !attention.needsAttention
      ) {
        return false;
      }
      passiveRows += 1;
      return true;
    })
    .map((run): EnvironmentSummaryCheck => {
      const attention = workspaceRunAttentionView(run);
      const routeKnown = projectNames.has(run.projectId)
        && (
          run.conversationId === null
            ? projectsWithConversations.has(run.projectId)
            : knownConversations.get(run.conversationId) === run.projectId
        );
      return {
        id: run.id,
        kind: run.kind,
        projectId: run.projectId,
        conversationId: run.conversationId,
        label: run.label,
        status: run.status,
        canStop: run.canStop,
        port: run.port,
        contextLabel: [
          run.projectId === projectId
            ? null
            : projectNames.get(run.projectId) ?? "Unavailable project",
          run.detail,
        ].filter((part): part is string => Boolean(part)).join(" · ") || null,
        canOpenPreview: routeKnown && workspaceRunPreviewUrl(run) !== null,
        canAcknowledge:
          attention.needsAttention && attention.canAcknowledge,
        canDismiss: attention.canDismiss,
      };
    });
  const activeSubagents = conversationId
    ? subagents
      .filter((trace) =>
        trace.conversationId === conversationId
        && trace.isLive)
      .slice(-3)
      .map(({ id, providerName, providerRole, status }) => ({
        id,
        providerName,
        providerRole,
        status,
      }))
    : [];

  return {
    projectName,
    runtime: {
      status: connectionStatus,
      label: runtimeLabel(connectionStatus),
    },
    changes: changesSummary(gitStatus, workspaceGitStatus),
    branch: branchSummary(gitStatus, workspaceGitStatus),
    checks,
    subagents: activeSubagents,
    attachments: recentAttachments(messages),
  };
}
