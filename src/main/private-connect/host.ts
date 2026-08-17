import { join, relative, sep } from "node:path";
import { lstat, readFile, readdir, unlink, writeFile } from "node:fs/promises";

import { ipcMain, powerMonitor, safeStorage, type BrowserWindow, type IpcMainInvokeEvent } from "electron";

import {
  PRIVATE_CONNECT_IPC,
  parsePrivateConnectDeviceUpdateRequest,
  parsePrivateConnectEnableRequest,
  parsePrivateConnectPairingApprovalRequest,
} from "../../shared/desktop";
import type { PrivateConnectStateView } from "../../shared/private-connect/protocol";
import type { RuntimeSupervisor } from "../runtime-supervisor";
import { PrivateConnectService } from "./service";
import { createPrivateConnectStoreEncryption, PrivateConnectStore } from "./store";

const MIGRATION_MARKER = "private-connect-migration-v1";
const LEGACY_NAMES = [/^remote-access\.vault$/u, /^\.remote-access-vault-[0-9a-f-]{36}\.(?:stage|backup)$/u];
const DEFAULT_STATE: PrivateConnectStateView = {
  available: false,
  enabled: false,
  status: "off",
  statusMessage: "Private Connect secure storage is initializing.",
  externalUrl: null,
  activeSessions: 0,
  devices: [],
  pendingPairings: [],
  invitation: null,
  notice: null,
  diagnostics: {
    tailscale: "unknown",
    magicDns: "unknown",
    gatewayPort: null,
    servePort: null,
    externalUrl: null,
    mappingOwnership: "unknown",
    errorClass: null,
    setupUrl: null,
  },
};

interface PrivateConnectHostOptions {
  userDataDirectory: string;
  staticRoot: string;
  buildVersion: string;
  runtime: RuntimeSupervisor;
  window(): BrowserWindow | null;
  assertTrusted(event: IpcMainInvokeEvent, argumentCount: number, expectedArguments?: number): void;
}

export class PrivateConnectHost {
  private service: PrivateConnectService | null = null;
  private initialization: Promise<void> | null = null;
  private initializationError: string | null = DEFAULT_STATE.statusMessage;
  private readonly privacyMonitor: PrivateConnectPrivacyMonitor;
  private stopped = false;

  private constructor(private readonly options: PrivateConnectHostOptions) {
    this.privacyMonitor = new PrivateConnectPrivacyMonitor(powerMonitor, (locked) => {
      void this.service?.setPrivacyLocked(locked);
    });
    this.registerIpc(options.assertTrusted);
  }

  static create(options: PrivateConnectHostOptions): PrivateConnectHost {
    const host = new PrivateConnectHost(options);
    void host.initialize();
    return host;
  }

  state(): PrivateConnectStateView {
    return this.service?.state() ?? {
      ...DEFAULT_STATE,
      statusMessage: this.initializationError,
    };
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.privacyMonitor.shutdown();
    await this.initialization;
    await this.service?.shutdown();
    this.service = null;
  }

  async prepareForUpdate(): Promise<boolean> {
    await this.initialization;
    return await this.service?.prepareForUpdate() ?? true;
  }

  async releaseUpdatePreparation(): Promise<void> {
    await this.initialization;
    await this.service?.releaseUpdatePreparation();
  }

