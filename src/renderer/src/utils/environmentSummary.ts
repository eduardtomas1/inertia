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
  checks: Array<Pick<WorkspaceRun, "id" | "label" | "status">>;
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
}: EnvironmentSummaryInput): EnvironmentSummarySnapshot {
  const checks = projectId
    ? runs
      .filter((run) =>
        run.projectId === projectId
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
      .slice(0, 3)
      .map(({ id, label, status }) => ({ id, label, status }))
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
