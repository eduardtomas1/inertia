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
  type WindowsAppUpdateInstallerIdentity,
} from "./app-update-bootstrap.js";
import {
  AppUpdateHandoffJournal,
  appUpdateHandoffIdentityMatches,
  appUpdateHandoffOwner,
  appUpdateHandoffTokenDigest,
  createAppUpdateHandoffToken,
  type AppUpdateHandoffPreparation,
  type AppUpdateHandoffSnapshot,
} from "./app-update-handoff.js";
import { AppUpdateHandoffTokenVault } from
  "./app-update-handoff-token-vault.js";
import type { InertiaReleaseChannel } from "./release-channel.js";
import { resolveDesktopRuntimeProcessSafetyAssets } from
  "./runtime-windows-job-bootstrap.js";
import {
  LinuxAppUpdateCandidateClaimConflictError,
  linuxAppUpdateCandidateClaimOwnerIsLive,
} from "./linux-app-update-candidate-process.js";
import {
  launchWindowsUpdateSupervisor,
  WindowsUpdateSupervisorCleanupError,
  type WindowsUpdateSupervisorAdmission,
  type WindowsUpdateSupervisorLaunchOptions,
} from "./windows-update-supervisor.js";

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

export type AppUpdaterInstallResult =
  | "handoff-confirmed"
  | "not-invoked"
  | "native-outcome-uncertain";

export interface AppUpdaterAdapter {
  check(): Promise<{ available: boolean; version: string } | null>;
  download(callbacks: {
    onProgress(progress: AppUpdaterDownloadProgress): void;
    onCancelled(): void;
  }): AppUpdaterDownload;
  prepareInstall?(context: AppUpdateInstallContext): Promise<boolean>;
  abortInstall?(): Promise<void>;
  quitAndInstall(onHandoff?: () => void): Promise<AppUpdaterInstallResult>;
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
  launchRestrictedCandidate?: LinuxAppUpdateCandidateLauncher;
  launchWindowsSupervisor?: WindowsUpdateSupervisorLauncher;
}

export type LinuxAppUpdateCandidateLauncher = (
  options: Omit<
    Parameters<typeof launchRestrictedAppUpdateCandidate>[0],
    "runtimeProcessGuardianPath"
  >,
) => ReturnType<typeof launchRestrictedAppUpdateCandidate>;

export type WindowsUpdateSupervisorLauncher = (
  options: Omit<
    WindowsUpdateSupervisorLaunchOptions,
    "assembly" | "launchThroughExecutableLock" | "readyTimeoutMs"
  >,
) => Promise<WindowsUpdateSupervisorAdmission>;

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

function exactHandoffSnapshotMatches(
  current: AppUpdateHandoffSnapshot,
  expected: AppUpdateHandoffSnapshot,
): boolean {
  return current.checksum === expected.checksum
    && current.revision === expected.revision
    && current.phase === expected.phase
    && appUpdateHandoffIdentityMatches(current, expected);
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
    options.launchWindowsSupervisor,
  );
}

