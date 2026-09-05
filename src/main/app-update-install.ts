import type { RuntimeUpdatePreparationBlocker, RuntimeUpdatePreparationResult } from "../node/runtime-process-protocol.js";
import type { AppUpdateInstallBlocker, AppUpdateStatus } from "../shared/desktop.js";
import type {
  AppUpdateInstallRuntimeContext,
  AppUpdaterInstallResult,
} from "./electron-app-updater.js";
import { finishNormalShutdownAfterCleanup } from "./privileged-shutdown.js";

interface UpdateService {
  current(): AppUpdateStatus;
  beginInstall(): AppUpdateStatus;
  blockInstall(blocker: AppUpdateInstallBlocker): AppUpdateStatus;
  failInstall(): AppUpdateStatus;
  prepareInstall?(context: AppUpdateInstallRuntimeContext): Promise<boolean>;
  abortInstall?(): Promise<void>;
  quitAndInstall(onHandoff: () => void): Promise<AppUpdaterInstallResult>;
}

interface RuntimeUpdateGate {
  prepareForUpdate(): Promise<RuntimeUpdatePreparationResult>;
  releaseUpdatePreparation(): Promise<boolean>;
}

interface PrivateConnectUpdateGate {
  prepareForUpdate(): Promise<boolean>;
  releaseUpdatePreparation(): Promise<void>;
}

export interface AppUpdateInstallCoordinatorOptions {
  service: UpdateService;
  runtime(): RuntimeUpdateGate | null;
  privateConnect(): PrivateConnectUpdateGate | null;
  cleanup(): Promise<boolean>;
  handoffContext?(): AppUpdateInstallRuntimeContext | null;
  finishNormalShutdown(): void;
  onUnconfirmedShutdown?(): void;
  reportError(error: unknown): void;
}

type InstallMode =
  | "running"
  | "update-preparing"
  | "update-outcome-uncertain"
  | "normal-cleanup"
  | "update-handoff";

export function appUpdateInstallBlocker(
  blocker: RuntimeUpdatePreparationBlocker,
): AppUpdateInstallBlocker {
  if (blocker === "agent-work") return "active-work";
  if (blocker === "terminal") return "terminal";
  if (blocker === "database-recovery") return "database-recovery";
  if (blocker === "provider-maintenance") return "maintenance";
  return "local-operation";
}

export function appUpdateInstallRuntimeContext(
  identity: {
    readonly runtimeGenerationId: string;
    readonly systemBootId: string;
  } | null | undefined,
  dataDirectory: string | null,
  profileDirectory: string,
): AppUpdateInstallRuntimeContext | null {
  return identity && dataDirectory
    ? Object.freeze({
        handoffDirectory: dataDirectory,
        profileDirectory,
        dataDirectory,
        oldRuntimeGenerationId: identity.runtimeGenerationId,
        systemBootId: identity.systemBootId,
      })
    : null;
}

/** Serializes normal quit and updater handoff around one privileged cleanup. */
export class AppUpdateInstallCoordinator {
  private mode: InstallMode = "running";
  private installPromise: Promise<AppUpdateStatus> | null = null;
  private normalShutdown: Promise<void> | null = null;
  private cleanupStarted = false;

  constructor(private readonly options: AppUpdateInstallCoordinatorOptions) {}

  install(): Promise<AppUpdateStatus> {
    if (this.installPromise) return this.installPromise;
    if (this.mode !== "running") return Promise.resolve(this.options.service.current());
    this.options.service.beginInstall();
    this.mode = "update-preparing";
    const installing = this.prepareAndInstall().finally(() => {
      if (this.installPromise === installing) this.installPromise = null;
    });
    this.installPromise = installing;
    return installing;
  }

  /** Returns true only for the updater-generated quit after complete cleanup. */
  allowBeforeQuit(): boolean {
    if (this.mode === "update-handoff") return true;
    if (this.mode === "update-outcome-uncertain") {
      this.reportUnconfirmedShutdown();
      return false;
    }
    this.beginNormalShutdown();
    return false;
  }

  private beginNormalShutdown(): void {
    if (this.normalShutdown) return;
    this.mode = "normal-cleanup";
    const pendingInstall = this.installPromise;
    const stopping = Promise.resolve()
      .then(async () => await this.options.service.abortInstall?.())
      .then(async () => await pendingInstall?.catch(() => undefined))
      .then(() => this.releasePreparation())
      .then(() => this.options.cleanup())
      .then((cleanupConfirmed) => {
        finishNormalShutdownAfterCleanup({
          cleanupConfirmed,
          finish: this.options.finishNormalShutdown,
          onUnconfirmed: () => this.reportUnconfirmedShutdown(),
        });
      })
      .catch((error: unknown) => {
        this.options.reportError(error);
        this.reportUnconfirmedShutdown();
      });
    this.normalShutdown = stopping;
  }

