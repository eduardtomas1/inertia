import type {
  AgentActivity,
  AgentApprovalRequest,
  SubagentTraceStatus,
} from "./agent";
import type { AgentGoal } from "./agent-workflows";
import type {
  AccessMode,
  InteractionMode,
  ProjectStatus,
  ProviderAuthState,
  ProviderInstallState,
  ProviderMetadataFreshness,
  ProviderMetadataProvenance,
} from "./app";
import type { RuntimeEventScope, RuntimeMutationEvent } from "./events";
import type {
  ProviderMaintenanceFreshness,
  ProviderMaintenanceInstallMethod,
  ProviderMaintenanceOperationStatus,
  ProviderMaintenanceUpdateAvailability,
  ProviderMaintenanceVersionStatus,
} from "../provider-maintenance";
import { legacyProviderIdForHarness, type ModelSelection } from "../model-routing";
import {
  MAX_PROMPT_PRESETS,
  MAX_PROMPT_PRESETS_SERIALIZED_BYTES,
  promptPresetSchema,
  promptPresetsSerializedBytes,
  type PromptPreset,
} from "../prompt-presets";

function exhaustiveOptions<T extends string>(
  options: Record<T, true>,
): readonly T[] {
  return Object.keys(options) as T[];
}

export const SERVER_EVENT_OPTIONS = Object.freeze({
  accessModes: exhaustiveOptions<AccessMode>({
    supervised: true, "auto-edit": true, full: true,
  }),
  interactionModes: exhaustiveOptions<InteractionMode>({ build: true, plan: true }),
  projectStatuses: exhaustiveOptions<ProjectStatus>({
    ready: true, working: true, attention: true,
  }),
  providerInstallStates: exhaustiveOptions<ProviderInstallState>({
    checking: true, installed: true, "not-installed": true, error: true,
  }),
  providerAuthStates: exhaustiveOptions<ProviderAuthState>({
    checking: true, authenticated: true, unauthenticated: true,
    configured: true, unknown: true, error: true,
  }),
  providerMetadataFreshness: exhaustiveOptions<ProviderMetadataFreshness>({
    unavailable: true, fresh: true, stale: true,
  }),
  providerMetadataProvenance: exhaustiveOptions<ProviderMetadataProvenance>({
    provider: true, session: true, "persistent-cache": true,
  }),
  activityKinds: exhaustiveOptions<AgentActivity["kind"]>({
    status: true, tool: true, command: true, file: true,
    reasoning: true, error: true,
  }),
  activityStatuses: exhaustiveOptions<AgentActivity["status"]>({
    running: true, completed: true, failed: true,
  }),
  subagentStatuses: exhaustiveOptions<SubagentTraceStatus>({
    queued: true, spawned: true, running: true, waiting: true,
    completed: true, failed: true, cancelled: true, interrupted: true,
    unknown: true, lost: true,
  }),
  approvalKinds: exhaustiveOptions<AgentApprovalRequest["kind"]>({
    command: true, "file-change": true, permissions: true,
  }),
  approvalNetworkProtocols: exhaustiveOptions<
    NonNullable<AgentApprovalRequest["networkScope"]>["protocol"]
  >({ http: true, https: true, socks5Tcp: true, socks5Udp: true }),
  approvalPermissionAccess: exhaustiveOptions<
    AgentApprovalRequest["permissionRoots"][number]["access"]
  >({ read: true, write: true }),
  goalSources: exhaustiveOptions<AgentGoal["source"]>({
    "codex-native": true, "inertia-local": true,
  }),
  maintenanceVersionStatuses: exhaustiveOptions<ProviderMaintenanceVersionStatus>({
    checking: true, current: true, "update-available": true,
    unknown: true, "not-installed": true,
  }),
  maintenanceFreshness: exhaustiveOptions<ProviderMaintenanceFreshness>({
    fresh: true, stale: true, unavailable: true,
  }),
  maintenanceInstallMethods: exhaustiveOptions<ProviderMaintenanceInstallMethod>({
    "provider-managed": true, "npm-global": true, homebrew: true,
    manual: true, unknown: true,
  }),
  maintenanceUpdateAvailability:
    exhaustiveOptions<ProviderMaintenanceUpdateAvailability>({
      available: true, "instructions-only": true, unavailable: true,
    }),
  maintenanceOperationStatuses:
    exhaustiveOptions<ProviderMaintenanceOperationStatus>({
      queued: true, running: true, succeeded: true, unchanged: true,
      failed: true, cancelled: true,
    }),
});

type IdentityRecord = Record<string, unknown>;

function uniqueIdentity(entries: IdentityRecord[], key = "id"): boolean {
  return new Set(entries.map((entry) => entry[key])).size === entries.length;
}

