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
  private drag: { offset: { x: number; y: number }; started: number; gesture: number } | null = null;
  private dragTimer: ReturnType<typeof setInterval> | null = null;
  private pickupOffset: { x: number; y: number } | null = null;
  private epoch = 0;
  private lastGesture = 0;
  private ignoringMouse = false;
  private suspended = false;
  private registered = false;
  private readonly canPosition = supportsMascotPlacement(process.platform, process.env, app.commandLine.getSwitchValue("ozone-platform"));

  constructor(private readonly options: MascotMainOptions) {
    this.statePath = join(options.userDataDirectory, "mascot-window-state.json");
    this.state = readMascotWindowState(this.statePath);
    this.rendererUrl = new URL("mascot.html", options.rendererUrl).href;
  }

  snapshot(): MascotSnapshot { return { preferences: { ...this.state.preferences }, status: { ...this.status }, dragging: Boolean(this.drag), gesture: [this.epoch, this.drag?.gesture ?? this.lastGesture], ...(!this.canPosition ? { placement: "system" as const } : {}) }; }

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
        const dragAction = args[0] === "pickup" || args[0] === "drop";
        this.assertSender(event, args.length, args[0] === "open-chat" || dragAction ? 2 : 1);
        if (!MASCOT_ACTIONS.includes(args[0] as MascotAction)) throw new Error("Invalid mascot action");
        if (dragAction) {
          if (event.sender !== this.window?.webContents) throw new Error("Rejected untrusted mascot drag");
          const gesture = args[1];
          if (!Array.isArray(gesture) || gesture.length !== 2 || Object.keys(gesture).join(",") !== "0,1"
            || !gesture.every((part) => Number.isSafeInteger(part) && part > 0)) {
            throw new Error("Invalid mascot gesture");
          }
          if (gesture[0] !== this.epoch) return;
          if (args[0] === "pickup") this.beginDrag(gesture[1] as number);
          else {
            this.lastGesture = Math.max(this.lastGesture, gesture[1] as number);
            this.endDrag(gesture[1] as number);
          }
          return;
        }
        const expected = args[0] === "open-chat" ? parseMascotStatus(args[1]) : null;
        if (args[0] === "open-chat" && !expected) throw new Error("Invalid mascot chat identity");
        await this.action(args[0] as MascotAction, expected ?? undefined);
      });
      screen.on("display-added", this.displayChanged);
      screen.on("display-removed", this.displayChanged);
      screen.on("display-metrics-changed", this.displayChanged);
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
      alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, acceptFirstMouse: true,
      webPreferences: {
        preload: fileURLToPath(new URL("../preload/mascot.cjs", import.meta.url)),
        partition: "inertia-mascot", contextIsolation: true, sandbox: true,
        nodeIntegration: false, webSecurity: true, webviewTag: false,
        backgroundThrottling: true, allowRunningInsecureContent: false,
      },
    });
    this.window = window;
    this.epoch += 1;
    this.lastGesture = 0;
    this.ignoringMouse = false;
    const unregister = this.options.registerHealthRenderer(window.webContents);
    this.options.registerProtocol(window.webContents.session);
    hardenDesktopSession(window.webContents.session);
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("context-menu", () => this.menu(window));
    window.webContents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseMove") this.updateHitTesting(mouse);
      // Capture the grab point before dispatching to the renderer. The OS
      // cursor may already have moved when its asynchronous pickup arrives.
      if (mouse.type === "mouseDown" && mouse.button === "left") {
        this.pickupOffset = mouse.x >= 72 && mouse.x < 168 && mouse.y >= 136 && mouse.y < 234
          ? { x: mouse.x, y: mouse.y } : null;
        this.updateHitTesting(mouse);
      }
      if (mouse.type === "mouseUp" && mouse.button === "left") this.endDrag();
    });
    window.webContents.on("render-process-gone", () => this.failed());
    window.webContents.on("did-start-loading", () => {
      this.endDrag(); this.epoch += 1; this.lastGesture = 0;
    });
    window.on("move", this.scheduleSave);
    window.on("blur", () => { this.endDrag(); window.setFocusable(false); });
    window.on("hide", () => this.endDrag());
    window.on("closed", () => {
      this.clearDrag();
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
    if (this.window === window && !window.isDestroyed()) {
      this.updateHitTesting();
      window.showInactive();
    }
  }

  private failed(): void {
    this.destroyWindow();
    this.state.preferences.enabled = false;
    this.save();
    this.broadcast();
  }

  private destroyWindow(): void {
    this.clearDrag();
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

  private readonly displayChanged = (): void => { this.pickupOffset = null; this.reposition(); };

  private readonly reposition = (): void => {
    const window = this.window;
    if (!this.canPosition || !window || window.isDestroyed()) return;
    // A display was unplugged or its scale changed. End the gesture before
    // restoring reachability; an old cursor offset must not move it back out.
    if (this.drag) { this.endDrag(); return; }
    const bounds = mascotBounds(window.getBounds(), screen.getAllDisplays());
    const current = window.getBounds();
    if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) window.setBounds(bounds);
    this.state.position = { x: bounds.x, y: bounds.y };
    this.save();
    this.updateHitTesting();
  };

  private updateHitTesting(point?: { x: number; y: number }): void {
    // macOS has no setShape input region. Transparency alone still intercepts
    // clicks, so forward hover events over the empty area and restore input as
    // soon as the pointer reaches the bubble or character. No polling or IPC.
    const window = this.window;
    if (process.platform !== "darwin" || !window || window.isDestroyed()) return;
    if (!point) {
      const cursor = screen.getCursorScreenPoint(); const bounds = window.getBounds();
      point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    }
    const { x, y } = point;
    const character = x >= 72 && x < 168 && y >= 136 && y < 234;
    const bubble = (x - Math.max(18, Math.min(x, 222))) ** 2
      + (y - Math.max(14, Math.min(y, 102))) ** 2 <= 14 ** 2;
    // A native press owns input while its asynchronous pickup is still pending,
    // so a quick move/release cannot pass through before the renderer responds.
    const ignore = !this.drag && !this.pickupOffset && !character && !bubble;
    if (ignore !== this.ignoringMouse) {
      window.setIgnoreMouseEvents(ignore, { forward: true });
      this.ignoringMouse = ignore;
    }
  }

  private readonly scheduleSave = (): void => {
    if (!this.canPosition || this.drag) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.reposition(); }, 200);
  };

  private save(): void {
    try { writeMascotWindowState(this.statePath, this.state); }
    catch { /* A read-only profile must not break the workbench or mascot. */ }
  }

  private beginDrag(gesture: number): void {
    if (gesture <= this.lastGesture) return;
    this.lastGesture = gesture;
    const window = this.window;
    if (!this.canPosition || !window || window.isDestroyed()) return;
    // Only the character's input region can start a drag. No renderer-supplied
    // coordinates, global hooks, or persistent polling are needed.
    const offset = this.pickupOffset;
    if (!offset) { this.broadcast(); return; }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.clearDrag(false);
    this.drag = { offset, started: Date.now(), gesture };
    this.updateHitTesting();
    this.dragTimer = setInterval(() => {
      // Bound a lost pointer-up even if a renderer stalls without exiting.
      if (this.drag && Date.now() - this.drag.started >= 120_000) this.endDrag();
      else this.moveDrag();
    }, 16);
    this.broadcast();
  }

  private moveDrag(dropped = false): void {
    const window = this.window; const drag = this.drag;
    if (!drag || !window || window.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const point = { x: Math.round(cursor.x - drag.offset.x), y: Math.round(cursor.y - drag.offset.y) };
    // Keep the grab point attached to the cursor across monitor seams. Clamping
    // to one display while held causes a whole-window jump at a shared edge.
    // Electron already supplies DIP here, including on mixed-scale desktops.
    const bounds = dropped ? mascotBounds(point, screen.getAllDisplays(), cursor) : { ...point, ...MASCOT_SIZE };
    const previous = window.getBounds();
    if (bounds.x !== previous.x || bounds.y !== previous.y || bounds.width !== previous.width || bounds.height !== previous.height) {
      window.setBounds(bounds, false);
    }
  }

  private clearDrag(clearPress = true): void {
    if (clearPress) this.pickupOffset = null;
    if (this.dragTimer) clearInterval(this.dragTimer);
    this.dragTimer = null;
    this.drag = null;
  }

  private endDrag(gesture?: number): void {
    if (gesture !== undefined && gesture !== this.drag?.gesture) return;
    const pending = this.pickupOffset !== null;
    // Only native release/lifecycle events own the physical press. A delayed
    // renderer drop must not consume the offset captured by a newer press.
    if (gesture === undefined) this.pickupOffset = null;
    if (!this.drag) {
      if (pending) this.updateHitTesting();
      return;
    }
    this.moveDrag(true);
    this.clearDrag(gesture === undefined);
    this.reposition();
    this.broadcast();
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
      this.endDrag();
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
    this.endDrag();
    const status = { ...this.status };
    Menu.buildFromTemplate([
      { label: MASCOT_LABELS[this.status.phase], enabled: false },
      { label: "Open chat", enabled: Boolean(status.conversationId), click: () => { void this.action("open-chat", status).catch(() => undefined); } },
      { label: this.state.preferences.motion ? "Pause animation" : "Resume animation", click: () => { void this.action(this.state.preferences.motion ? "pause" : "resume"); } },
      { label: "Hide mascot", click: () => { void this.action("hide"); } },
    ]).popup({ window });
  }
}
