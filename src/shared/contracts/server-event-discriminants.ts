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