function promptPresetCollectionCoherent(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_PROMPT_PRESETS) return false;
  const parsed = value.map((entry) => promptPresetSchema.safeParse(entry));
  if (parsed.some((result) => !result.success)) return false;
  const presets = parsed.flatMap((result) => result.success
    ? [result.data]
    : []);
  return new Set(presets.map(({ id }) => id)).size === presets.length
    && new Set(presets.map(({ position }) => position)).size === presets.length
    && presets.every(({ position }, index) => position === index)
    && promptPresetsSerializedBytes(presets as PromptPreset[])
      <= MAX_PROMPT_PRESETS_SERIALIZED_BYTES;
}

const CONVERSATION_DETAIL_SCOPED_COLLECTIONS = [
  "agentTurns", "turnGitArtifacts", "messages", "activities", "subagents",
  "reasonings", "usage", "plans", "goals", "checkpoints", "reviewSummaries",
  "reviewStates", "reviewNotes",
] as const;

const CONVERSATION_DETAIL_ID_COLLECTIONS = [
  "agentTurns", "turnGitArtifacts", "messages", "activities", "subagents",
  "reasonings", "checkpoints", "reviewNotes",
] as const;

const CONVERSATION_DETAIL_TURN_RUN_COLLECTIONS = [
  "activities", "subagents", "reasonings", "plans",
] as const;

export function conversationDetailCollectionsCoherent(
  value: IdentityRecord,
  conversationId: string,
): boolean {
  const turns = value.agentTurns as IdentityRecord[];
  const artifacts = value.turnGitArtifacts as IdentityRecord[];
  const subagents = value.subagents as IdentityRecord[];
  const usage = value.usage as IdentityRecord[];
  const plans = value.plans as IdentityRecord[];
  const goals = value.goals as IdentityRecord[];
  const reviewSummaries = value.reviewSummaries as IdentityRecord[];
  const reviewStates = value.reviewStates as IdentityRecord[];
  const messagesById = new Map((value.messages as IdentityRecord[])
    .map((message) => [message.id, message]));
  const checkpointsById = new Map((value.checkpoints as IdentityRecord[])
    .map((checkpoint) => [checkpoint.id, checkpoint]));
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
  const providerIdentityUnique = (key: "providerTaskId" | "providerAgentId") => {
    const identified = subagents.filter((trace) => trace[key] !== null);
    return new Set(identified.map((trace) => JSON.stringify([
      trace.runId, trace.providerId, trace[key],
    ]))).size === identified.length;
  };
  const reviewStateKeys = reviewStates.map((state) => JSON.stringify([
    state.repositoryPath ?? ".", state.scope, state.path, state.hunkId ?? "",
  ]));
  return CONVERSATION_DETAIL_SCOPED_COLLECTIONS.every((key) =>
    (value[key] as IdentityRecord[]).every((entry) =>
      entry.conversationId === conversationId))
    && CONVERSATION_DETAIL_ID_COLLECTIONS.every((key) =>
      uniqueIdentity(value[key] as IdentityRecord[]))
    && uniqueIdentity(turns, "runId")
    && usage.length <= 1
    && uniqueIdentity(plans, "runId")
    && uniqueIdentity(goals, "source")
    && reviewSummaries.length <= 1
    && new Set(reviewStateKeys).size === reviewStateKeys.length
    && providerIdentityUnique("providerTaskId")
    && providerIdentityUnique("providerAgentId")
    && CONVERSATION_DETAIL_TURN_RUN_COLLECTIONS.every((key) =>
      (value[key] as IdentityRecord[]).every((entry) => entry.turnId === null
        || turnsById.get(entry.turnId)?.runId === entry.runId))
    && turns.every((turn) => {
      const userMessage = messagesById.get(turn.userMessageId);
      const terminalMessage = turn.terminalAssistantMessageId === null
        ? null : messagesById.get(turn.terminalAssistantMessageId);
      const checkpoint = turn.checkpointId === null
        ? null : checkpointsById.get(turn.checkpointId);
      return userMessage?.role === "user" && userMessage.turnId === turn.id
        && (terminalMessage === null
          || (terminalMessage?.role === "assistant" && terminalMessage.turnId === turn.id))
        && (checkpoint === null || checkpoint?.turnId === turn.id);
    })
    && uniqueIdentity(artifacts, "turnId")
    && artifacts.every((artifact) =>
      turnsById.get(artifact.turnId)?.runId === artifact.runId);
}

