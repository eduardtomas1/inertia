import type { AppUpdater, ProgressInfo, UpdateCheckResult } from "electron-updater";
import type { InertiaReleaseChannel } from "./release-channel.js";

export interface AppUpdaterDownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface AppUpdaterDownload {
  promise: Promise<void>;
  cancel(): void;
}

export interface AppUpdaterAdapter {
  check(): Promise<{ available: boolean; version: string } | null>;
  download(callbacks: {
    onProgress(progress: AppUpdaterDownloadProgress): void;
    onCancelled(): void;
  }): AppUpdaterDownload;
  quitAndInstall(onHandoff?: () => void): Promise<boolean>;
}

type ElectronUpdaterModule = typeof import("electron-updater");
type InstallSignalEmitter = Pick<NodeJS.EventEmitter, "on" | "removeListener">;

const ANONYMOUS_STAGING_ID = "inertia-anonymous";
const INSTALL_HANDOFF_TIMEOUT_MS = 5_000;

function resolvedModule(namespace: ElectronUpdaterModule): ElectronUpdaterModule {
  const candidate = namespace as ElectronUpdaterModule & {
    default?: ElectronUpdaterModule;
  };
  return candidate.autoUpdater ? candidate : candidate.default ?? candidate;
}

/**
 * Loads the CommonJS updater only for a build that was explicitly marked as
 * update-capable. Development and unsupported packages never initialize its
 * filesystem or network machinery.
 */
export async function loadElectronAppUpdater(
  channel: InertiaReleaseChannel = "stable",
): Promise<AppUpdaterAdapter> {
  const [moduleNamespace, electron] = await Promise.all([
    import("electron-updater"),
    import("electron"),
  ]);
  const module = resolvedModule(moduleNamespace);
  const updater = module.autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = channel === "canary";
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.logger = null;
  // electron-updater creates a per-install rollout UUID internally. Override
  // only the outbound header so GitHub never receives a stable device ID.
  updater.requestHeaders = {
    "x-user-staging-id": channel === "canary"
      ? `${ANONYMOUS_STAGING_ID}-canary`
      : ANONYMOUS_STAGING_ID,
  };
  return new ElectronAppUpdaterAdapter(
    updater,
    module.CancellationToken,
    electron.autoUpdater,
  );
}

class ElectronAppUpdaterAdapter implements AppUpdaterAdapter {
  constructor(
    private readonly updater: AppUpdater,
    private readonly CancellationToken: ElectronUpdaterModule["CancellationToken"],
    private readonly installSignals: InstallSignalEmitter,
  ) {}

  async check(): Promise<{ available: boolean; version: string } | null> {
    const result: UpdateCheckResult | null = await this.updater.checkForUpdates();
    if (!result) return null;
    return {
      available: result.isUpdateAvailable,
      version: result.updateInfo.version,
    };
  }

  download(callbacks: {
    onProgress(progress: AppUpdaterDownloadProgress): void;
    onCancelled(): void;
  }): AppUpdaterDownload {
    const token = new this.CancellationToken();
    const onProgress = (progress: ProgressInfo): void => {
      callbacks.onProgress({
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    };
    const onCancelled = (): void => callbacks.onCancelled();
    this.updater.on("download-progress", onProgress);
    this.updater.on("update-cancelled", onCancelled);
    const promise = Promise.resolve()
      .then(async () => await this.updater.downloadUpdate(token))
      .then(() => undefined)
      .finally(() => {
        this.updater.removeListener("download-progress", onProgress);
        this.updater.removeListener("update-cancelled", onCancelled);
      });
    return {
      promise,
      cancel: () => token.cancel(),
    };
  }

  quitAndInstall(onHandoff: () => void = () => undefined): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (handedOff: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.installSignals.removeListener("before-quit-for-update", onNativeHandoff);
        this.updater.removeListener("error", onError);
        resolve(handedOff);
      };
      const onNativeHandoff = (): void => {
        onHandoff();
        finish(true);
      };
      const onError = (): void => finish(false);
      const timeout = setTimeout(() => finish(false), INSTALL_HANDOFF_TIMEOUT_MS);
      timeout.unref?.();
      this.installSignals.on("before-quit-for-update", onNativeHandoff);
      this.updater.on("error", onError);
      try {
        this.updater.quitAndInstall(false, true);
      } catch {
        finish(false);
      }
    });
  }
}
