import type {
  ChatMessage,
  GitStatusSnapshot,
  SubagentTrace,
  WorkspaceGitSnapshot,
  WorkspaceRun,
} from "@shared/contracts";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";

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
  checks: Array<Pick<
    WorkspaceRun,
    "id" | "label" | "status" | "canStop"
  > & { contextLabel: string | null }>;
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
  relatedProjects?: readonly { id: string; name: string }[];
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
  relatedProjects = [],
}: EnvironmentSummaryInput): EnvironmentSummarySnapshot {
  const visibleProjectIds = new Set(
    projectId ? [projectId, ...relatedProjects.map(({ id }) => id)] : [],
  );
  const relatedProjectNames = new Map(
    relatedProjects.map(({ id, name }) => [id, name]),
  );
  const checks = projectId
    ? runs
      .filter((run) =>
        visibleProjectIds.has(run.projectId)
        && (
          run.status === "running"
          || run.status === "waiting"
          || (
            run.status === "failed"
            && run.attentionState !== "acknowledged"
            && run.attentionState !== "dismissed"
          )
        ))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .reduce<WorkspaceRun[]>((visible, run) => {
        if (run.canStop || visible.length < 3) visible.push(run);
        return visible;
      }, [])
      .map(({ id, projectId: runProjectId, label, detail, status, canStop }) => ({
        id,
        label,
        status,
        canStop,
        contextLabel: [
          runProjectId === projectId
            ? null
            : relatedProjectNames.get(runProjectId) ?? "Split project",
          detail,
        ].filter((part): part is string => Boolean(part)).join(" · ") || null,
      }))
    : [];
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