export function snapshotIdentityCollectionsCoherent(value: IdentityRecord): boolean {
  const projects = value.projects as IdentityRecord[];
  const conversations = value.conversations as IdentityRecord[];
  const runs = value.runs as IdentityRecord[];
  const providers = value.providers as IdentityRecord[];
  const operations = (value.maintenanceOperations ?? []) as IdentityRecord[];
  const profiles = (value.backendProfiles ?? []) as IdentityRecord[];
  const defaults = (value.backendDefaults ?? []) as IdentityRecord[];
  const projectIds = new Set(projects.map((project) => project.id));
  const conversationProjects = new Map(conversations.map((conversation) => [
    conversation.id, conversation.projectId,
  ]));
  const defaultKeys = defaults.map((entry) => `${String(entry.scope)}:${String(entry.projectId)}`);
  return uniqueIdentity(projects)
    && uniqueIdentity(conversations)
    && uniqueIdentity(runs)
    && uniqueIdentity(providers)
    && uniqueIdentity(operations)
    && uniqueIdentity(profiles)
    && new Set(defaultKeys).size === defaultKeys.length
    && conversations.every((conversation) => projectIds.has(conversation.projectId))
    && runs.every((run) => projectIds.has(run.projectId)
      && (run.conversationId === null
        || conversationProjects.get(run.conversationId) === run.projectId))
    && defaults.every((entry) => entry.scope !== "project" || projectIds.has(entry.projectId))
    && (value.activeProjectId === null || projectIds.has(value.activeProjectId))
    && (value.activeConversationId === null
      || conversationProjects.get(value.activeConversationId) === value.activeProjectId)
    && promptPresetCollectionCoherent(value.promptPresets);
}

export function pullRequestCapabilityStateCoherent(
  value: IdentityRecord,
  isRepository: boolean,
  hasRemote: boolean,
  branch: string | null,
): boolean {
  const remoteName = value.remoteName as string | null;
  const reason = value.unavailableReason as string | null;
  if (value.available) {
    return remoteName !== null && remoteName.length > 0
      && value.forge !== null && reason === null && hasRemote
      && branch !== null && branch.length > 0;
  }
  if (value.forge !== null || reason === null) return false;
  const reasonHasSelectedRemote = !["no-branch", "no-remotes", "ambiguous-remote"].includes(reason);
  if ((remoteName !== null && remoteName.length === 0)
    || (remoteName !== null) !== reasonHasSelectedRemote) return false;
  if (reason === "no-branch") return branch === null;
  if (reason === "no-remotes" && !isRepository) return branch === null && !hasRemote;
  return branch !== null && branch.length > 0 && hasRemote === (reason !== "no-remotes");
}

export function modelRouteIdentityCoherent(value: IdentityRecord): boolean {
  const selection = value.modelSelection as ModelSelection;
  const projectedProvider = legacyProviderIdForHarness(selection.harnessId);
  if (projectedProvider !== null && projectedProvider !== value.providerId) return false;
  if (value.harnessId !== undefined && value.harnessId !== selection.harnessId) return false;
  if (value.backendProfileId !== undefined
    && value.backendProfileId !== selection.backendProfileId) return false;
  const identity = value.continuationIdentity as IdentityRecord | null | undefined;
  if (identity != null && !(identity.harnessId === selection.harnessId
      && identity.backendProfileId === selection.backendProfileId
      && identity.backendConfigurationRevision === selection.backendConfigurationRevision
      && (identity.modelIdentity === null || identity.modelIdentity === selection.modelId))) return false;
  if (value.model !== undefined
    && value.model !== selection.modelId
    && !(selection.modelId === "provider-default" && value.model === "")) return false;
  if (value.modelAlias !== undefined && value.modelAlias !== selection.alias) return false;
  if (value.reasoningEffort !== undefined
    && value.reasoningEffort !== (selection.reasoningEffort ?? "")) return false;
  return value.configurationRevision === undefined
    || value.configurationRevision === selection.backendConfigurationRevision;
}

function mutationConversationId(event: RuntimeMutationEvent): string | null {
  switch (event.type) {
    case "snapshot.updated":
    case "conversation.shell.updated":
    case "workspace.git.invalidated":
    case "provider.maintenance.updated":
    case "provider.maintenance.operation":
      return null;
    case "conversation.detail.invalidated":
    case "agent.started":
    case "agent.text":
    case "agent.reasoning":
    case "agent.approval.resolved":
    case "agent.input.resolved":
    case "agent.goal.cleared":
    case "agent.completed":
    case "agent.failed":
      return event.conversationId;
    case "conversation.message.persisted":
    case "agent.commentary.persisted":
      return event.message.conversationId;
    case "agent.usage":
      return event.usage.conversationId;
    case "agent.activity":
      return event.activity.conversationId;
    case "agent.subagent.updated":
      return event.trace.conversationId;
    case "agent.approval.requested":
    case "agent.input.requested":
      return event.request.conversationId;
    case "agent.plan.updated":
      return event.plan.conversationId;
    case "agent.goal.updated":
      return event.goal.conversationId;
  }
}

export function runtimeEventScopeMatches(
  scope: unknown,
  event: RuntimeMutationEvent,
): scope is RuntimeEventScope {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    return false;
  }
  const candidate = scope as Record<string, unknown>;
  const conversationId = mutationConversationId(event);
  return conversationId === null
    ? candidate.kind === "shell"
    : candidate.kind === "conversation-detail"
      && candidate.conversationId === conversationId;
}
