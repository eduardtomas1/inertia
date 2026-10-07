import type {
  ChatMessage,
  Conversation,
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
import { CONVERSATION_ATTACHMENT_GALLERY_LIMIT } from "@shared/conversation-attachment-gallery";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import {
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
  attachments: Array<Pick<ChatMessage["attachments"][number], "id" | "name" | "mimeType" | "size">>;
}

interface EnvironmentSummaryInput {
  projectId: string | null;
  conversationId: string | null;
  connectionStatus: ConnectionStatus;
  workspaceGitStatus: WorkspaceGitSnapshot | null;
  runs: readonly WorkspaceRun[];
  messages: readonly ChatMessage[];
  liveMessages?: readonly ChatMessage[];
  attachmentGallery?: EnvironmentSummarySnapshot["attachments"];
  gitError?: string | null;
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

function conversationRunOwnerLabel(
  conversation: Pick<Conversation, "title" | "branch" | "worktreePath">,
): string {
  const title = conversation.title.trim() || "Untitled chat";
  if (!conversation.worktreePath) return title;
  const worktreeLabel = conversation.branch?.trim()
    || conversation.worktreePath.split(/[\\/]/u).filter(Boolean).at(-1);
  return worktreeLabel ? `${title} (${worktreeLabel})` : title;
}

export const ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT = CONVERSATION_ATTACHMENT_GALLERY_LIMIT;

// Collecting the whole gallery costs a scan of the transcript, and the scene
// model rebuilds for reasons unrelated to messages. The result is memoized per
// message list, so the primary scene and every split pane keep their own
// stable array identity and nothing outlives the list it was computed from.
const attachmentGalleries = new WeakMap<
  readonly ChatMessage[],
  EnvironmentSummarySnapshot["attachments"]
>();

function recentAttachments(
  messages: readonly ChatMessage[],
): EnvironmentSummarySnapshot["attachments"] {
  const cached = attachmentGalleries.get(messages);
  if (cached) return cached;
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
      // The secure preview resolves this ID in main. Paths and snapshot context
      // remain excluded from the environment summary.
      attachments.push({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size });
      if (attachments.length === ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT) break;
    }
    if (attachments.length === ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT) break;
  }
  attachmentGalleries.set(messages, attachments);
  return attachments;
}

const liveAttachmentGalleries = new WeakMap<EnvironmentSummarySnapshot["attachments"],
  WeakMap<readonly ChatMessage[], EnvironmentSummarySnapshot["attachments"]>>();

function galleryWithLiveAttachments(gallery: EnvironmentSummarySnapshot["attachments"],
  liveMessages?: readonly ChatMessage[]): EnvironmentSummarySnapshot["attachments"] {
  if (!liveMessages?.length) return gallery;
  let cached = liveAttachmentGalleries.get(gallery);
  const previous = cached?.get(liveMessages);
  if (previous) return previous;
  const live = recentAttachments(liveMessages);
  if (!live.length) return gallery;
  const seen = new Set<string>();
  const merged = [...live, ...gallery].filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, CONVERSATION_ATTACHMENT_GALLERY_LIMIT);
  if (!cached) { cached = new WeakMap(); liveAttachmentGalleries.set(gallery, cached); }
  cached.set(liveMessages, merged);
  return merged;
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

export type WorkspaceSurfaceSummary = Pick<EnvironmentSummarySnapshot,
  "runtime" | "gitNotice" | "checks" | "localServers" | "usage" | "attachments"
>;

/** Only the projections used by current surfaces; legacy Environment rows stay off the chat route. */
export function buildWorkspaceSurfaceSummary({
  projectId, conversationId, connectionStatus, workspaceGitStatus, runs, messages, liveMessages, attachmentGallery,
  gitError = null, projects = [], conversations = [],
  visibleProjectIds: additionalVisibleProjectIds = [], usage = null,
  latestTurnId = null, usageProvider = null, usageIdentity = null,
  usageQuotaSource = "isolated",
}: EnvironmentSummaryInput): WorkspaceSurfaceSummary {
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
    right.startedAt.localeCompare(left.startedAt, "en")
    || right.id.localeCompare(left.id, "en"));
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
  return {
    runtime: { status: connectionStatus },
    gitNotice,
    checks,
    localServers,
    usage: usageSummary(usage, latestTurnId, usageProvider, usageIdentity, usageQuotaSource),
    attachments: attachmentGallery ? galleryWithLiveAttachments(attachmentGallery, liveMessages) : recentAttachments(messages),
  };
}
