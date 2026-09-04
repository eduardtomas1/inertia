import { randomUUID } from "node:crypto";
import type { AppUpdater, ProgressInfo, UpdateCheckResult } from "electron-updater";
import {
  prepareAppImageUpdate,
  recoverAppImageUpdate,
  type PreparedAppImageUpdate,
} from "./appimage-installed-identity.js";
import {
  appUpdateArtifactIdentity,
  appUpdateDirectoryIdentityDigest,
  launchRestrictedAppUpdateCandidate,
  windowsAppUpdateExecutableLineageDigest,
  windowsAppUpdateInstallerIdentity,
  type AppUpdateArtifactIdentity,
  type AppUpdateCandidateProcess,
} from "./app-update-bootstrap.js";
import {
  AppUpdateHandoffJournal,
  appUpdateHandoffOwner,
  appUpdateHandoffTokenDigest,
  createAppUpdateHandoffToken,
} from "./app-update-handoff.js";
import { AppUpdateHandoffTokenVault } from
  "./app-update-handoff-token-vault.js";
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
  prepareInstall?(context: AppUpdateInstallContext): Promise<boolean>;
  abortInstall?(): Promise<void>;
  quitAndInstall(onHandoff?: () => void): Promise<boolean>;
}

export interface AppUpdateInstallContext {
  readonly currentVersion: string;
  readonly newVersion: string;
  readonly handoffDirectory: string;
  readonly profileDirectory: string;
  readonly dataDirectory: string;
  readonly oldRuntimeGenerationId: string;
  readonly systemBootId: string;
}

export type AppUpdateInstallRuntimeContext = Omit<
  AppUpdateInstallContext,
  "currentVersion" | "newVersion"
>;

type ElectronUpdaterModule = typeof import("electron-updater");
type InstallSignalEmitter = Pick<NodeJS.EventEmitter, "on" | "removeListener">;
type ElectronApplication = Pick<typeof import("electron")["app"], "quit">;

interface ElectronAppUpdaterRuntimeOptions {
  platform?: NodeJS.Platform;
  activeAppImagePath?: string;
  environment?: NodeJS.ProcessEnv;
  executablePath?: string;
  launchRestrictedCandidate?: typeof launchRestrictedAppUpdateCandidate;
}

const ANONYMOUS_STAGING_ID = "inertia-anonymous";
const INSTALL_HANDOFF_TIMEOUT_MS = 5_000;
const LINUX_CANDIDATE_HANDOFF_LIFETIME_MS = 60_000;
// Native install and reboot are durable, cross-process steps. Keep their
// receipt bounded by the journal's maximum while avoiding a spawn-like 60s
// assumption about NSIS completion.
const WINDOWS_INSTALL_HANDOFF_LIFETIME_MS = 24 * 60 * 60 * 1_000;

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
    options.executablePath ?? process.execPath,
    activeAppImagePath,
    options.launchRestrictedCandidate,
  );
}

class ElectronAppUpdaterAdapter implements AppUpdaterAdapter {
  private downloadedInstallerPath: string | null = null;
  private preparedLinux: {
    readonly transaction: PreparedAppImageUpdate;
    readonly candidate: AppUpdateCandidateProcess;
    readonly journal: AppUpdateHandoffJournal;
  } | null = null;
  private preparedWindows: {
    readonly journal: AppUpdateHandoffJournal;
    readonly vault: AppUpdateHandoffTokenVault;
    readonly installerPath: string;
    readonly installerIdentity: AppUpdateArtifactIdentity;
    nativeInvocationStarted: boolean;
  } | null = null;

