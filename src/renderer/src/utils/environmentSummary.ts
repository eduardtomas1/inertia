import type {
  ChatMessage,
  Conversation,
  GitStatusSnapshot,
  Project,
  ProviderInfo,
  ProviderRateLimit,
  SubagentTrace,
  ThreadUsageSnapshot,
  WorkspaceGitRepositorySnapshot,
  WorkspaceGitSnapshot,
  WorkspaceRun,
} from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import {
  headerGitActions,
  type HeaderGitAction,
} from "./headerGitActions";
import {
  contextUsageDisplayValue,
  contextUsageQualityForTurn,
  type ContextUsageDataQuality,
  type UsageQuotaSource,
} from "./usageDisplay";

export type EnvironmentRunItem = Pick<
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

export type EnvironmentSummaryCheck = EnvironmentRunItem;

export interface EnvironmentLocalServer extends EnvironmentRunItem {
  url: string;
}

export interface EnvironmentRepositorySummary {
  repositoryPath: string;
  state: WorkspaceGitRepositorySnapshot["state"];
  error: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  pullRequest: WorkspaceGitRepositorySnapshot["pullRequest"];
  files: number;
  insertions: number;
  deletions: number;
  clean: boolean;
  truncated: boolean;
  authorityRef: string | null;
  commitAction: HeaderGitAction | null;
  pushAction: HeaderGitAction | null;
}

export type EnvironmentUsageFreshness =
  | "current"
  | "stale"
  | "refreshing"
  | "unavailable";

export interface EnvironmentUsageSummary {
  providerId: string | null;
  providerLabel: string;
  context: {
    quality: ContextUsageDataQuality;
    remainingPercent: number | null;
    valueLabel: string;
    accessibleLabel: string;
    updatedAt: string | null;
  };
  quota: {
    freshness: EnvironmentUsageFreshness;
    source: UsageQuotaSource;
    updatedAt: string | null;
    limits: Array<Pick<
      ProviderRateLimit,
      "id" | "label" | "remainingPercent" | "windowMinutes" | "resetsAt"
    >>;
  };
}

