import type {
  AppSnapshot,
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
  ProviderMaintenanceStatus,
} from "@shared/contracts";
import type { AppUpdateStatus } from "@shared/desktop";
import { PROVIDER_MAINTENANCE_PROVIDER_IDS } from "@shared/provider-maintenance";
import { agentRunStateForTurn, agentTurnStatusForRunState, isAgentRunTerminalState } from "@shared/run-state";
import type { UpdateEverythingPhase } from "../../utils/updateEverythingRun";

export interface UpdateEverythingProvider {
  providerId: ProviderMaintenanceProviderId;
  label: string;
  from: string | null;
  to: string | null;
}

export interface UpdateEverythingPlan {
  app: { from: string; to: string } | null;
  releasePageVersion: string | null;
  providers: readonly UpdateEverythingProvider[];
  runningChats: number;
  continuingChats: number;
  workspaceRuns: number;
}

function activeOperation(operation: ProviderMaintenanceOperation | undefined): boolean {
  return operation?.status === "queued" || operation?.status === "running";
}

function versionedUpdate(status: ProviderMaintenanceStatus): boolean {
  return status.versionStatus === "update-available";
}

function providerManagedUpdate(status: ProviderMaintenanceStatus): boolean {
  return status.installMethod === "provider-managed" && status.versionStatus === "unknown" && status.latestVersion === null;
}

function providerLabel(snapshot: AppSnapshot | null, providerId: ProviderMaintenanceProviderId): string {
  return snapshot?.settings.providerIdentityLabels?.[providerId]
    ?? snapshot?.providers.find(({ id }) => id === providerId)?.label
    ?? providerId;
}

function inAppUpdate(status: AppUpdateStatus | null): { from: string; to: string } | null {
  if (!status?.latestVersion || status.delivery !== "in-app" || status.installBlocker) return null;
  return status.state === "available" || status.state === "downloaded"
    ? { from: status.currentVersion, to: status.latestVersion }
    : null;
}

export function updateEverythingPlan({ snapshot, statuses, operations, appStatus }: {
  snapshot: AppSnapshot | null;
  statuses: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceStatus>;
  operations: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceOperation>;
  appStatus: AppUpdateStatus | null;
}): UpdateEverythingPlan | null {
  if (appStatus?.installBlocker || appStatus?.state === "downloading" || appStatus?.state === "installing") return null;
  const candidates = PROVIDER_MAINTENANCE_PROVIDER_IDS.flatMap((providerId) => {
    const status = statuses.get(providerId);
    return status && status.updateAvailability === "available" && !activeOperation(operations.get(providerId))
      && (versionedUpdate(status) || providerManagedUpdate(status)) ? [status] : [];
  });
  if (!candidates.some(versionedUpdate)) return null;
  const app = inAppUpdate(appStatus);
  const workspaceRuns = app ? (snapshot?.runs ?? []).filter((run) => run.kind !== "agent"
    && (run.status === "running" || run.status === "waiting")).length : 0;
  const restarts = app !== null && workspaceRuns === 0;
  const providerIds = new Set(candidates.map(({ providerId }) => providerId));
  let runningChats = 0;
  let continuingChats = 0;
  for (const conversation of snapshot?.conversations ?? []) {
    const turn = conversation.latestTurn;
    if (!turn || (!restarts && !providerIds.has(turn.providerId))) continue;
    const state = agentRunStateForTurn(turn);
    if (isAgentRunTerminalState(state)) continue;
    runningChats += 1;
    const status = agentTurnStatusForRunState(state);
    if ((status === "running" || status === "starting") && !conversation.pendingApproval && !conversation.pendingInput) {
      continuingChats += 1;
    }
  }
  return {
    app,
    releasePageVersion: appStatus?.delivery === "manual" && appStatus.state === "available" ? appStatus.latestVersion : null,
    providers: candidates.map((status) => ({
      providerId: status.providerId,
      label: providerLabel(snapshot, status.providerId),
      from: status.installedVersion,
      to: status.latestVersion,
    })),
    runningChats,
    continuingChats,
    workspaceRuns,
  };
}

export function updateEverythingProgress(
  phase: UpdateEverythingPhase,
  operations: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceOperation>,
  snapshot: AppSnapshot | null,
): string {
  if (phase.kind === "download") return "Downloading Inertia…";
  if (phase.kind === "app") return "Updating Inertia…";
  const current = phase.providerIds.find((providerId) => operations.get(providerId)?.status === "running")
    ?? phase.providerIds.find((providerId) => activeOperation(operations.get(providerId)))
    ?? phase.providerIds[0];
  return current ? `Updating ${providerLabel(snapshot, current)}…` : "Updating…";
}
