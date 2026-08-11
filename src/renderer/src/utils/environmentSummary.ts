import type {
  ChatMessage,
  GitStatusSnapshot,
  SubagentTrace,
  WorkspaceGitSnapshot,
  WorkspaceRun,
} from "@shared/contracts";
import { isLiteralLoopbackHost } from "@shared/preview-url";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";

export interface EnvironmentSummarySnapshot {
  projectName: string | null;
  workspace: {
    label: "Worktree" | "Project directory";
    value: string;
    path: string;
  } | null;
  repository: {
    name: string;
    path: string;
  } | null;
  runtime: {
    status: ConnectionStatus;
  };
  changes: {
    files: number;
    insertions: number;
    deletions: number;
    repositories: number;
  } | null;
  gitState: "loading" | "ready" | "unavailable" | "error";
  gitNotice: string | null;
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
  localServers: Array<{ url: string }>;
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
  projectPath?: string | null;
  repositoryRoot?: string | null;
  worktreePath?: string | null;
  localServerUrl?: string | null;
  gitLoading?: boolean;
  gitError?: string | null;
}

function pathName(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

function localServerSummary(url: string | null | undefined): EnvironmentSummarySnapshot["localServers"] {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    if (
      !isLiteralLoopbackHost(parsed.hostname)
      || (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    ) {
      return [];
    }
    return [{ url: parsed.origin }];
  } catch {
    return [];
  }
}

function branchSummary(
  gitStatus: GitStatusSnapshot | null,
  workspaceGitStatus: WorkspaceGitSnapshot | null,
): EnvironmentSummarySnapshot["branch"] {
  if (gitStatus?.isRepository) {
    return {
      label: "Branch",
      value: gitStatus.branch ?? "Detached HEAD",
    };
  }
  const readyRepositories = workspaceGitStatus?.repositories
    .filter(({ state }) => state === "ready")
    ?? [];
  if (readyRepositories.length === 1) {
    return {
      label: "Branch",
      value: readyRepositories[0]!.branch ?? "Detached HEAD",
    };
  }
  const branches = new Set(
    readyRepositories
      .filter(({ branch }) => branch)
      .map(({ branch }) => branch!)
  );
  if (branches.size === 1 && readyRepositories.every(({ branch }) => branch)) {
    return { label: "Branch", value: [...branches][0]! };
  }
  if (readyRepositories.length > 1) {
    return {
      label: "Branches",
      value: `${readyRepositories.length} repositories`,
    };
  }
  return null;
}

function changesSummary(
  gitStatus: GitStatusSnapshot | null,
  workspaceGitStatus: WorkspaceGitSnapshot | null,
): EnvironmentSummarySnapshot["changes"] {
  if (workspaceGitStatus) {
    const readyRepositories = workspaceGitStatus.repositories.filter(
      ({ state }) => state === "ready",
    ).length;
    if (readyRepositories > 0) {
      return {
        files: workspaceGitStatus.files,
        insertions: workspaceGitStatus.insertions,
        deletions: workspaceGitStatus.deletions,
        repositories: readyRepositories,
      };
    }
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
  projectPath = null,
  repositoryRoot = null,
  worktreePath = null,
  localServerUrl = null,
  gitLoading = false,
  gitError = null,
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

  const changes = changesSummary(gitStatus, workspaceGitStatus);
  const gitNotice = gitError
    ?? workspaceGitStatus?.issues[0]?.message
    ?? workspaceGitStatus?.repositories.find(({ state }) =>
      state === "error")?.error
    ?? null;
  const gitFailed = Boolean(
    workspaceGitStatus?.issues.length
    || workspaceGitStatus?.repositories.some(({ state }) => state === "error"),
  );
  const workspacePath = worktreePath ?? projectPath;
  return {
    projectName,
    workspace: workspacePath ? {
      label: worktreePath ? "Worktree" : "Project directory",
      value: pathName(workspacePath),
      path: workspacePath,
    } : null,
    repository: repositoryRoot ? {
      name: pathName(repositoryRoot),
      path: repositoryRoot,
    } : null,
    runtime: {
      status: connectionStatus,
    },
    changes,
    gitState: gitLoading
      ? "loading"
      : gitError || (gitFailed && !changes)
        ? "error"
        : changes
          ? "ready"
          : "unavailable",
    gitNotice,
    branch: branchSummary(gitStatus, workspaceGitStatus),
    checks,
    subagents: activeSubagents,
    attachments: recentAttachments(messages),
    localServers: localServerSummary(localServerUrl),
  };
}
