import type { ProviderMaintenanceProviderId, ServerEvent } from "@shared/contracts";
import type { UpdatesRunResult } from "@shared/updates";
import type { AppUpdateStatus } from "@shared/desktop";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { UpdateEverythingPhase } from "../hooks/useUpdateEverything";

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

async function installApp(): Promise<boolean> {
  const result = await invoke(() => window.inertia.installAppUpdate(), "The update restart could not be started safely.");
  return result.state === "installing" && result.installBlocker === null;
}

export async function runUpdateEverything({ payload, request, appStatus, onPhase }: {
  payload: UpdateEverythingRequest;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  appStatus: () => AppUpdateStatus | null;
  onPhase: (phase: UpdateEverythingPhase) => void;
}): Promise<void> {
  let app = payload.includeApp ? appStatus() : null;
  if (app?.state === "available") {
    onPhase({ kind: "download" });
    app = await downloadApp();
    if (app.state !== "downloaded") return;
  }
  onPhase({ kind: "providers", providerIds: payload.providerIds });
  const result = updatesRunResult(await request({ type: "updates.run", payload }));
  let installed = false;
  let failure: unknown = null;
  if (payload.includeApp && result.readyForAppInstall && app?.state === "downloaded") {
    onPhase({ kind: "app" });
    try {
      installed = await installApp();
    } catch (cause) {
      failure = cause;
    }
  }
  if (!installed) await request({ type: "updates.finish", payload: { installed: false } });
  if (failure) throw failure;
}
