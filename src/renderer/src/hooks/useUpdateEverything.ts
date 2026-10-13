import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AppSnapshot,
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
  ProviderMaintenanceStatus,
  ServerEvent,
} from "@shared/contracts";
import type { UpdatesRunResult } from "@shared/contracts/client-command/updates";
import type { AppUpdateStatus } from "@shared/desktop";
import { PROVIDER_MAINTENANCE_PROVIDER_IDS } from "@shared/provider-maintenance";
import { agentRunStateForTurn, isAgentRunTerminalState } from "@shared/run-state";
import type { CommandWithoutId } from "../lib/runtimeCommands";

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
}

export interface UpdateEverythingRequest {
  providerIds: ProviderMaintenanceProviderId[];
  includeApp: boolean;
  continueChats: boolean;
}

export interface UpdateEverythingController {
  plan: UpdateEverythingPlan | null;
  progress: string | null;
  error: string | null;
  run: (request: UpdateEverythingRequest) => Promise<void>;
  dismissError: () => void;
}

type Phase = { kind: "providers"; providerIds: readonly ProviderMaintenanceProviderId[] } | { kind: "app" };

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
  const providerIds = new Set(candidates.map(({ providerId }) => providerId));
  let runningChats = 0;
  let continuingChats = 0;
  for (const conversation of snapshot?.conversations ?? []) {
    const turn = conversation.latestTurn;
    if (!turn || (!app && !providerIds.has(turn.providerId))) continue;
    const state = agentRunStateForTurn(turn);
    if (isAgentRunTerminalState(state)) continue;
    runningChats += 1;
    if ((state === "running" || state === "starting") && !conversation.pendingApproval && !conversation.pendingInput) {
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
  };
}

function updatesRunResult(event: ServerEvent): UpdatesRunResult {
  if (event.type !== "request.result" || event.result.kind !== "updates.run") {
    throw new Error("The local service returned an unexpected response.");
  }
  return event.result;
}

async function settledDownload(status: AppUpdateStatus): Promise<AppUpdateStatus> {
  if (status.state !== "downloading") return status;
  return await new Promise((resolve) => {
    const unsubscribe = window.inertia.onAppUpdateStatus((next) => {
      if (next.state === "downloading") return;
      unsubscribe();
      resolve(next);
    });
  });
}

async function invoke(action: () => Promise<AppUpdateStatus>, message: string): Promise<AppUpdateStatus> {
  try {
    return await action();
  } catch {
    throw new Error(message);
  }
}

async function installApp(status: AppUpdateStatus | null): Promise<boolean> {
  if (status?.state === "available") {
    const started = await invoke(() => window.inertia.downloadAppUpdate(), "The update download could not be started.");
    if ((await settledDownload(started)).state !== "downloaded") return false;
  } else if (status?.state !== "downloaded") {
    return false;
  }
  const result = await invoke(() => window.inertia.installAppUpdate(), "The update restart could not be started safely.");
  return result.state === "installing" && result.installBlocker === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The update could not be completed.";
}

export function useUpdateEverything({ snapshot, statuses, operations, appStatus, request }: {
  snapshot: AppSnapshot | null;
  statuses: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceStatus>;
  operations: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceOperation>;
  appStatus: AppUpdateStatus | null;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
}): UpdateEverythingController {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const appStatusRef = useRef(appStatus);
  useEffect(() => { appStatusRef.current = appStatus; }, [appStatus]);
  const computed = useMemo(
    () => updateEverythingPlan({ snapshot, statuses, operations, appStatus }),
    [appStatus, operations, snapshot, statuses],
  );
  const plan = phase ? null : computed;

  const run = useCallback(async ({ providerIds, includeApp, continueChats }: UpdateEverythingRequest): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setPhase({ kind: "providers", providerIds });
    try {
      const result = updatesRunResult(await request({
        type: "updates.run",
        payload: { providerIds, includeApp, continueChats },
      }));
      let installed = false;
      if (includeApp && result.readyForAppInstall) {
        setPhase({ kind: "app" });
        try {
          installed = await installApp(appStatusRef.current);
        } catch (cause) {
          setError(errorMessage(cause));
        }
      }
      if (!installed) await request({ type: "updates.finish", payload: { installed: false } });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setPhase(null);
    }
  }, [request]);
  const dismissError = useCallback(() => setError(null), []);

  let progress: string | null = null;
  if (phase?.kind === "app") progress = "Updating Inertia…";
  else if (phase) {
    const current = phase.providerIds.find((providerId) => operations.get(providerId)?.status === "running")
      ?? phase.providerIds.find((providerId) => activeOperation(operations.get(providerId)))
      ?? phase.providerIds[0];
    progress = current ? `Updating ${providerLabel(snapshot, current)}…` : "Updating…";
  }
  return { plan, progress, error, run, dismissError };
}
