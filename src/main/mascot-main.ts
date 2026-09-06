import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app, BrowserWindow, ipcMain, Menu, screen,
  type IpcMainInvokeEvent, type Session, type WebContents,
} from "electron";
import {
  emptyMascotStatus, MASCOT_ACTIONS, MASCOT_IPC, MASCOT_LABELS,
  parseMascotPreferences, parseMascotStatus, type MascotAction, type MascotSnapshot, type MascotStatus,
} from "../shared/mascot.js";
import {
  mascotBounds, MASCOT_SIZE, readMascotWindowState, supportsMascotPlacement, writeMascotWindowState,
} from "./mascot-placement.js";
import { hardenDesktopSession } from "./preview-broker.js";

interface MascotMainOptions {
  mainWindow(): BrowserWindow | null;
  rendererUrl: string;
  userDataDirectory: string;
  registerProtocol(session: Session): void;
  registerHealthRenderer(contents: WebContents): () => void;
  openChat(conversationId: string): Promise<void>;
}

export class MascotMain {
  private readonly statePath: string;
  private readonly rendererUrl: string;
  private state;
  private status = emptyMascotStatus("unavailable");
  private window: BrowserWindow | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private suspended = false;
  private registered = false;
  private readonly canPosition = supportsMascotPlacement(process.platform, process.env, app.commandLine.getSwitchValue("ozone-platform"));

  constructor(private readonly options: MascotMainOptions) {
    this.statePath = join(options.userDataDirectory, "mascot-window-state.json");
    this.state = readMascotWindowState(this.statePath);
    this.rendererUrl = new URL("mascot.html", options.rendererUrl).href;
  }

  snapshot(): MascotSnapshot { return { preferences: { ...this.state.preferences }, status: { ...this.status }, ...(!this.canPosition ? { placement: "system" as const } : {}) }; }

  observe(status: MascotStatus): void {
    this.status = status;
    this.broadcast();
  }

  runtimePhase(phase: string): void {
    if (phase !== "ready") this.observe(emptyMascotStatus("unavailable"));
  }

  attach(): void {
    this.suspended = false;
    if (!this.registered) {
      this.registered = true;
      ipcMain.handle(MASCOT_IPC.snapshot, (event, ...args) => {
        this.assertSender(event, args.length, 0);
        return this.snapshot();
      });
      ipcMain.handle(MASCOT_IPC.configure, async (event, ...args) => {
        this.assertSender(event, args.length, 1, true);
        const preferences = parseMascotPreferences(args[0]);
        if (!preferences) throw new Error("Invalid mascot preferences");
        this.state.preferences = preferences;
        this.save();
        await this.reconcile();
        this.broadcast();
        return this.snapshot();
      });
      ipcMain.handle(MASCOT_IPC.action, async (event, ...args) => {
        this.assertSender(event, args.length, args[0] === "open-chat" ? 2 : 1);
        if (!MASCOT_ACTIONS.includes(args[0] as MascotAction)) throw new Error("Invalid mascot action");
        const expected = args[0] === "open-chat" ? parseMascotStatus(args[1]) : null;
        if (args[0] === "open-chat" && !expected) throw new Error("Invalid mascot chat identity");
        await this.action(args[0] as MascotAction, expected ?? undefined);
      });
      screen.on("display-added", this.reposition);
      screen.on("display-removed", this.reposition);
      screen.on("display-metrics-changed", this.reposition);
    }
    void this.reconcile().catch(() => undefined);
  }

  suspend(): void {
    this.suspended = true;
    this.destroyWindow();
  }

  private assertSender(event: IpcMainInvokeEvent, count: number, expected: number, mainOnly = false): void {
    const main = this.options.mainWindow();
    const ownedMain = main && !main.isDestroyed() && event.sender === main.webContents;
    const ownedMascot = !mainOnly && this.window && !this.window.isDestroyed()
      && event.sender === this.window.webContents;
    if (count !== expected || (!ownedMain && !ownedMascot)
      || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame.url !== (ownedMain ? this.options.rendererUrl : this.rendererUrl)) {
      throw new Error("Rejected untrusted mascot request");
    }
  }