  constructor(
    private readonly updater: AppUpdater,
    private readonly CancellationToken: ElectronUpdaterModule["CancellationToken"],
    private readonly installSignals: InstallSignalEmitter,
    private readonly application: ElectronApplication,
    private readonly channel: InertiaReleaseChannel,
    private readonly platform: NodeJS.Platform,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly executablePath: string,
    private activeAppImagePath: string | undefined,
    private readonly launchRestrictedCandidate =
      launchRestrictedAppUpdateCandidate,
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

  async prepareInstall(context: AppUpdateInstallContext): Promise<boolean> {
    if (this.platform !== "linux" && this.platform !== "win32") return true;
    await this.abortInstall();
    if (!this.downloadedInstallerPath) return false;
    if (this.platform === "win32") {
      return await this.prepareWindowsInstall(context);
    }
    if (!this.activeAppImagePath) return false;
    const operationId = randomUUID();
    const handoffToken = createAppUpdateHandoffToken();
    let transaction: PreparedAppImageUpdate | null = null;
    let candidate: AppUpdateCandidateProcess | null = null;
    let journal: AppUpdateHandoffJournal | null = null;
    try {
      transaction = await prepareAppImageUpdate({
        channel: this.channel,
        activePath: this.activeAppImagePath,
        downloadedPath: this.downloadedInstallerPath,
        operationId,
      });
      journal = new AppUpdateHandoffJournal(context.handoffDirectory);
      const now = Date.now();
      const prepared = journal.prepare({
        operationId,
        platform: "linux",
        channel: this.channel,
        oldVersion: context.currentVersion,
        newVersion: context.newVersion,
        oldRuntimeGenerationId: context.oldRuntimeGenerationId,
        systemBootId: context.systemBootId,
        candidateArtifactDigest: transaction.artifactDigest,
        candidateExecutableIdentityDigest: transaction.executableIdentityDigest,
        profileIdentityDigest: appUpdateDirectoryIdentityDigest(
          context.profileDirectory,
          "profile",
        ),
        dataIdentityDigest: appUpdateDirectoryIdentityDigest(
          context.dataDirectory,
          "data",
        ),
        handoffTokenDigest: appUpdateHandoffTokenDigest(handoffToken)!,
        createdAt: new Date(now).toISOString(),
        deadlineAt: new Date(
          now + LINUX_CANDIDATE_HANDOFF_LIFETIME_MS,
        ).toISOString(),
      });
      if (!prepared) throw new Error("The app update handoff could not be prepared.");
      const launched = journal.transition(
        appUpdateHandoffOwner(prepared),
        "candidate-launched",
      );
      if (!launched) throw new Error("The app update candidate launch was not admitted.");
      candidate = await this.launchRestrictedCandidate({
        executablePath: transaction.candidatePath,
        environment: this.environment,
        operationId,
        handoffToken,
        handoffDirectory: context.handoffDirectory,
        profileDirectory: context.profileDirectory,
        dataDirectory: context.dataDirectory,
        journal,
      });
      if (
        candidate.acknowledgement.operationId !== operationId
        || candidate.acknowledgement.phase
          !== "candidate-bootstrap-validated"
      ) throw new Error("The app update candidate acknowledgement was invalid.");
      this.preparedLinux = { transaction, candidate, journal };
      return true;
    } catch {
      const cleanup = await Promise.allSettled([
        candidate?.abort() ?? Promise.resolve(),
        transaction?.rollback() ?? Promise.resolve(),
      ]);
      if (journal) {
        this.markLinuxRollbackRequired(journal);
        if (cleanup.every((result) => result.status === "fulfilled")) {
          this.completeLinuxRollback(journal);
        }
      }
      return false;
    }
  }

  async abortInstall(): Promise<void> {
    const preparedWindows = this.preparedWindows;
    this.preparedWindows = null;
    if (preparedWindows) {
      if (preparedWindows.nativeInvocationStarted) {
        this.markWindowsInstallUncertain(preparedWindows);
      } else {
        this.retireWindowsRollback(preparedWindows);
      }
    }
    const prepared = this.preparedLinux;
    this.preparedLinux = null;
    if (!prepared) return;
    this.markLinuxRollbackRequired(prepared.journal);
    const cleanup = await Promise.allSettled([
      prepared.candidate.abort(),
      prepared.transaction.rollback(),
    ]);
    if (cleanup.every((result) => result.status === "fulfilled")) {
      this.completeLinuxRollback(prepared.journal);
      return;
    }
    throw new AggregateError(
      cleanup
        .filter((result): result is PromiseRejectedResult =>
          result.status === "rejected")
        .map((result) => result.reason),
      "The app update candidate rollback could not be confirmed.",
    );
  }

  private markLinuxRollbackRequired(journal: AppUpdateHandoffJournal): void {
    try {
      const current = journal.current();
      if (!current) return;
      if (
        current.phase !== "rollback-required"
        && current.phase !== "rollback-completed"
        && current.phase !== "completed"
      ) journal.transition(appUpdateHandoffOwner(current), "rollback-required");
    } catch {
      // Durable recovery retains any phase that could not advance exactly.
    }
  }

  private completeLinuxRollback(journal: AppUpdateHandoffJournal): void {
    try {
      const rollingBack = journal.current();
      if (rollingBack?.phase !== "rollback-required") return;
      const completed = journal.transition(
        appUpdateHandoffOwner(rollingBack),
        "rollback-completed",
      );
      if (completed) journal.retire(appUpdateHandoffOwner(completed));
    } catch {
      // Durable recovery retains any phase that could not be retired exactly.
    }
  }

  private async prepareWindowsInstall(
    context: AppUpdateInstallContext,
  ): Promise<boolean> {
    const installerPath = this.downloadedInstallerPath;
    if (!installerPath) return false;
    const operationId = randomUUID();
    const handoffToken = createAppUpdateHandoffToken();
    let journal: AppUpdateHandoffJournal | null = null;
    let vault: AppUpdateHandoffTokenVault | null = null;
    try {
      const installerIdentity = await windowsAppUpdateInstallerIdentity(
        installerPath,
      );
      journal = new AppUpdateHandoffJournal(context.handoffDirectory);
      vault = new AppUpdateHandoffTokenVault(context.handoffDirectory);
      const now = Date.now();
      const prepared = journal.prepare({
        operationId,
        platform: "win32",
        channel: this.channel,
        oldVersion: context.currentVersion,
        newVersion: context.newVersion,
        oldRuntimeGenerationId: context.oldRuntimeGenerationId,
        systemBootId: context.systemBootId,
        candidateArtifactDigest: installerIdentity.artifactDigest,
        candidateExecutableIdentityDigest:
          windowsAppUpdateExecutableLineageDigest({
            artifactDigest: installerIdentity.artifactDigest,
            candidateExecutableDigest:
              installerIdentity.candidateExecutableDigest,
            executablePath: this.executablePath,
            version: context.newVersion,
          }),
        profileIdentityDigest: appUpdateDirectoryIdentityDigest(
          context.profileDirectory,
          "profile",
        ),
        dataIdentityDigest: appUpdateDirectoryIdentityDigest(
          context.dataDirectory,
          "data",
        ),
        handoffTokenDigest: appUpdateHandoffTokenDigest(handoffToken)!,
        createdAt: new Date(now).toISOString(),
        deadlineAt: new Date(
          now + WINDOWS_INSTALL_HANDOFF_LIFETIME_MS,
        ).toISOString(),
      });
      if (!prepared || !vault.publish(prepared, handoffToken)) {
        throw new Error("The Windows app update receipt could not be prepared.");
      }
      this.preparedWindows = {
        journal,
        vault,
        installerPath,
        installerIdentity,
        nativeInvocationStarted: false,
      };
      return true;
    } catch {
      if (journal && vault) {
        this.retireWindowsRollback({
          journal,
          vault,
        });
      } else if (journal) {
        this.markLinuxRollbackRequired(journal);
      }
      return false;
    }
  }

  private retireWindowsRollback(
    prepared: {
      readonly journal: AppUpdateHandoffJournal;
      readonly vault: AppUpdateHandoffTokenVault;
    },
  ): void {
    try {
      const current = prepared.journal.current();
      if (!current) return;
      const rollingBack = current.phase === "rollback-required"
        ? current
        : prepared.journal.transition(
            appUpdateHandoffOwner(current),
            "rollback-required",
          );
      if (!rollingBack) return;
      if (!prepared.vault.discard(rollingBack)) return;
      const completed = prepared.journal.transition(
        appUpdateHandoffOwner(rollingBack),
        "rollback-completed",
      );
      if (completed) prepared.journal.retire(appUpdateHandoffOwner(completed));
    } catch {
      // Startup recovery retains any ambiguous native-installer authority.
    }
  }

  private markWindowsInstallUncertain(
    prepared: NonNullable<ElectronAppUpdaterAdapter["preparedWindows"]>,
  ): void {
    try {
      const current = prepared.journal.current();
      if (
        current
        && current.phase !== "rollback-required"
        && current.phase !== "rollback-completed"
        && current.phase !== "completed"
      ) {
        prepared.journal.transition(
          appUpdateHandoffOwner(current),
          "rollback-required",
        );
      }
    } catch {
      // Never erase a receipt when native installer outcome is uncertain.
    }
  }

  async quitAndInstall(onHandoff: () => void = () => undefined): Promise<boolean> {
    if (this.platform === "linux") {
      if (this.preparedLinux) {
        const prepared = this.preparedLinux;
        try {
          if (!prepared.candidate.alive()) throw new Error("The update candidate exited.");
          const acknowledged = prepared.journal.current();
          if (!acknowledged || acknowledged.phase !== "candidate-bootstrap-validated") {
            throw new Error("The update candidate acknowledgement was lost.");
          }
          const cleaned = prepared.journal.transition(
            appUpdateHandoffOwner(acknowledged),
            "old-generation-cleanup-confirmed",
          );
          if (!cleaned) throw new Error("Update cleanup could not be recorded.");
          const installedPath = await prepared.transaction.commit();
          const committed = prepared.journal.transition(
            appUpdateHandoffOwner(cleaned),
            "ownership-transfer-committed",
          );
          if (!committed || !prepared.candidate.alive()) {
            throw new Error("Update ownership could not be transferred.");
          }
          this.activeAppImagePath = installedPath;
          this.environment.APPIMAGE = installedPath;
          this.preparedLinux = null;
          onHandoff();
          this.application.quit();
          return true;
        } catch {
          await this.abortPreparedLinux(prepared);
          return false;
        }
      }
      // Linux adoption is valid only after prepareInstall has launched the
      // restricted candidate and received its exact bootstrap acknowledgement.
      // Retaining the former direct-launch fallback here would let callers
      // treat process spawn as readiness and bypass the durable handoff phases.
      return false;
    }
    const preparedWindows = this.platform === "win32"
      ? this.preparedWindows
      : null;
    if (this.platform === "win32" && !preparedWindows) return false;
    if (preparedWindows) {
      try {
        const current = preparedWindows.journal.current();
        const installerIdentity = await appUpdateArtifactIdentity(
          preparedWindows.installerPath,
        );
        if (
          !current
          || current.phase !== "prepared"
          || !preparedWindows.vault.matches(current)
          || installerIdentity.artifactDigest
            !== preparedWindows.installerIdentity.artifactDigest
          || installerIdentity.directFileIdentityDigest
            !== preparedWindows.installerIdentity.directFileIdentityDigest
        ) throw new Error("The Windows app update preparation changed.");
        const cleaned = preparedWindows.journal.transition(
          appUpdateHandoffOwner(current),
          "old-generation-cleanup-confirmed",
        );
        if (!cleaned) throw new Error("The Windows cleanup receipt was not durable.");
      } catch {
        this.preparedWindows = null;
        this.retireWindowsRollback(preparedWindows);
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
        if (preparedWindows) {
          const current = preparedWindows.journal.current();
          const committed = current?.phase === "old-generation-cleanup-confirmed"
            ? preparedWindows.journal.transition(
                appUpdateHandoffOwner(current),
                "ownership-transfer-committed",
              )
            : null;
          if (!committed) {
            this.markWindowsInstallUncertain(preparedWindows);
            finish(false);
            return;
          }
          if (this.preparedWindows === preparedWindows) {
            this.preparedWindows = null;
          }
        }
        onHandoff();
        finish(true);
      };
      const failUncertain = (): void => {
        if (preparedWindows) {
          this.markWindowsInstallUncertain(preparedWindows);
        }
        finish(false);
      };
      const onError = (): void => failUncertain();
      const timeout = setTimeout(failUncertain, INSTALL_HANDOFF_TIMEOUT_MS);
      timeout.unref?.();
      this.installSignals.on("before-quit-for-update", onNativeHandoff);
      this.updater.on("error", onError);
      try {
        if (preparedWindows) preparedWindows.nativeInvocationStarted = true;
        this.updater.quitAndInstall(false, true);
      } catch {
        failUncertain();
      }
    });
  }

  private async abortPreparedLinux(prepared: NonNullable<
    ElectronAppUpdaterAdapter["preparedLinux"]
  >): Promise<void> {
    if (this.preparedLinux === prepared) this.preparedLinux = null;
    this.markLinuxRollbackRequired(prepared.journal);
    const cleanup = await Promise.allSettled([
      prepared.candidate.abort(),
      prepared.transaction.rollback(),
    ]);
    if (cleanup.every((result) => result.status === "fulfilled")) {
      this.completeLinuxRollback(prepared.journal);
      return;
    }
    throw new AggregateError(
      cleanup
        .filter((result): result is PromiseRejectedResult =>
          result.status === "rejected")
        .map((result) => result.reason),
      "The app update candidate rollback could not be confirmed.",
    );
  }
}
