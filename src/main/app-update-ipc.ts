import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { AppUpdateInstallCoordinator } from "./app-update-install.js";
import type { AppUpdateService } from "./app-update.js";
import type { CanaryRollbackManager } from "./canary-rollback.js";

export const APP_UPDATE_IPC = {
  checkAppUpdate: "inertia:check-app-update",
  downloadAppUpdate: "inertia:download-app-update",
  cancelAppUpdateDownload: "inertia:cancel-app-update-download",
  installAppUpdate: "inertia:install-app-update",
  appUpdateStatus: "inertia:app-update-status",
  getCanaryRollbackStatus: "inertia:get-canary-rollback-status",
  prepareCanaryRollback: "inertia:prepare-canary-rollback",
  openCanaryRollback: "inertia:open-canary-rollback",
} as const;

interface AppUpdateIpcOptions {
  ipcMain: IpcMain;
  currentVersion(): string;
  service(): AppUpdateService | null;
  installCoordinator(): AppUpdateInstallCoordinator | null;
  rollbackManager(): CanaryRollbackManager | null;
  assertTrustedIpc(
    event: IpcMainInvokeEvent,
    suppliedArguments: number,
    expectedArguments?: number,
  ): void;
}

const unavailableRollback = {
  state: "unavailable" as const,
  version: null,
  message: "Rollback packages are available only in Inertia Canary.",
};

export function registerAppUpdateIpc(options: AppUpdateIpcOptions): void {
  const trusted = (
    event: IpcMainInvokeEvent,
    arguments_: unknown[],
    expectedArguments?: number,
  ): void => options.assertTrustedIpc(event, arguments_.length, expectedArguments);

  options.ipcMain.handle(APP_UPDATE_IPC.checkAppUpdate, async (event, ...arguments_) => {
    trusted(event, arguments_, 1);
    const [force] = arguments_;
    if (typeof force !== "boolean") throw new Error("Invalid update check request");
    const service = options.service();
    if (!service) throw new Error("Update checks are unavailable.");
    return await service.check(force);
  });

  options.ipcMain.handle(APP_UPDATE_IPC.downloadAppUpdate, async (event, ...arguments_) => {
    trusted(event, arguments_);
    const service = options.service();
    if (!service) throw new Error("Application updates are unavailable.");
    const rollback = options.rollbackManager();
    if (rollback) {
      const prepared = await rollback.prepare();
      if (prepared.state !== "ready" || prepared.version !== options.currentVersion()) {
        throw new Error("The current Canary build could not be retained for rollback.");
      }
    }
    return await service.download();
  });

  options.ipcMain.handle(APP_UPDATE_IPC.cancelAppUpdateDownload, (event, ...arguments_) => {
    trusted(event, arguments_);
    const service = options.service();
    if (!service) throw new Error("Application updates are unavailable.");
    return service.cancelDownload();
  });

  options.ipcMain.handle(APP_UPDATE_IPC.installAppUpdate, async (event, ...arguments_) => {
    trusted(event, arguments_);
    const coordinator = options.installCoordinator();
    if (!coordinator) throw new Error("Application updates are unavailable.");
    return await coordinator.install();
  });

  options.ipcMain.handle(APP_UPDATE_IPC.getCanaryRollbackStatus, async (event, ...arguments_) => {
    trusted(event, arguments_);
    const rollback = options.rollbackManager();
    return rollback ? await rollback.current() : unavailableRollback;
  });
  options.ipcMain.handle(APP_UPDATE_IPC.prepareCanaryRollback, async (event, ...arguments_) => {
    trusted(event, arguments_);
    const rollback = options.rollbackManager();
    return rollback ? await rollback.prepare() : unavailableRollback;
  });
  options.ipcMain.handle(APP_UPDATE_IPC.openCanaryRollback, async (event, ...arguments_) => {
    trusted(event, arguments_);
    const rollback = options.rollbackManager();
    return rollback ? await rollback.open() : unavailableRollback;
  });
}
