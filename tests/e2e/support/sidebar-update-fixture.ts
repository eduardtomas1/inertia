import type { IpcMain, WebContents } from "electron";
import { AppUpdateService } from "../../../src/main/app-update";
import { AppUpdateInstallCoordinator } from "../../../src/main/app-update-install";
import { APP_UPDATE_IPC, registerAppUpdateIpc } from "../../../src/main/app-update-ipc";
import type { AppUpdaterDownloadProgress } from "../../../src/main/electron-app-updater";
import { updateStatus } from "../../support/app-update-fixture";

/** Real main service/coordinator/IPC; only release transport and native download are controlled.
 * No installer, provider request, or personal profile is used by this fixture. */
export async function installUpdateFixture(ipcMain: IpcMain, owner: WebContents) {
  const counts = { checks: 0, downloads: 0, installs: 0, quits: 0, cleanup: 0 };
  let available = false;
  let releaseCheck: (() => void) | null = null;
  let gateCheck: Promise<void> | null = null;
  let checkEntered = false;
  let finish: (() => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  let progress: ((value: AppUpdaterDownloadProgress) => void) | null = null;
  const metadata = updateStatus();
  const service = new AppUpdateService({ currentVersion: metadata.currentVersion, capability: { delivery: "in-app" },
    fetch: async () => { throw new Error("No release network in fixture"); },
    loadUpdater: async () => ({
      check: async () => {
        counts.checks++; if (gateCheck) { checkEntered = true; await gateCheck; }
        return { available, version: available ? metadata.latestVersion! : metadata.currentVersion, releaseNotes: metadata.releaseNotes };
      },
      download: (callbacks) => {
        counts.downloads++; progress = callbacks.onProgress;
        return { promise: new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }),
          cancel: () => { callbacks.onCancelled(); finish?.(); } };
      },
      quitAndInstall: async () => { counts.quits++; throw new Error("Fixture must never install"); },
    }),
  });
  const coordinator = new AppUpdateInstallCoordinator({ service,
    runtime: () => ({ prepareForUpdate: async () => { counts.installs++; return { ready: false, blocker: "agent-work" }; },
      releaseUpdatePreparation: async () => true }), privateConnect: () => null,
    cleanup: async () => { counts.cleanup++; return false; },
    finishNormalShutdown: () => { counts.quits++; }, reportError: () => undefined });
  // Move beyond the production fixture's initial cached check before replacing
  // handlers. Subsequent native states still use real monotonic revisions.
  await service.check(true); await service.check(true);
  for (const channel of Object.values(APP_UPDATE_IPC)) if (channel !== APP_UPDATE_IPC.appUpdateStatus) ipcMain.removeHandler(channel);
  registerAppUpdateIpc({ ipcMain, currentVersion: () => metadata.currentVersion, service: () => service,
    installCoordinator: () => coordinator, rollbackManager: () => null,
    assertTrustedIpc: (event, count, expected = 0) => {
      if (event.sender.id !== owner.id || event.senderFrame !== owner.mainFrame || count !== expected) throw new Error("Untrusted update request");
    } });
  service.subscribe((status) => owner.send(APP_UPDATE_IPC.appUpdateStatus, status));
  owner.send(APP_UPDATE_IPC.appUpdateStatus, service.current());
  counts.checks = 0;
  return {
    counts,
    holdCheck: () => { available = true; checkEntered = false; gateCheck = new Promise<void>((resolve) => { releaseCheck = resolve; }); },
    finishCheck: () => {
      if (!checkEntered) throw new Error("The held update check has not entered its adapter.");
      releaseCheck?.(); gateCheck = null;
    },
    progress: (percent: number) => progress?.({ percent, transferred: percent, total: 100, bytesPerSecond: 10 }),
    finishDownload: () => finish?.(),
    failDownload: () => fail?.(new Error("private fixture transport failure")),
  };
}

export type SidebarUpdateFixture = Awaited<ReturnType<typeof installUpdateFixture>>;