  private async initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      try {
        const migration = await cleanupLegacyAuthority(this.options.userDataDirectory);
        const store = new PrivateConnectStore(
          join(this.options.userDataDirectory, "private-connect.vault"),
          await createPrivateConnectStoreEncryption(safeStorage),
        );
        const service = await PrivateConnectService.create({
          store,
          runtime: this.options.runtime,
          staticRoot: this.options.staticRoot,
          buildVersion: this.options.buildVersion,
          onStateChange: (state) => this.emitState(state),
        });
        if (this.stopped) {
          await service.shutdown();
          return;
        }
        this.service = service;
        this.initializationError = null;
        await service.setPrivacyLocked(this.privacyMonitor.isLocked());
        if (migration.cleaned) {
          service.setNotice("Private Connect is ready. Previous browser pairings were removed; pair devices again through Connections & devices.");
        }
        await service.startIfEnabled().catch((error: unknown) => {
          this.initializationError = error instanceof Error ? error.message : "Private Connect could not be restored safely.";
          this.emitState(service.state());
        });
        this.emitState(service.state());
      } catch (error) {
        if (this.stopped) return;
        this.initializationError = error instanceof Error ? error.message : "Private Connect secure storage could not be initialized.";
        this.emitState(this.state());
      }
    })();
    await this.initialization;
  }

  private requireService(): PrivateConnectService {
    if (this.stopped) throw new Error("Private Connect is shutting down.");
    if (!this.service) throw new Error(this.initializationError ?? "Private Connect is unavailable.");
    return this.service;
  }

  private emitState(state: PrivateConnectStateView): void {
    const window = this.options.window();
    if (window && !window.isDestroyed()) window.webContents.send(PRIVATE_CONNECT_IPC.stateChanged, state);
  }

  private registerIpc(assertTrusted: PrivateConnectHostOptions["assertTrusted"]): void {
    ipcMain.handle(PRIVATE_CONNECT_IPC.getState, (event, ...args) => {
      assertTrusted(event, args.length);
      return this.state();
    });
    ipcMain.handle(PRIVATE_CONNECT_IPC.setEnabled, async (event, ...args) => {
      assertTrusted(event, args.length, 1);
      const request = parsePrivateConnectEnableRequest(args[0]);
      if (!request) throw new Error("Invalid Private Connect settings.");
      return await this.requireService().setEnabled(request.enabled);
    });
    ipcMain.handle(PRIVATE_CONNECT_IPC.createInvitation, async (event, ...args) => {
      assertTrusted(event, args.length);
      return await this.requireService().createInvitation();
    });
    ipcMain.handle(PRIVATE_CONNECT_IPC.approvePairing, async (event, ...args) => {
      assertTrusted(event, args.length, 1);
      const request = parsePrivateConnectPairingApprovalRequest(args[0]);
      if (!request) throw new Error("Invalid Private Connect pairing approval.");
      await this.requireService().approvePairing(request.requestId, request.preset, request.projectIds, request.grantDays, request.grants);
      return this.requireService().state();
    });
    ipcMain.handle(PRIVATE_CONNECT_IPC.denyPairing, async (event, ...args) => {
      assertTrusted(event, args.length, 1);
      if (typeof args[0] !== "string") throw new Error("Invalid Private Connect pairing request.");
      await this.requireService().denyPairing(args[0]);
      return this.requireService().state();
    });
    ipcMain.handle(PRIVATE_CONNECT_IPC.revokeDevice, async (event, ...args) => {
      assertTrusted(event, args.length, 1);
      if (typeof args[0] !== "string") throw new Error("Invalid Private Connect device.");
      await this.requireService().revokeDevice(args[0]);
      return this.requireService().state();
    });
    ipcMain.handle(PRIVATE_CONNECT_IPC.updateDevice, async (event, ...args) => {
      assertTrusted(event, args.length, 1);
      const request = parsePrivateConnectDeviceUpdateRequest(args[0]);
      if (!request) throw new Error("Invalid Private Connect device update.");
      await this.requireService().updateDevice(request.deviceId, request.preset, request.projectIds, request.expiresAt, request.grants);
      return this.requireService().state();
    });
  }
}

export class PrivateConnectPrivacyMonitor {
  private stopped = false;
  private locked: boolean;
  constructor(private readonly events: Pick<typeof powerMonitor, "getSystemIdleState" | "on" | "removeListener">, private readonly onLock: (locked: boolean) => void) {
    this.locked = true;
    events.on("lock-screen", this.lock);
    events.on("suspend", this.lock);
    events.on("unlock-screen", this.unlock);
    try {
      const state = events.getSystemIdleState(1);
      this.locked = state !== "active" && state !== "idle";
    } catch {
      this.locked = true;
    }
  }
  isLocked(): boolean { return this.locked; }
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.events.removeListener("lock-screen", this.lock);
    this.events.removeListener("suspend", this.lock);
    this.events.removeListener("unlock-screen", this.unlock);
  }
  private readonly lock = (): void => {
    if (this.stopped) return;
    this.locked = true;
    this.onLock(true);
  };
  private readonly unlock = (): void => {
    if (this.stopped) return;
    this.locked = false;
    this.onLock(false);
  };
}

export async function cleanupLegacyAuthority(userDataDirectory: string): Promise<{ cleaned: boolean }> {
  const entries = await readdir(userDataDirectory).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [] as string[];
    throw new Error("Legacy Private Connect authority files could not be inspected.");
  });
  const candidates = entries.filter((name) => LEGACY_NAMES.some((pattern) => pattern.test(name)));
  let cleaned = false;
  for (const name of candidates) {
    const path = join(userDataDirectory, name);
    const child = relative(userDataDirectory, path);
    if (child === ".." || child.startsWith(`..${sep}`)) throw new Error("Legacy Private Connect cleanup escaped the user-data directory.");
    const metadata = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Legacy authority cleanup found a non-regular file.");
    await unlink(path);
    cleaned = true;
  }
  const marker = join(userDataDirectory, "private-connect-migration-v1");
  const markerValue = await readFile(marker, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (markerValue !== null && markerValue !== `${MIGRATION_MARKER}\n`) {
    throw new Error("Private Connect migration marker is invalid.");
  }
  if (markerValue === null) {
    await writeFile(marker, `${MIGRATION_MARKER}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  return { cleaned };
}