  private async prepareAndInstall(): Promise<AppUpdateStatus> {
    const { service } = this.options;
    let cleanupConfirmed = false;
    let candidatePreparationStarted = false;
    let installInvocationStarted = false;
    try {
      const runtime = this.options.runtime();
      if (!runtime) return this.block("runtime-transition");
      const prepared = await runtime.prepareForUpdate();
      if (this.mode !== "update-preparing") {
        await runtime.releaseUpdatePreparation().catch(() => false);
        return service.current();
      }
      if (!prepared.ready) return this.block(appUpdateInstallBlocker(prepared.blocker));

      const privateConnect = this.options.privateConnect();
      const privateConnectReady = await privateConnect?.prepareForUpdate() ?? true;
      if (this.mode !== "update-preparing") {
        await this.releasePreparation();
        return service.current();
      }
      if (!privateConnectReady) {
        await runtime.releaseUpdatePreparation();
        return this.block("private-connect");
      }

      if (service.prepareInstall) {
        const context = this.options.handoffContext?.() ?? null;
        if (!context) {
          await this.releasePreparation();
          return this.block("runtime-transition");
        }
        candidatePreparationStarted = true;
        const candidateReady = await service.prepareInstall(context);
        if (this.mode !== "update-preparing") {
          await service.abortInstall?.().catch(() => undefined);
          await this.releasePreparation();
          return service.current();
        }
        if (!candidateReady) {
          await service.abortInstall?.().catch(() => undefined);
          await this.releasePreparation();
          this.mode = "running";
          return service.failInstall();
        }
      }

      this.cleanupStarted = true;
      cleanupConfirmed = await this.options.cleanup();
      if (!cleanupConfirmed && this.mode !== "update-preparing") {
        return service.failInstall();
      }
      if (this.mode !== "update-preparing") return service.current();
      if (!cleanupConfirmed) {
        await service.abortInstall?.().catch(() => undefined);
        return this.failClosed(false);
      }

      installInvocationStarted = true;
      const installResult = await service.quitAndInstall(() => {
        if (this.mode === "update-preparing") this.mode = "update-handoff";
      });
      if (this.currentMode() === "normal-cleanup") return service.current();
      if (installResult === "native-outcome-uncertain") {
        return this.failUncertainInstall();
      }
      if (installResult === "not-invoked") {
        try {
          await service.abortInstall?.();
        } catch (error) {
          this.options.reportError(error);
          return this.failUncertainInstall();
        }
        return this.failClosed(true);
      }
      if (this.currentMode() !== "update-handoff") {
        await service.abortInstall?.().catch(() => undefined);
        return this.failClosed(true);
      }
      return service.current();
    } catch (error) {
      this.options.reportError(error);
      if (installInvocationStarted) return this.failUncertainInstall();
      if (this.mode === "normal-cleanup") {
        if (candidatePreparationStarted) {
          await service.abortInstall?.().catch(() => undefined);
        }
        return this.cleanupStarted ? service.failInstall() : service.current();
      }
      // cleanup() is idempotent. Calling it again here distinguishes a held
      // preparation failure from an irreversible, partially stopped runtime.
      if (this.cleanupStarted) return this.failClosed(cleanupConfirmed);
      if (candidatePreparationStarted) {
        await service.abortInstall?.().catch(() => undefined);
        await this.releasePreparation();
        this.mode = "running";
        return service.failInstall();
      }
      await this.releasePreparation();
      return this.block("runtime-transition");
    }
  }

  private block(blocker: AppUpdateInstallBlocker): AppUpdateStatus {
    if (this.mode === "update-preparing") this.mode = "running";
    return this.options.service.blockInstall(blocker);
  }

  private currentMode(): InstallMode {
    return this.mode;
  }

  private failClosed(cleanupConfirmed: boolean): AppUpdateStatus {
    const status = this.options.service.failInstall();
    this.mode = "normal-cleanup";
    finishNormalShutdownAfterCleanup({
      cleanupConfirmed,
      finish: this.options.finishNormalShutdown,
      onUnconfirmed: () => this.reportUnconfirmedShutdown(),
    });
    return status;
  }

  private failUncertainInstall(): AppUpdateStatus {
    const status = this.options.service.failInstall();
    this.mode = "update-outcome-uncertain";
    this.reportUnconfirmedShutdown();
    return status;
  }

  private reportUnconfirmedShutdown(): void {
    if (this.options.onUnconfirmedShutdown) {
      this.options.onUnconfirmedShutdown();
      return;
    }
    this.options.reportError(new Error(
      "Refusing to exit because privileged shutdown could not be confirmed.",
    ));
  }

  private async releasePreparation(): Promise<void> {
    const runtime = this.options.runtime();
    const privateConnect = this.options.privateConnect();
    await Promise.all([
      runtime?.releaseUpdatePreparation().catch(() => false),
      privateConnect?.releaseUpdatePreparation().catch(() => undefined),
    ]);
  }
}