  private async reconcile(): Promise<void> {
    if (!this.state.preferences.enabled || this.suspended) { this.destroyWindow(); return; }
    if (this.window && !this.window.isDestroyed()) return;
    const window = new BrowserWindow({
      title: "Inertia mascot", ...(this.canPosition ? mascotBounds(this.state.position, screen.getAllDisplays()) : MASCOT_SIZE),
      show: false, frame: false, transparent: true, backgroundColor: "#00000000",
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
      webPreferences: {
        preload: fileURLToPath(new URL("../preload/mascot.cjs", import.meta.url)),
        partition: "inertia-mascot", contextIsolation: true, sandbox: true,
        nodeIntegration: false, webSecurity: true, webviewTag: false,
        backgroundThrottling: true, allowRunningInsecureContent: false,
      },
    });
    this.window = window;
    const unregister = this.options.registerHealthRenderer(window.webContents);
    this.options.registerProtocol(window.webContents.session);
    hardenDesktopSession(window.webContents.session);
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("context-menu", () => this.menu(window));
    window.webContents.on("render-process-gone", () => this.failed());
    window.on("move", this.scheduleSave);
    window.on("blur", () => window.setFocusable(false));
    window.on("closed", () => {
      unregister();
      if (this.window === window) this.window = null;
    });
    // Cut away unused corners on platforms with native input-region support.
    if (process.platform !== "darwin" && this.canPosition) window.setShape([
      { x: 4, y: 0, width: 232, height: 118 },
      { x: 108, y: 116, width: 36, height: 36 },
      { x: 72, y: 136, width: 96, height: 98 },
    ]);
    try { await window.loadURL(this.rendererUrl); }
    catch {
      if (this.window === window) this.failed();
      throw new Error("The mascot window could not be loaded.");
    }
    if (this.window === window && !window.isDestroyed()) window.showInactive();
  }

  private failed(): void {
    this.destroyWindow();
    this.state.preferences.enabled = false;
    this.save();
    this.broadcast();
  }

  private destroyWindow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const window = this.window;
    if (window && !window.isDestroyed()) {
      if (this.canPosition) {
        const { x, y } = window.getBounds();
        this.state.position = { x, y };
      }
      this.save();
      window.destroy();
    }
    this.window = null;
  }

  private readonly reposition = (): void => {
    const window = this.window;
    if (!this.canPosition || !window || window.isDestroyed()) return;
    const bounds = mascotBounds(window.getBounds(), screen.getAllDisplays());
    const current = window.getBounds();
    if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) window.setBounds(bounds);
    this.state.position = { x: bounds.x, y: bounds.y };
    this.save();
  };

  private readonly scheduleSave = (): void => {
    if (!this.canPosition) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.reposition(); }, 200);
  };

  private save(): void {
    try { writeMascotWindowState(this.statePath, this.state); }
    catch { /* A read-only profile must not break the workbench or mascot. */ }
  }

  private broadcast(): void {
    const snapshot = this.snapshot();
    for (const window of [this.window, this.options.mainWindow()]) {
      if (window && !window.isDestroyed()) window.webContents.send(MASCOT_IPC.changed, snapshot);
    }
  }

  private async action(action: MascotAction, expectedStatus?: MascotStatus): Promise<void> {
    if (action === "open-chat") {
      if (!expectedStatus || ["projectId", "conversationId", "runId", "turnId"].some(
        (key) => expectedStatus[key as keyof MascotStatus] !== this.status[key as keyof MascotStatus],
      )) throw new Error("The mascot chat has changed. Try again.");
      if (this.status.conversationId) await this.options.openChat(this.status.conversationId);
      return;
    }
    if (action === "hide") this.state.preferences.enabled = false;
    else if (action === "pause" || action === "resume") this.state.preferences.motion = action === "resume";
    else if (action === "focus") {
      this.window?.setFocusable(true);
      this.window?.show();
      this.window?.focus();
      this.window?.webContents.focus();
    } else {
      if (!this.canPosition) return;
      const position = this.window?.getBounds() ?? this.state.position;
      this.state.position = action === "reset-position" || !position ? null : {
        x: position.x + (action === "left" ? -16 : action === "right" ? 16 : 0),
        y: position.y + (action === "up" ? -16 : action === "down" ? 16 : 0),
      };
      this.window?.setBounds(mascotBounds(this.state.position, screen.getAllDisplays()));
    }
    this.save();
    await this.reconcile();
    this.broadcast();
  }

  private menu(window: BrowserWindow): void {
    const status = { ...this.status };
    Menu.buildFromTemplate([
      { label: MASCOT_LABELS[this.status.phase], enabled: false },
      { label: "Open chat", enabled: Boolean(status.conversationId), click: () => { void this.action("open-chat", status).catch(() => undefined); } },
      { label: this.state.preferences.motion ? "Pause animation" : "Resume animation", click: () => { void this.action(this.state.preferences.motion ? "pause" : "resume"); } },
      { label: "Hide mascot", click: () => { void this.action("hide"); } },
    ]).popup({ window });
  }
}
