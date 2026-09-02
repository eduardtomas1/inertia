import type { AppUpdater, ProgressInfo, UpdateCheckResult } from "electron-updater";
import {
  installAppImageUpdate,
  recoverAppImageUpdate,
} from "./appimage-installed-identity.js";
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
type ElectronApplication = Pick<typeof import("electron")["app"], "quit">;

interface ElectronAppUpdaterRuntimeOptions {
  platform?: NodeJS.Platform;
  activeAppImagePath?: string;
  environment?: NodeJS.ProcessEnv;
  launchAppImage?: (path: string, environment: NodeJS.ProcessEnv) => Promise<void>;
}

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
  options: ElectronAppUpdaterRuntimeOptions = {},
): Promise<AppUpdaterAdapter> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  let activeAppImagePath = options.activeAppImagePath ?? environment.APPIMAGE;
  if (platform === "linux") {
    if (!activeAppImagePath) throw new Error("The active AppImage path is unavailable.");
    activeAppImagePath = await recoverAppImageUpdate({
      channel,
      activePath: activeAppImagePath,
    });
    environment.APPIMAGE = activeAppImagePath;
  }
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
    electron.app,
    channel,
    platform,
    environment,
    activeAppImagePath,
    options.launchAppImage,
  );
}

class ElectronAppUpdaterAdapter implements AppUpdaterAdapter {
  private downloadedInstallerPath: string | null = null;

  constructor(
    private readonly updater: AppUpdater,
    private readonly CancellationToken: ElectronUpdaterModule["CancellationToken"],
    private readonly installSignals: InstallSignalEmitter,
    private readonly application: ElectronApplication,
    private readonly channel: InertiaReleaseChannel,
    private readonly platform: NodeJS.Platform,
    private readonly environment: NodeJS.ProcessEnv,
    private activeAppImagePath: string | undefined,
    private readonly launchAppImage?: (
      path: string,
      environment: NodeJS.ProcessEnv,
    ) => Promise<void>,
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
    this.downloadedInstallerPath = null;
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
      .then((paths) => {
        this.downloadedInstallerPath = paths[0] ?? null;
      })
      .finally(() => {
        this.updater.removeListener("download-progress", onProgress);
        this.updater.removeListener("update-cancelled", onCancelled);
      });
    return {
      promise,
      cancel: () => token.cancel(),
    };
  }

  async quitAndInstall(onHandoff: () => void = () => undefined): Promise<boolean> {
    if (this.platform === "linux") {
      if (!this.activeAppImagePath || !this.downloadedInstallerPath) return false;
      try {
        const installedPath = await installAppImageUpdate({
          channel: this.channel,
          activePath: this.activeAppImagePath,
          downloadedPath: this.downloadedInstallerPath,
          environment: this.environment,
          ...(this.launchAppImage ? { launch: this.launchAppImage } : {}),
        });
        this.activeAppImagePath = installedPath;
        this.environment.APPIMAGE = installedPath;
        onHandoff();
        this.application.quit();
        return true;
      } catch {
        return false;
      }
    }
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