class ElectronAppUpdaterAdapter implements AppUpdaterAdapter {
  private downloadedInstallerPath: string | null = null;
  private preparedLinux: {
    readonly transaction: PreparedAppImageUpdate;
    readonly candidate: AppUpdateCandidateProcess;
    readonly journal: AppUpdateHandoffJournal;
    snapshot: AppUpdateHandoffSnapshot;
  } | null = null;
  private preparedWindows: {
    readonly journal: AppUpdateHandoffJournal;
    readonly vault: AppUpdateHandoffTokenVault;
    readonly installerPath: string;
    readonly installerIdentity: WindowsAppUpdateInstallerIdentity;
    readonly oldExecutableIdentity: AppUpdateArtifactIdentity;
    readonly dataDirectory: string;
    readonly handoffToken: string;
    snapshot: AppUpdateHandoffSnapshot;
    nativeInvocationStarted: boolean;
  } | null = null;
  private windowsInstallPromise: Promise<AppUpdaterInstallResult> | null = null;

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
    private readonly launchRestrictedCandidate: LinuxAppUpdateCandidateLauncher =
      async (options) => {
        const guardianPath = resolveDesktopRuntimeProcessSafetyAssets()
          .runtimeProcessGuardianPath;
        if (!guardianPath) {
          throw new Error("The Linux app update guardian is unavailable.");
        }
        return await launchRestrictedAppUpdateCandidate({
          ...options,
          runtimeProcessGuardianPath: guardianPath,
        });
      },
    private readonly launchWindowsSupervisor: WindowsUpdateSupervisorLauncher =
      async (options) => {
        const assembly = resolveDesktopRuntimeProcessSafetyAssets()
          .windowsRuntimeJobAssembly;
        if (!assembly) {
          throw new Error("The Windows update supervisor is unavailable.");
        }
        return await launchWindowsUpdateSupervisor({ ...options, assembly });
      },
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
    let expectedPreparation: AppUpdateHandoffPreparation | null = null;
    let snapshot: AppUpdateHandoffSnapshot | null = null;
    try {
      transaction = await prepareAppImageUpdate({
        channel: this.channel,
        activePath: this.activeAppImagePath,
        downloadedPath: this.downloadedInstallerPath,
        operationId,
      });
      journal = new AppUpdateHandoffJournal(context.handoffDirectory);
      const now = Date.now();
      expectedPreparation = {
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
      };
      const prepared = journal.prepare(expectedPreparation);
      if (!prepared) throw new Error("The app update handoff could not be prepared.");
      snapshot = prepared;
      const launched = journal.transition(
        appUpdateHandoffOwner(prepared),
        "candidate-launched",
      );
      if (!launched) throw new Error("The app update candidate launch was not admitted.");
      snapshot = launched;
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
      const acknowledged = journal.current();
      if (
        !acknowledged
        || candidate.acknowledgement.operationId !== operationId
        || candidate.acknowledgement.phase
          !== "candidate-bootstrap-validated"
        || acknowledged.checksum !== candidate.acknowledgement.checksum
        || !appUpdateHandoffIdentityMatches(
          acknowledged,
          launched,
        )
      ) throw new Error("The app update candidate acknowledgement was invalid.");
      snapshot = acknowledged;
      this.preparedLinux = { transaction, candidate, journal, snapshot };
      return true;
    } catch (error) {
      if (
        error instanceof LinuxAppUpdateCandidateClaimConflictError
        && snapshot
        && linuxAppUpdateCandidateClaimOwnerIsLive({
          handoffDirectory: context.handoffDirectory,
          snapshot,
        })
      ) return false;
      if (journal && expectedPreparation && !snapshot) {
        try {
          const recovered = journal.current();
          if (
            recovered
            && appUpdateHandoffIdentityMatches(
              recovered,
              expectedPreparation,
            )
          ) snapshot = recovered;
        } catch {
          // Startup recovery retains any publication that cannot be read exactly.
        }
      }
      const rollingBack = journal && snapshot
        ? this.markLinuxRollbackRequired(journal, snapshot)
        : null;
      if (rollingBack) snapshot = rollingBack;
      const mayMutateTransaction = !snapshot
        || rollingBack?.phase === "rollback-required";
      const cleanup = await Promise.allSettled([
        candidate?.abort() ?? Promise.resolve(),
        mayMutateTransaction
          ? transaction?.rollback() ?? Promise.resolve()
          : Promise.resolve(),
      ]);
      if (
        journal
        && rollingBack
        && cleanup.every((result) => result.status === "fulfilled")
      ) {
        this.completeLinuxRollback(journal, rollingBack);
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
        this.preparedWindows = preparedWindows;
        throw new Error(
          "The native Windows installer retained unconfirmed authority.",
        );
      } else if (!this.retireWindowsRollback(preparedWindows)) {
        this.preparedWindows = preparedWindows;
        throw new Error("The Windows app update rollback could not be confirmed.");
      }
    }
    const prepared = this.preparedLinux;
    this.preparedLinux = null;
    if (!prepared) return;
    const rollingBack = this.markLinuxRollbackRequired(
      prepared.journal,
      prepared.snapshot,
    );
    if (rollingBack) prepared.snapshot = rollingBack;
    const cleanup = await Promise.allSettled([
      prepared.candidate.abort(),
      rollingBack?.phase === "rollback-required"
        ? prepared.transaction.rollback()
        : Promise.resolve(),
    ]);
    const rollbackCompleted = !!rollingBack
      && cleanup.every((result) => result.status === "fulfilled")
      && this.completeLinuxRollback(
        prepared.journal,
        rollingBack,
        (completed) => {
          prepared.snapshot = completed;
        },
      );
    if (rollbackCompleted) {
      return;
    }
    this.preparedLinux = prepared;
    throw new AggregateError(
      [
        ...cleanup
        .filter((result): result is PromiseRejectedResult =>
          result.status === "rejected")
        .map((result) => result.reason),
        ...(!rollingBack
          ? [new Error("The app update rollback authority changed.")]
          : [new Error("The app update rollback authority was not retired.")]),
      ],
      "The app update candidate rollback could not be confirmed.",
    );
  }

  private markLinuxRollbackRequired(
    journal: AppUpdateHandoffJournal,
    expected: AppUpdateHandoffSnapshot,
  ): AppUpdateHandoffSnapshot | null {
    try {
      const current = journal.current();
      if (!current || !exactHandoffSnapshotMatches(current, expected)) {
        return null;
      }
      if (
        current.phase === "rollback-required"
        || current.phase === "rollback-completed"
      ) return current;
      if (current.phase === "completed") return null;
      return journal.transition(
        appUpdateHandoffOwner(current),
        "rollback-required",
      );
    } catch {
      // Durable recovery retains any phase that could not advance exactly.
      return null;
    }
  }

  private completeLinuxRollback(
    journal: AppUpdateHandoffJournal,
    expected: AppUpdateHandoffSnapshot,
    remember: (snapshot: AppUpdateHandoffSnapshot) => void = () => undefined,
  ): boolean {
    try {
      const rollingBack = journal.current();
      if (!rollingBack && expected.phase === "rollback-completed") return true;
      if (
        !rollingBack
        || !exactHandoffSnapshotMatches(rollingBack, expected)
      ) return false;
      const completed = rollingBack.phase === "rollback-completed"
        ? rollingBack
        : rollingBack.phase === "rollback-required"
          ? journal.transition(
              appUpdateHandoffOwner(rollingBack),
              "rollback-completed",
            )
          : null;
      if (!completed) return false;
      remember(completed);
      return journal.retire(appUpdateHandoffOwner(completed));
    } catch {
      // Durable recovery retains any phase that could not be retired exactly.
      return false;
    }
  }

  private async prepareWindowsInstall(
    context: AppUpdateInstallContext,
  ): Promise<boolean> {
    const installerPath = this.downloadedInstallerPath;
    if (!installerPath) return false;
    const operationId = randomUUID();
    const handoffToken = createAppUpdateHandoffToken();
    let installerIdentity: WindowsAppUpdateInstallerIdentity | null = null;
    let oldExecutableIdentity: AppUpdateArtifactIdentity | null = null;
    let journal: AppUpdateHandoffJournal | null = null;
    let vault: AppUpdateHandoffTokenVault | null = null;
    let expectedPreparation: AppUpdateHandoffPreparation | null = null;
    let snapshot: AppUpdateHandoffSnapshot | null = null;
    let preparedState: NonNullable<
      ElectronAppUpdaterAdapter["preparedWindows"]
    > | null = null;
    try {
      [installerIdentity, oldExecutableIdentity] = await Promise.all([
        windowsAppUpdateInstallerIdentity(installerPath),
        appUpdateArtifactIdentity(this.executablePath),
      ]);
      journal = new AppUpdateHandoffJournal(context.handoffDirectory);
      vault = new AppUpdateHandoffTokenVault(context.handoffDirectory);
      const now = Date.now();
      expectedPreparation = {
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
      };
      const prepared = journal.prepare(expectedPreparation);
      if (!prepared) {
        throw new Error("The Windows app update receipt could not be prepared.");
      }
      snapshot = prepared;
      preparedState = {
        journal,
        vault,
        installerPath,
        installerIdentity,
        oldExecutableIdentity,
        dataDirectory: context.dataDirectory,
        handoffToken,
        snapshot: prepared,
        nativeInvocationStarted: false,
      };
      if (!vault.publish(prepared, handoffToken)) {
        throw new Error("The Windows app update receipt could not be prepared.");
      }
      this.preparedWindows = preparedState;
      return true;
    } catch {
      if (
        installerIdentity
        && oldExecutableIdentity
        && journal
        && vault
        && expectedPreparation
        && !snapshot
      ) {
        try {
          const recovered = journal.current();
          if (
            recovered
            && appUpdateHandoffIdentityMatches(
              recovered,
              expectedPreparation,
            )
          ) {
            snapshot = recovered;
            preparedState = {
              journal,
              vault,
              installerPath,
              installerIdentity,
              oldExecutableIdentity,
              dataDirectory: context.handoffDirectory,
              handoffToken,
              snapshot: recovered,
              nativeInvocationStarted: false,
            };
          }
        } catch {
          // Startup recovery retains any publication that cannot be read exactly.
        }
      }
      if (preparedState) {
        if (!this.retireWindowsRollback(preparedState)) {
          this.preparedWindows = preparedState;
        }
      } else if (journal && vault && snapshot) {
        const incomplete = { journal, vault, snapshot };
        if (!this.retireWindowsRollback(incomplete)) {
          // The exact durable operation remains startup recovery authority.
        }
      }
      return false;
    }
  }

  private retireWindowsRollback(
    prepared: {
      readonly journal: AppUpdateHandoffJournal;
      readonly vault: AppUpdateHandoffTokenVault;
      snapshot: AppUpdateHandoffSnapshot;
    },
  ): boolean {
    try {
      const current = prepared.journal.current();
      if (!current || !exactHandoffSnapshotMatches(
        current,
        prepared.snapshot,
      )) return false;
      if (current.phase === "rollback-completed") {
        return prepared.vault.discard(current)
          && prepared.journal.retire(appUpdateHandoffOwner(current));
      }
      if (
        current.phase !== "prepared"
        && current.phase !== "old-generation-cleanup-confirmed"
      ) return false;
      const completed = prepared.journal.transition(
        appUpdateHandoffOwner(current),
        "rollback-completed",
      );
      if (!completed) return false;
      prepared.snapshot = completed;
      return prepared.vault.discard(completed)
        && prepared.journal.retire(appUpdateHandoffOwner(completed));
    } catch {
      // Startup recovery retains any ambiguous native-installer authority.
      return false;
    }
  }

  private markWindowsInstallUncertain(
    prepared: NonNullable<ElectronAppUpdaterAdapter["preparedWindows"]>,
  ): AppUpdateHandoffSnapshot | null {
    try {
      const current = prepared.journal.current();
      if (!current || !exactHandoffSnapshotMatches(
        current,
        prepared.snapshot,
      )) return null;
      if (current.phase === "rollback-required") {
        prepared.snapshot = current;
        return current;
      }
      if (current.phase === "rollback-completed" || current.phase === "completed") {
        return null;
      }
      const uncertain = prepared.journal.transition(
        appUpdateHandoffOwner(current),
        "rollback-required",
      );
      if (uncertain) prepared.snapshot = uncertain;
      return uncertain;
    } catch {
      // Never erase a receipt when native installer outcome is uncertain.
      return null;
    }
  }

  quitAndInstall(
    onHandoff: () => void = () => undefined,
  ): Promise<AppUpdaterInstallResult> {
    if (this.platform !== "win32") return this.quitAndInstallOwned(onHandoff);
    if (this.windowsInstallPromise) return this.windowsInstallPromise;
    const operation = this.quitAndInstallOwned(onHandoff).finally(() => {
      if (this.windowsInstallPromise === operation) {
        this.windowsInstallPromise = null;
      }
    });
    this.windowsInstallPromise = operation;
    return operation;
  }

  private async quitAndInstallOwned(
    onHandoff: () => void,
  ): Promise<AppUpdaterInstallResult> {
    if (this.platform === "linux") {
      if (this.preparedLinux) {
        const prepared = this.preparedLinux;
        try {
          if (!prepared.candidate.alive()) throw new Error("The update candidate exited.");
          const acknowledged = prepared.journal.current();
          if (
            !acknowledged
            || acknowledged.phase !== "candidate-bootstrap-validated"
            || acknowledged.checksum !== prepared.snapshot.checksum
            || !appUpdateHandoffIdentityMatches(
              acknowledged,
              prepared.snapshot,
            )
          ) {
            throw new Error("The update candidate acknowledgement was lost.");
          }
          const cleaned = prepared.journal.transition(
            appUpdateHandoffOwner(acknowledged),
            "old-generation-cleanup-confirmed",
          );
          if (!cleaned) throw new Error("Update cleanup could not be recorded.");
          prepared.snapshot = cleaned;
          const installedPath = await prepared.transaction.commit();
          const committed = prepared.journal.transition(
            appUpdateHandoffOwner(cleaned),
            "ownership-transfer-committed",
          );
          if (!committed) {
            throw new Error("Update ownership could not be transferred.");
          }
          prepared.snapshot = committed;
          if (!prepared.candidate.alive()) {
            throw new Error("Update ownership could not be transferred.");
          }
          this.activeAppImagePath = installedPath;
          this.environment.APPIMAGE = installedPath;
          await prepared.candidate.transferContainment();
          this.preparedLinux = null;
          onHandoff();
          this.application.quit();
          return "handoff-confirmed";
        } catch {
          await this.abortPreparedLinux(prepared);
          return "not-invoked";
        }
      }
      // Linux adoption is valid only after prepareInstall has launched the
      // restricted candidate and received its exact bootstrap acknowledgement.
      // Retaining the former direct-launch fallback here would let callers
      // treat process spawn as readiness and bypass the durable handoff phases.
      return "not-invoked";
    }
    if (this.platform === "win32") {
      const preparedWindows = this.preparedWindows;
      if (!preparedWindows) return "not-invoked";
      try {
        const current = preparedWindows.journal.current();
        const installerIdentity = await appUpdateArtifactIdentity(
          preparedWindows.installerPath,
        );
        if (
          !current
          || current.phase !== "prepared"
          || current.checksum !== preparedWindows.snapshot.checksum
          || !appUpdateHandoffIdentityMatches(
            current,
            preparedWindows.snapshot,
          )
          || !preparedWindows.vault.matches(preparedWindows.snapshot)
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
        preparedWindows.snapshot = cleaned;
      } catch {
        const retired = this.retireWindowsRollback(preparedWindows);
        if (retired && this.preparedWindows === preparedWindows) {
          this.preparedWindows = null;
        }
        return retired ? "not-invoked" : "native-outcome-uncertain";
      }
      try {
        preparedWindows.nativeInvocationStarted = true;
        await this.launchWindowsSupervisor({
          dataDirectory: preparedWindows.dataDirectory,
          installerPath: preparedWindows.installerPath,
          installerIdentity: preparedWindows.installerIdentity,
          oldExecutablePath: this.executablePath,
          oldExecutableIdentity: preparedWindows.oldExecutableIdentity,
          newExecutableDigest:
            preparedWindows.installerIdentity.candidateExecutableDigest,
          snapshot: preparedWindows.snapshot,
          handoffToken: preparedWindows.handoffToken,
        });
      } catch (error) {
        if (error instanceof WindowsUpdateSupervisorCleanupError) {
          // The shared native operation may belong to another adapter/process,
          // or may already have published its terminal receipt. Preserve the
          // exact cleanup-confirmed snapshot and token without advancing it to
          // rollback-required; startup receipt recovery owns reconciliation.
          return "native-outcome-uncertain";
        }
        preparedWindows.nativeInvocationStarted = false;
        const retired = this.retireWindowsRollback(preparedWindows);
        if (retired && this.preparedWindows === preparedWindows) {
          this.preparedWindows = null;
        }
        return retired ? "not-invoked" : "native-outcome-uncertain";
      }
      let admittedCurrent: AppUpdateHandoffSnapshot | null = null;
      try {
        admittedCurrent = preparedWindows.journal.current();
      } catch {
        // Any concurrent journal mutation after READY retains native authority.
      }
      if (
        this.preparedWindows !== preparedWindows
        || !admittedCurrent
        || admittedCurrent.phase !== "old-generation-cleanup-confirmed"
        || !exactHandoffSnapshotMatches(
          admittedCurrent,
          preparedWindows.snapshot,
        )
      ) {
        this.markWindowsInstallUncertain(preparedWindows);
        return "native-outcome-uncertain";
      }
      if (this.preparedWindows === preparedWindows) {
        this.preparedWindows = null;
      }
      onHandoff();
      this.application.quit();
      return "handoff-confirmed";
    }
    return new Promise((resolve) => {
      let settled = false;
      let invocationStarted = false;
      let nativeListenerInstalled = false;
      let errorListenerInstalled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: AppUpdaterInstallResult): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (nativeListenerInstalled) {
          try {
            this.installSignals.removeListener(
              "before-quit-for-update",
              onNativeHandoff,
            );
          } catch {
            // A retained listener is inert because settlement is checked first.
          }
        }
        if (errorListenerInstalled) {
          try {
            this.updater.removeListener("error", onError);
          } catch {
            // A retained listener is inert because settlement is checked first.
          }
        }
        resolve(result);
      };
      const failBeforeInvocation = (): void => finish("not-invoked");
      const failUncertain = (): void => {
        if (settled) return;
        finish("native-outcome-uncertain");
      };
      const onNativeHandoff = (): void => {
        if (settled || !invocationStarted) return;
        try {
          onHandoff();
          finish("handoff-confirmed");
        } catch {
          finish("native-outcome-uncertain");
        }
      };
      const onError = (): void => {
        if (settled) return;
        if (invocationStarted) failUncertain();
        else failBeforeInvocation();
      };
      try {
        nativeListenerInstalled = true;
        this.installSignals.on("before-quit-for-update", onNativeHandoff);
        errorListenerInstalled = true;
        this.updater.on("error", onError);
      } catch {
        failBeforeInvocation();
        return;
      }
      if (settled) return;
      timeout = setTimeout(failUncertain, INSTALL_HANDOFF_TIMEOUT_MS);
      timeout.unref?.();
      try {
        invocationStarted = true;
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
    const rollingBack = this.markLinuxRollbackRequired(
      prepared.journal,
      prepared.snapshot,
    );
    if (rollingBack) prepared.snapshot = rollingBack;
    const cleanup = await Promise.allSettled([
      prepared.candidate.abort(),
      rollingBack?.phase === "rollback-required"
        ? prepared.transaction.rollback()
        : Promise.resolve(),
    ]);
    const rollbackCompleted = !!rollingBack
      && cleanup.every((result) => result.status === "fulfilled")
      && this.completeLinuxRollback(
        prepared.journal,
        rollingBack,
        (completed) => {
          prepared.snapshot = completed;
        },
      );
    if (rollbackCompleted) {
      return;
    }
    this.preparedLinux = prepared;
    throw new AggregateError(
      [
        ...cleanup
          .filter((result): result is PromiseRejectedResult =>
            result.status === "rejected")
          .map((result) => result.reason),
        ...(!rollingBack
          ? [new Error("The app update rollback authority changed.")]
          : rollbackCompleted
            ? []
            : [new Error("The app update rollback authority was not retired.")]),
      ],
      "The app update candidate rollback could not be confirmed.",
    );
  }
}
