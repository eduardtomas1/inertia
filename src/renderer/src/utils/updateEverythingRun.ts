import type { ProviderMaintenanceProviderId, ServerEvent } from "@shared/contracts";
import type { UpdatesRunResult } from "@shared/updates";
import type { AppUpdateStatus } from "@shared/desktop";
import type { CommandWithoutId } from "../lib/runtimeCommands";

export type UpdateEverythingPhase =
  | { kind: "download" }
  | { kind: "providers"; providerIds: readonly ProviderMaintenanceProviderId[] }
  | { kind: "app" };

export interface UpdateEverythingRequest {
  providerIds: ProviderMaintenanceProviderId[];
  includeApp: boolean;
  continueChats: boolean;
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

async function downloadApp(): Promise<AppUpdateStatus> {
  const started = await invoke(() => window.inertia.downloadAppUpdate(), "The update download could not be started.");
  return await settledDownload(started);
}

async function installApp(): Promise<string | null> {
  const result = await invoke(() => window.inertia.installAppUpdate(), "The update restart could not be started safely.");
  return result.state === "installing" && result.installBlocker === null ? null : result.message;
}

function providerFailures(
  result: UpdatesRunResult,
  providerLabels: ReadonlyMap<ProviderMaintenanceProviderId, string>,
): string[] {
  return result.providers.flatMap(({ providerId, outcome, error }) => outcome !== "failed" ? []
    : [`${providerLabels.get(providerId) ?? providerId} update failed${error ? `: ${error}` : "."}`]);
}

export async function runUpdateEverything({ payload, request, appStatus, providerLabels, onPhase }: {
  payload: UpdateEverythingRequest;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  appStatus: () => AppUpdateStatus | null;
  providerLabels: ReadonlyMap<ProviderMaintenanceProviderId, string>;
  onPhase: (phase: UpdateEverythingPhase) => void;
}): Promise<string | null> {
  let app = payload.includeApp ? appStatus() : null;
  let run = payload;
  let download: string | null = null;
  if (app?.state === "available") {
    onPhase({ kind: "download" });
    app = await downloadApp();
    if (app.state !== "downloaded") {
      download = app.message;
      run = { ...payload, includeApp: false };
    }
  }
  onPhase({ kind: "providers", providerIds: run.providerIds });
  const result = updatesRunResult(await request({ type: "updates.run", payload: run }));
  let installed = false;
  let refusal: string | null = null;
  let failure: unknown = null;
  if (run.includeApp && result.readyForAppInstall && app?.state === "downloaded") {
    onPhase({ kind: "app" });
    try {
      refusal = await installApp();
      installed = refusal === null;
    } catch (cause) {
      failure = cause;
    }
  }
  if (!installed) await request({ type: "updates.finish", payload: { installed: false } });
  if (failure) throw failure;
  const appMessage = download ?? refusal ?? result.appInstallBlocker;
  return [...providerFailures(result, providerLabels), ...(appMessage ? [appMessage] : [])].join(" ") || null;
}