export interface EnvironmentSummarySnapshot {
  projectName: string | null;
  workspace: {
    label: "Worktree" | "Project directory";
    value: string;
    path: string;
  } | null;
  openTarget: {
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
  gitState: "unknown" | "loading" | "ready" | "unavailable" | "error";
  gitNotice: string | null;
  branch: {
    label: "Branch" | "Branches";
    value: string;
  } | null;
  repositories: EnvironmentRepositorySummary[];
  checks: EnvironmentSummaryCheck[];
  localServers: EnvironmentLocalServer[];
  usage: EnvironmentUsageSummary | null;
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
  projectPath?: string | null;
  worktreePath?: string | null;
  gitLoading?: boolean;
  gitError?: string | null;
  gitBusy?: boolean;
  projects?: readonly Pick<Project, "id" | "name" | "path">[];
  conversations?: readonly Pick<
    Conversation,
    "id" | "projectId" | "title" | "branch" | "worktreePath"
  >[];
  visibleProjectIds?: readonly string[];
  usage?: ThreadUsageSnapshot | null;
  latestTurnId?: string | null;
  usageProvider?: Pick<
    ProviderInfo,
    "id" | "label" | "rateLimits" | "metadataState"
  > | null;
  usageIdentity?: {
    providerId: string | null;
    label: string;
  } | null;
  usageQuotaSource?: UsageQuotaSource;
}

function pathName(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

function conversationRunOwnerLabel(
  conversation: Pick<Conversation, "title" | "branch" | "worktreePath">,
): string {
  const title = conversation.title.trim() || "Untitled chat";
  if (!conversation.worktreePath) return title;
  const worktreeLabel = conversation.branch?.trim()
    || conversation.worktreePath.split(/[\\/]/u).filter(Boolean).at(-1);
  return worktreeLabel ? `${title} (${worktreeLabel})` : title;
}

function branchSummary(
  gitStatus: GitStatusSnapshot | null,
  workspaceGitStatus: WorkspaceGitSnapshot | null,
): EnvironmentSummarySnapshot["branch"] {
  const readyRepositories = workspaceGitStatus?.repositories
    .filter(({ state }) => state === "ready")
    ?? [];
  if (readyRepositories.length > 1) {
    return {
      label: "Branches",
      value: `${readyRepositories.length} repositories`,
    };
  }
  if (gitStatus?.isRepository) {
    return {
      label: "Branch",
      value: gitStatus.branch ?? "Detached HEAD",
    };
  }
  if (readyRepositories.length === 1) {
    return {
      label: "Branch",
      value: readyRepositories[0]!.branch ?? "Detached HEAD",
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

function repositorySummaries(
  gitStatus: GitStatusSnapshot | null,
  workspaceGitStatus: WorkspaceGitSnapshot | null,
  busy: boolean,
  mutationUnavailableDetail: string | null,
): EnvironmentRepositorySummary[] {
  const mutationAction = (
    actions: readonly HeaderGitAction[],
    id: "commit" | "push",
    authorityRef: string | null | undefined,
  ): HeaderGitAction | null => {
    const action = actions.find((candidate) => candidate.id === id) ?? null;
    if (!action) return null;
    if (mutationUnavailableDetail) {
      return {
        ...action,
        disabled: true,
        detail: mutationUnavailableDetail,
      };
    }
    if (authorityRef) return action;
    return {
      ...action,
      disabled: true,
      detail: "Scoped Git access is unavailable. Refresh the workspace before changing this repository.",
    };
  };
  if (workspaceGitStatus) {
    return workspaceGitStatus.repositories.map((repository) => {
      const actions = headerGitActions(repository.state === "ready" ? {
        isRepository: true,
        authorityRef: repository.authorityRef,
        root: null,
        branch: repository.branch,
        upstream: repository.upstream,
        ahead: repository.ahead,
        behind: repository.behind,
        hasRemote: repository.hasRemote,
        pullRequest: repository.pullRequest,
        files: repository.files,
        insertions: repository.insertions,
        deletions: repository.deletions,
      } : null, busy);
      return {
        repositoryPath: repository.repositoryPath,
        state: repository.state,
        error: repository.error,
        branch: repository.branch,
        upstream: repository.upstream,
        ahead: repository.ahead,
        behind: repository.behind,
        hasRemote: repository.hasRemote,
        pullRequest: repository.pullRequest,
        files: repository.files.length,
        insertions: repository.insertions,
        deletions: repository.deletions,
        clean: repository.clean,
        truncated: repository.truncated,
        authorityRef: repository.authorityRef ?? null,
        commitAction: mutationAction(actions, "commit", repository.authorityRef),
        pushAction: mutationAction(actions, "push", repository.authorityRef),
      };
    });
  }
  if (!gitStatus?.isRepository) return [];
  const actions = headerGitActions(gitStatus, busy);
  return [{
    repositoryPath: ".",
    state: "ready",
    error: null,
    branch: gitStatus.branch,
    upstream: gitStatus.upstream,
    ahead: gitStatus.ahead,
    behind: gitStatus.behind,
    hasRemote: gitStatus.hasRemote,
    pullRequest: gitStatus.pullRequest,
    files: gitStatus.files.length,
    insertions: gitStatus.insertions,
    deletions: gitStatus.deletions,
    clean: gitStatus.files.length === 0,
    truncated: false,
    authorityRef: gitStatus.authorityRef ?? null,
    commitAction: mutationAction(actions, "commit", gitStatus.authorityRef),
    pushAction: mutationAction(actions, "push", gitStatus.authorityRef),
  }];
}

function recentAttachments(
  messages: readonly ChatMessage[],
): EnvironmentSummarySnapshot["attachments"] {
  const seen = new Set<string>();
  const attachments: EnvironmentSummarySnapshot["attachments"] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    for (
      let attachmentIndex = message.attachments.length - 1;
      attachmentIndex >= 0;
      attachmentIndex -= 1
    ) {
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

function usageSummary(
  usage: ThreadUsageSnapshot | null | undefined,
  latestTurnId: string | null | undefined,
  provider: EnvironmentSummaryInput["usageProvider"],
  identity: EnvironmentSummaryInput["usageIdentity"],
  quotaSource: UsageQuotaSource,
): EnvironmentUsageSummary | null {
  if (!usage && !provider) return null;
  const contextQuality = contextUsageQualityForTurn(
    usage ?? null,
    latestTurnId ?? null,
  );
  const context = contextUsageDisplayValue(usage ?? null, contextQuality);
  const quotaState = provider?.metadataState.rateLimits;
  const freshness: EnvironmentUsageFreshness = quotaSource === "isolated"
    ? "unavailable"
    : quotaState?.refreshing
      ? "refreshing"
      : quotaState?.freshness === "fresh"
        ? "current"
        : quotaState?.freshness === "stale"
          ? "stale"
          : "unavailable";
  const limits = quotaSource === "selected-route"
    ? (provider?.rateLimits ?? []).filter((limit) =>
      Number.isFinite(limit.remainingPercent)
      && limit.remainingPercent >= 0
      && limit.remainingPercent <= 100)
    : [];
  return {
    providerId: identity ? identity.providerId : provider?.id ?? null,
    providerLabel: identity?.label ?? provider?.label ?? "Selected provider",
    context: {
      quality: context.quality,
      remainingPercent: context.remainingPercent,
      valueLabel: context.valueLabel,
      accessibleLabel: context.accessibleLabel,
      updatedAt: usage?.updatedAt ?? null,
    },
    quota: {
      freshness,
      source: quotaSource,
      updatedAt: quotaState?.updatedAt ?? null,
      limits,
    },
  };
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
  worktreePath = null,
  gitLoading = false,
  gitError = null,
  gitBusy = false,
  projects = [],
  conversations = [],
  visibleProjectIds: additionalVisibleProjectIds = [],
  usage = null,
  latestTurnId = null,
  usageProvider = null,
  usageIdentity = null,
  usageQuotaSource = "isolated",
}: EnvironmentSummaryInput): EnvironmentSummarySnapshot {
  const visibleProjectIds = new Set(additionalVisibleProjectIds);
  if (projectId) visibleProjectIds.add(projectId);
  const knownProjects = new Map(projects.map((project) => [project.id, project]));
  const projectNameCounts = new Map<string, number>();
  for (const { name } of projects) {
    projectNameCounts.set(name, (projectNameCounts.get(name) ?? 0) + 1);
  }
  const knownConversations = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  const projectsWithConversations = new Set(
    conversations.map(({ projectId: ownerProjectId }) => ownerProjectId),
  );
  const sortedRuns = [...runs].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt)
    || right.id.localeCompare(left.id));
  let passiveRows = 0;
  const visibleRuns = connectionStatus === "online" ? sortedRuns.filter((run) => {
    if (run.canStop) return true;
    if (!visibleProjectIds.has(run.projectId)) return false;
    if (workspaceRunPreviewUrl(run)) return true;
    if (passiveRows >= 3) return false;
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
  }) : [];
  const runItems = visibleRuns.map((run) => {
    const attention = workspaceRunAttentionView(run);
    const ownerConversation = run.conversationId
      ? knownConversations.get(run.conversationId)
      : undefined;
    const ownerProject = knownProjects.get(run.projectId);
    const routeKnown = ownerProject !== undefined
      && (
        run.conversationId === null
          ? projectsWithConversations.has(run.projectId)
          : ownerConversation?.projectId === run.projectId
      );
    return {
      run,
      previewUrl: workspaceRunPreviewUrl(run),
      item: {
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
            : ownerProject
              ? projectNameCounts.get(ownerProject.name) === 1
                ? ownerProject.name
                : `${ownerProject.name} (${ownerProject.path})`
              : "Unavailable project",
          run.conversationId
            && (run.canStop || run.conversationId !== conversationId)
            ? ownerConversation
              ? conversationRunOwnerLabel(ownerConversation)
              : "Unavailable conversation"
            : null,
          run.detail,
        ].filter((part): part is string => Boolean(part)).join(" · ") || null,
        canOpenPreview: routeKnown && workspaceRunPreviewUrl(run) !== null,
        canAcknowledge: attention.needsAttention && attention.canAcknowledge,
        canDismiss: attention.canDismiss,
      } satisfies EnvironmentRunItem,
    };
  });
  const localServers = runItems.flatMap(({ previewUrl, item }) =>
    previewUrl ? [{ ...item, url: previewUrl }] : []);
  const checks = runItems
    .filter(({ previewUrl }) => previewUrl === null)
    .map(({ item }) => item);
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
  const workspaceScanIncomplete = Boolean(
    workspaceGitStatus?.partial || workspaceGitStatus?.truncated,
  );
  const gitNotice = gitError
    ?? workspaceGitStatus?.issues[0]?.message
    ?? workspaceGitStatus?.repositories.find(({ state }) =>
      state === "error")?.error
    ?? (workspaceScanIncomplete
      ? "The repository scan did not inspect every directory."
      : null);
  const gitFailed = Boolean(
    workspaceScanIncomplete
    || workspaceGitStatus?.issues.length
    || workspaceGitStatus?.repositories.some(({ state }) => state === "error"),
  );
  const gitState: EnvironmentSummarySnapshot["gitState"] = gitLoading
    ? "loading"
    : gitError || (gitFailed && !changes)
      ? "error"
      : changes
        ? "ready"
        : gitStatus || workspaceGitStatus
          ? "unavailable"
          : "unknown";
  const repositories = repositorySummaries(
    gitStatus,
    workspaceGitStatus,
    gitBusy,
    gitLoading
      ? "Git data is refreshing. Wait for the current repository scan to finish."
      : gitError
        ? "Git data is unavailable. Refresh the workspace before changing this repository."
        : null,
  );
  const workspacePath = worktreePath ?? projectPath;
  return {
    projectName,
    workspace: workspacePath ? {
      label: worktreePath ? "Worktree" : "Project directory",
      value: pathName(workspacePath),
      path: workspacePath,
    } : null,
    openTarget: workspacePath ? {
      name: projectName ?? pathName(workspacePath),
      path: workspacePath,
    } : null,
    runtime: { status: connectionStatus },
    changes,
    gitState,
    gitNotice,
    branch: branchSummary(gitStatus, workspaceGitStatus),
    repositories,
    checks,
    localServers,
    usage: usageSummary(
      usage,
      latestTurnId,
      usageProvider,
      usageIdentity,
      usageQuotaSource,
    ),
    subagents: activeSubagents,
    attachments: recentAttachments(messages),
  };
}
