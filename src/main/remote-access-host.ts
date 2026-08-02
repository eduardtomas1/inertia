import { join } from "node:path";
import { lstat, readdir } from "node:fs/promises";

import {
  ipcMain,
  powerMonitor,
  safeStorage,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";

import {
  REMOTE_ACCESS_IPC,
  parseRemoteAccessEnableRequest,
  parseRemoteDeviceUpdateRequest,
  parseRemotePairingApprovalRequest,
} from "../shared/desktop";
import type { RemoteAccessState } from "../shared/remote-protocol";
import type { RuntimeSupervisor } from "./runtime-supervisor";
import { RemoteAccessService } from "./remote-access-service";
import {
  createRemoteStoreEncryption,
  RemoteAccessStore,
} from "./remote-access-store";
import { RemotePrivacyMonitor } from "./remote-access-lifecycle";
import {
  DEFAULT_REMOTE_COMPANION_URL,
  DEFAULT_REMOTE_RELAY_URL,
  emptyRemoteSetupDiagnostics,
} from "./remote-access-policy";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface RemoteAccessHostOptions {
  userDataDirectory: string;
  runtime: RuntimeSupervisor;
  window(): BrowserWindow | null;
  assertTrusted(
    event: IpcMainInvokeEvent,
    argumentCount: number,
    expectedArguments?: number,
  ): void;
}

export class RemoteAccessHost {
  private service: RemoteAccessService | null = null;
  private serviceInitialization: Promise<void> | null = null;
  private initializationError: string | null =
    "Remote Companion secure storage is initializing.";
  private readonly privacyMonitor: RemotePrivacyMonitor;
  private privacyDiagnostic: string | null = null;
  private stopped = false;

  private constructor(private readonly options: RemoteAccessHostOptions) {
    this.privacyMonitor = new RemotePrivacyMonitor(
      powerMonitor,
      (locked, suspension) =>
        this.service?.setPrivacyLocked(locked, suspension),
      (detail) => {
        this.privacyDiagnostic = detail;
      },
    );
    this.registerIpc(options.assertTrusted);
  }

  static create(
    options: RemoteAccessHostOptions,
  ): RemoteAccessHost {
    const host = new RemoteAccessHost(options);
    void host.startInitialization(true);
    return host;
  }

  private startInitialization(onlyIfPersisted: boolean): Promise<void> {
    if (this.serviceInitialization) return this.serviceInitialization;
    const initialization = (
      onlyIfPersisted ? this.initializeIfPersisted() : this.initialize()
    ).catch(() => {
      if (this.stopped) return;
      this.initializationError =
        "Remote Companion secure storage could not be initialized.";
      this.emitState(this.state());
    }).finally(() => {
      if (this.serviceInitialization === initialization) {
        this.serviceInitialization = null;
      }
    });
    this.serviceInitialization = initialization;
    return initialization;
  }

  private async initializeIfPersisted(): Promise<void> {
    const path = join(this.options.userDataDirectory, "remote-access.vault");
    const metadata = await lstat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (metadata === null) {
      if (await this.hasRecoverableVault()) {
        await this.initialize();
        return;
      }
      this.initializationError = null;
      this.emitState(this.state());
      return;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("The encrypted Remote Companion store is invalid.");
    }
    await this.initialize();
  }

  private async hasRecoverableVault(): Promise<boolean> {
    const names = await readdir(this.options.userDataDirectory)
      .catch(() => null);
    if (!names) return false;
    return names.some((name) =>
      /^\.remote-access-vault-[0-9a-f-]{36}\.(?:stage|backup)$/u.test(name));
  }

  private async initialize(): Promise<void> {
    const store = new RemoteAccessStore(
      join(this.options.userDataDirectory, "remote-access.vault"),
      await createRemoteStoreEncryption(safeStorage),
    );
    const service = await RemoteAccessService.create({
      store,
      runtime: this.options.runtime,
      onStateChange: (state) => {
        this.emitState(state);
      },
      autoConnect: false,
      initialPrivacy: this.privacyMonitor.suspension,
    });
    if (this.stopped) {
      await service.shutdown();
      return;
    }
    service.setPrivacyLocked(
      this.privacyMonitor.locked,
      this.privacyMonitor.suspension,
    );
    this.service = service;
    const state = service.state();
    service.startConnections();
    this.initializationError = state.connectionMessage
      ?? "Remote Companion is unavailable.";
    this.emitState(service.state());
  }

  lockStateDiagnostic(): string | null {
    return this.privacyMonitor.probeDiagnostic ?? this.privacyDiagnostic;
  }

  state(): RemoteAccessState {
    return this.service?.state() ?? {
      available: this.initializationError === null,
      enabled: false,
      relayUrl: this.initializationError === null
        ? DEFAULT_REMOTE_RELAY_URL
        : "",
      setupMode: "local-development",
      companionUrl: DEFAULT_REMOTE_COMPANION_URL,
      diagnostics: emptyRemoteSetupDiagnostics(),
      connection: "disabled",
      connectionMessage: this.initializationError,
      activeSessions: 0,
      devices: [],
      pendingPairings: [],
      invitation: null,
      audit: [],
    };
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.privacyMonitor.shutdown();
    const activeService = this.service;
    const activeShutdown = activeService?.shutdown();
    await this.serviceInitialization;
    if (this.service && this.service !== activeService) {
      await this.service.shutdown();
    }
    await activeShutdown;
  }

  private emitState(state: RemoteAccessState): void {
    const window = this.options.window();
    if (window && !window.isDestroyed()) {
      window.webContents.send(REMOTE_ACCESS_IPC.stateChanged, state);
    }
  }

  private requireService(): RemoteAccessService {
    if (!this.service) {
      throw new Error(
        this.initializationError ?? "Remote Companion is unavailable.",
      );
    }
    return this.service;
  }

  private async ensureService(): Promise<RemoteAccessService> {
    if (this.serviceInitialization) await this.serviceInitialization;
    if (!this.service) await this.startInitialization(false);
    return this.requireService();
  }

  private registerIpc(
    assertTrusted: RemoteAccessHostOptions["assertTrusted"],
  ): void {
    ipcMain.handle(REMOTE_ACCESS_IPC.getState, (event, ...args) => {
      assertTrusted(event, args.length);
      return this.state();
    });
    ipcMain.handle(REMOTE_ACCESS_IPC.setEnabled, async (event, ...args) => {
      assertTrusted(event, args.length, 1);
      const request = parseRemoteAccessEnableRequest(args[0]);
      if (!request) throw new Error("Invalid Remote Companion settings.");
      const service = await this.ensureService();
      if (request.testOnly) {
        if (
          request.enabled
          || request.setupMode === undefined
          || request.companionUrl === undefined
        ) throw new Error("Invalid Remote Companion setup test.");
        await service.testSetup(
          request.relayUrl,
          request.companionUrl,
          request.setupMode,
          request.resetEndpoint === true,
        );
      } else {
        if (request.resetEndpoint) {
          throw new Error("Invalid Remote Companion endpoint reset.");
        }
        await service.setEnabled(
          request.enabled,
          request.relayUrl,
          request.setupMode,
          request.companionUrl,
        );
      }
      return service.state();
    });
    ipcMain.handle(REMOTE_ACCESS_IPC.createInvitation, async (event, ...args) => {
      assertTrusted(event, args.length);
      return await this.requireService().createInvitation();
    });
    ipcMain.handle(REMOTE_ACCESS_IPC.approvePairing, async (event, ...args) => {
      assertTrusted(event, args.length, 1);
      const request = parseRemotePairingApprovalRequest(args[0]);
      if (!request) throw new Error("Invalid Remote Companion approval.");
      const service = this.requireService();
      await service.approvePairing(
        request.requestId,
        request.scopes,
        request.projectIds,
        request.grantDays * 24 * 60 * 60 * 1_000,
        request.grants ?? undefined,
      );
      return service.state();
    });
    ipcMain.handle(REMOTE_ACCESS_IPC.denyPairing, async (event, ...args) => {
      assertTrusted(event, args.length, 1);
      const [requestId] = args;
      if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId)) {
        throw new Error("Invalid Remote Companion pairing request.");
      }
      const service = this.requireService();
      await service.denyPairing(requestId);
      return service.state();
    });
    ipcMain.handle(REMOTE_ACCESS_IPC.revokeDevice, async (event, ...args) => {
      assertTrusted(event, args.length, 1);
      const [deviceId] = args;
      if (typeof deviceId !== "string" || !UUID_PATTERN.test(deviceId)) {
        throw new Error("Invalid Remote Companion device.");
      }
      const service = this.requireService();
      await service.revokeDevice(deviceId);
      return service.state();
    });
    ipcMain.handle(REMOTE_ACCESS_IPC.updateDevice, async (event, ...args) => {
      assertTrusted(event, args.length, 1);
      const request = parseRemoteDeviceUpdateRequest(args[0]);
      if (!request) throw new Error("Invalid Remote Companion permissions.");
      const service = this.requireService();
      await service.updateDevice(
        request.deviceId,
        request.scopes,
        request.projectIds,
        request.expiresAt,
        request.grants ?? undefined,
      );
      return service.state();
    });
  }
}
