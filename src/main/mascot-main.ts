import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, screen,
  type IpcMainInvokeEvent, type Session, type WebContents,
} from "electron";
import {
  emptyMascotStatus, MASCOT_ACTIONS, MASCOT_COMPACT_HEIGHT, MASCOT_IPC, MASCOT_LABELS, MASCOT_ROW_LIMIT, mascotBubbleHeight,
  parseMascotPreferences, parseMascotStatus, type MascotAction, type MascotSnapshot, type MascotStatus,
} from "../shared/mascot.js";
import { mascotChatChoices } from "../shared/mascot-choices.js";
import type { MascotFeed } from "../shared/mascot-feed.js";
import type { MascotSpriteAction, MascotSpriteImport, MascotTemplateExport } from "../shared/mascot-sprites.js";
import {
  MASCOT_ARTWORK, MASCOT_BUBBLE_BOTTOM, MASCOT_FIGURE, mascotBounds, mascotPosition, MASCOT_SIZE, readMascotWindowState,
  rememberMascotPosition, supportsMascotPlacement, writeMascotWindowState,
} from "./mascot-placement.js";
import {
  loadMascotSprites, MascotSpriteError, mascotSprites, readMascotSprites, removeMascotSprites, saveMascotSprites,
  writeMascotSpriteTemplate, type MascotSpriteFile, type MascotSpriteSet,
} from "./mascot-sprites.js";
import { hardenDesktopSession } from "./preview-broker.js";
import { MascotPin } from "./mascot-pin.js";

interface MascotMainOptions {
  mainWindow(): BrowserWindow | null;
  rendererUrl: string;
  userDataDirectory: string;
  registerProtocol(session: Session): void;
  registerHealthRenderer(contents: WebContents): () => void;
  openChat(conversationId: string): Promise<void>;
  focusChat(conversationId: string | null, request: number): void;
  spriteOrigin: string;
}
const SPRITE_ACTIONS: readonly unknown[] = ["import", "apply", "reset", "export-template"] satisfies MascotSpriteAction[];

export class MascotMain {
  private readonly statePath: string;
  private readonly spritesPath: string;
  private readonly spritesLoaded: Promise<void>;
  private spriteQueue: Promise<unknown>;
  private sprites: MascotSpriteSet | null = null;
  private pendingSprites: MascotSpriteSet | null = null;
  private readonly rendererUrl: string;
  private state;
  private feed: Omit<MascotFeed, "focus" | "request"> = {
    status: emptyMascotStatus("unavailable"), chats: [], rows: [], counts: null,
  };
  private readonly pinning: MascotPin;
  private window: BrowserWindow | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private drag: { offset: { x: number; y: number }; started: number; gesture: number } | null = null;
  private dragTimer: ReturnType<typeof setInterval> | null = null;
  private pickupOffset: { x: number; y: number } | null = null;
  private epoch = 0;
  private lastGesture = 0;
  private ignoringMouse = false;
  private suspended = false;
  private hidden = false;
  private shape = "";
  private drawn: number | null = null;
  private showItems: MenuItem[] = [];
  private showOffered: boolean | null = null;
  private registered = false;
  private readonly canPosition = supportsMascotPlacement(process.platform, process.env, app.commandLine.getSwitchValue("ozone-platform"));

  constructor(private readonly options: MascotMainOptions) {
    this.pinning = new MascotPin((conversationId, request) => options.focusChat(conversationId, request), () => this.broadcast());
    this.statePath = join(options.userDataDirectory, "mascot-window-state.json");
    this.state = readMascotWindowState(this.statePath);
    this.rendererUrl = new URL("mascot.html", options.rendererUrl).href;
    this.spritesPath = join(options.userDataDirectory, "mascot-sprites");
    this.spritesLoaded = loadMascotSprites(this.spritesPath).then((sprites) => {
      this.sprites = sprites;
      if (sprites) this.broadcast();
    });
    this.spriteQueue = this.spritesLoaded;
  }

  snapshot(): MascotSnapshot { return { preferences: { ...this.state.preferences }, status: { ...this.status() }, chats: this.feed.chats.map((chat) => ({ ...chat })), rows: this.rows().map((chat) => ({ ...chat })), ...(this.feed.counts ? { counts: { ...this.feed.counts } } : {}), pinned: this.pin(), ...(this.offerShow() ? { hidden: true as const } : {}), dragging: Boolean(this.drag), gesture: [this.epoch, this.drag?.gesture ?? this.lastGesture], ...(!this.canPosition ? { placement: "system" as const } : {}), ...(this.sprites ? { sprites: mascotSprites(this.sprites, this.options.spriteOrigin) } : {}) }; }

  sprite(id: string, name: string): MascotSpriteFile | null {
    const set = [this.sprites, this.pendingSprites].find((candidate) => candidate?.id === id);
    return set?.files.find((file) => file.name === name) ?? null;
  }

  observe({ status, chats, rows, focus, counts, request }: MascotFeed): void {
    this.feed = { status, chats, rows, counts };
    this.pinning.answer(focus, request);
    this.broadcast();
  }

  private pin(): string | null {
    const pinned = this.pinning.id;
    return this.feed.chats.some(({ conversationId }) => conversationId === pinned) ? pinned : null;
  }

  private rows(): MascotStatus[] {
    const pinned = this.pin();
    return pinned ? this.feed.rows.filter(({ conversationId }) => conversationId !== pinned) : this.feed.rows;
  }

  private status(): MascotStatus {
    const pinned = this.pin();
    return this.feed.chats.find(({ conversationId }) => pinned && conversationId === pinned) ?? this.feed.status;
  }

  private choose(conversationId: string | null): void {
    if (conversationId !== null && !this.feed.chats.some((chat) => chat.conversationId === conversationId)) {
      throw new Error("The mascot chat has changed. Try again.");
    }
    this.pinning.select(conversationId);
    this.broadcast();
  }

  runtimePhase(phase: string): void {
    this.pinning.runtime(phase === "ready");
    if (phase !== "ready") this.observe({ status: emptyMascotStatus("unavailable"), chats: [], rows: [], focus: null, counts: null, request: null });
  }

  attach(): void {
    this.suspended = false;
    if (!this.registered) {
      this.registered = true;
      ipcMain.handle(MASCOT_IPC.snapshot, (event, ...args) => {
        this.assertSender(event, args.length, 0);
        return this.spritesLoaded.then(() => this.snapshot());
      });
      ipcMain.handle(MASCOT_IPC.sprites, async (event, ...args) => {
        this.assertSender(event, args.length, args[0] === "apply" ? 2 : 1, true);
        if (!SPRITE_ACTIONS.includes(args[0])) throw new Error("Invalid mascot sprite action");
        if (args[0] === "apply" && (typeof args[1] !== "string" || !/^[0-9a-f]{16}$/u.test(args[1]))) {
          throw new Error("Invalid mascot sprite set");
        }
        return await this.spriteAction(args[0] as MascotSpriteAction, args[1] as string | undefined);
      });
      ipcMain.handle(MASCOT_IPC.configure, async (event, ...args) => {
        this.assertSender(event, args.length, 1, true);
        const preferences = parseMascotPreferences(args[0]);
        if (!preferences) throw new Error("Invalid mascot preferences");
        if (preferences.enabled && !this.state.preferences.enabled) this.hidden = false;
        this.state.preferences = preferences;
        this.save();
        await this.reconcile();
        this.broadcast();
        return this.snapshot();
      });
      ipcMain.handle(MASCOT_IPC.action, async (event, ...args) => {
        const dragAction = args[0] === "pickup" || args[0] === "drop";
        this.assertSender(event, args.length, args[0] === "open-chat" || args[0] === "pin" || args[0] === "bubble" || dragAction ? 2 : 1);
        if (!MASCOT_ACTIONS.includes(args[0] as MascotAction)) throw new Error("Invalid mascot action");
        if (args[0] === "bubble") {
          if (event.sender !== this.window?.webContents) throw new Error("Rejected untrusted mascot bubble");
          if (!Number.isSafeInteger(args[1]) || (args[1] as number) < MASCOT_COMPACT_HEIGHT
            || (args[1] as number) > mascotBubbleHeight(MASCOT_ROW_LIMIT, MASCOT_ROW_LIMIT + 1)) throw new Error("Invalid mascot bubble");
          this.drawn = args[1] as number;
          this.applyShape();
          this.fit();
          this.updateHitTesting();
          return;
        }
        if (args[0] === "pin") {
          if (args[1] !== null && typeof args[1] !== "string") throw new Error("Invalid mascot chat identity");
          this.choose(args[1]);
          return;
        }
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
      this.installShowMenu();
    }
    void this.reconcile().catch(() => undefined);
  }

  suspend(): void {
    this.suspended = true;
    this.destroyWindow();
  }

  mainWindowClosed(): void {
    if (process.platform !== "darwin") this.suspend();
  }

  private offerShow(): boolean {
    return this.hidden && this.state.preferences.enabled;
  }

  private installShowMenu(): void {
    const menu = Menu.getApplicationMenu();
    const windowMenu = menu?.items.find(({ role }) => role?.toLowerCase() === "windowmenu")?.submenu;
    if (!menu || !windowMenu || menu.getMenuItemById("show-mascot")) return;
    this.showItems = [
      new MenuItem({ type: "separator", visible: false }),
      new MenuItem({ id: "show-mascot", label: "Show mascot", visible: false, click: () => { void this.show().catch(() => undefined); } }),
    ];
    for (const item of this.showItems) windowMenu.append(item);
    this.updateShowMenu();
  }

  private updateShowMenu(): void {
    const offered = this.offerShow();
    if (offered === this.showOffered) return;
    this.showOffered = offered;
    for (const item of this.showItems) item.visible = offered;
    const menu = Menu.getApplicationMenu();
    if (process.platform === "darwin" && menu && this.showItems.length) Menu.setApplicationMenu(menu);
    if (process.platform === "darwin") {
      app.dock?.setMenu(Menu.buildFromTemplate(offered ? [{ label: "Show mascot", click: () => { void this.show().catch(() => undefined); } }] : []));
    }
  }

  private async show(): Promise<void> {
    if (!this.offerShow()) return;
    this.hidden = false;
    this.updateShowMenu();
    await this.reconcile();
    this.broadcast();
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

  private spriteAction(action: MascotSpriteAction, id?: string): Promise<MascotSpriteImport | MascotTemplateExport | MascotSnapshot> {
    const result = this.spriteQueue.then(async (): Promise<MascotSpriteImport | MascotTemplateExport | MascotSnapshot> => {
      const invalid = (error: unknown, fallback: string) => ({
        status: "invalid" as const, message: error instanceof MascotSpriteError ? error.message : fallback,
      });
      const owner = this.options.mainWindow();
      if (action === "import") {
        this.pendingSprites = null;
        const picked = owner && !owner.isDestroyed() ? await dialog.showOpenDialog(owner, {
          title: "Import mascot sprites", defaultPath: app.getPath("documents"), buttonLabel: "Import sprites", properties: ["openDirectory"],
        }) : null;
        const directory = picked && !picked.canceled ? picked.filePaths[0] : undefined;
        if (!directory) return { status: "cancelled" };
        try {
          this.pendingSprites = await readMascotSprites(directory);
          return { status: "ready", sprites: mascotSprites(this.pendingSprites, this.options.spriteOrigin) };
        } catch (error) { return invalid(error, "The sprites could not be read."); }
      }
      if (action === "export-template") {
        const picked = owner && !owner.isDestroyed() ? await dialog.showSaveDialog(owner, {
          title: "Export mascot sprite template", defaultPath: join(app.getPath("documents"), "Inertia mascot sprites"),
          buttonLabel: "Export template", properties: ["createDirectory"],
        }) : null;
        const directory = picked && !picked.canceled ? picked.filePath : undefined;
        if (!directory) return { status: "cancelled" };
        try {
          await writeMascotSpriteTemplate(directory);
          return { status: "exported" };
        } catch (error) { return invalid(error, "The template could not be saved."); }
      }
      if (action === "apply") {
        const pending = this.pendingSprites;
        if (!pending || pending.id !== id) throw new Error("The sprite preview changed. Import it again.");
        await saveMascotSprites(this.spritesPath, pending);
        this.sprites = pending;
      } else {
        await removeMascotSprites(this.spritesPath);
        this.sprites = null;
      }
      this.pendingSprites = null;
      this.broadcast();
      return this.snapshot();
    });
    this.spriteQueue = result.catch(() => undefined);
    return result;
  }

  private async reconcile(): Promise<void> {
    if (!this.state.preferences.enabled || this.suspended || this.hidden) { this.destroyWindow(); return; }
    if (this.window && !this.window.isDestroyed()) return;
    const displays = screen.getAllDisplays();
    const window = new BrowserWindow({
      title: "Inertia mascot", ...(this.canPosition ? mascotBounds(mascotPosition(this.state.positions, displays), displays) : this.fitted()),
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
    this.shape = "";
    this.drawn = null;
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
      if (mouse.type === "mouseMove") {
        // Native macOS hover reports "none" after a lost release, though the
        // sendInputEvent button type omits it. Delayed renderer drops cannot
        // prove that a newer physical press has ended.
        if (process.platform === "darwin" && (mouse.button as string | undefined) === "none") this.endDrag();
        this.updateHitTesting(mouse);
      }
      // Capture the grab point before dispatching to the renderer. The OS
      // cursor may already have moved when its asynchronous pickup arrives.
      if (mouse.type === "mouseDown" && mouse.button === "left") {
        this.pickupOffset = this.onFigure(mouse) ? { x: mouse.x, y: mouse.y } : null;
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
    this.applyShape();
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
      this.save();
      window.destroy();
    }
    this.window = null;
  }

  private readonly displayChanged = (): void => {
    this.pickupOffset = null;
    const displays = screen.getAllDisplays();
    this.reposition(mascotPosition(this.state.positions, displays) ?? undefined);
  };

  private readonly reposition = (target?: { x: number; y: number }): void => {
    const window = this.window;
    if (!this.canPosition || !window || window.isDestroyed()) return;
    // A display was unplugged or its scale changed. End the gesture before
    // restoring reachability; an old cursor offset must not move it back out.
    if (this.drag) { this.endDrag(); return; }
    const current = window.getBounds();
    const bounds = mascotBounds(target ?? current, screen.getAllDisplays());
    if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) window.setBounds(bounds);
    this.updateHitTesting();
  };

  private remember(): void {
    const window = this.window;
    if (!this.canPosition || !window || window.isDestroyed()) return;
    this.state.positions = rememberMascotPosition(this.state.positions, window.getBounds(), screen.getAllDisplays());
    this.save();
  }

  private region(): { top: number; height: number; figure: { x: number; y: number; width: number; height: number } } {
    const rows = this.rows().length;
    const height = this.drawn ?? (this.status().conversationId ? mascotBubbleHeight(rows, this.feed.counts?.others ?? rows) : MASCOT_COMPACT_HEIGHT);
    return { top: MASCOT_BUBBLE_BOTTOM - height, height, figure: this.sprites ? MASCOT_FIGURE : MASCOT_ARTWORK };
  }

  private onFigure({ x, y }: { x: number; y: number }): boolean {
    const { figure } = this.region();
    return x >= figure.x && x < figure.x + figure.width && y >= figure.y && y < figure.y + figure.height;
  }

  private fitted(): { width: number; height: number } {
    return { width: MASCOT_SIZE.width, height: MASCOT_SIZE.height - MASCOT_BUBBLE_BOTTOM + this.region().height };
  }

  private fit(): void {
    const window = this.window;
    if (this.canPosition || !window || window.isDestroyed()) return;
    const { width, height } = this.fitted();
    const bounds = window.getBounds();
    if (bounds.width !== width || bounds.height !== height) window.setSize(width, height);
  }

  private applyShape(): void {
    const window = this.window;
    if (process.platform === "darwin" || !this.canPosition || !window || window.isDestroyed()) return;
    const { top, height, figure } = this.region();
    const shape = `${top}:${figure.width}`;
    if (shape === this.shape) return;
    this.shape = shape;
    // Cut away unused corners on platforms with native input-region support.
    window.setShape([
      { x: 4, y: top, width: 232, height: height + 2 },
      { x: 108, y: MASCOT_BUBBLE_BOTTOM, width: 36, height: 36 },
      { ...figure },
    ]);
  }

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
    const { top } = this.region();
    const character = this.onFigure(point);
    const bubble = (x - Math.max(18, Math.min(x, 222))) ** 2
      + (y - Math.max(top + 14, Math.min(y, MASCOT_BUBBLE_BOTTOM - 14))) ** 2 <= 14 ** 2;
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
    this.remember();
    this.broadcast();
  }

  private broadcast(): void {
    this.applyShape();
    this.fit();
    this.updateShowMenu();
    const snapshot = this.snapshot();
    for (const window of [this.window, this.options.mainWindow()]) {
      if (window && !window.isDestroyed()) window.webContents.send(MASCOT_IPC.changed, snapshot);
    }
  }

  private async action(action: MascotAction, expectedStatus?: MascotStatus): Promise<void> {
    if (action === "open-chat") {
      const target = [this.status(), ...this.rows()].find((chat) => expectedStatus && (["projectId", "conversationId", "runId", "turnId"] as const)
        .every((key) => expectedStatus[key] === chat[key]));
      if (!target) throw new Error("The mascot chat has changed. Try again.");
      if (target.conversationId) await this.options.openChat(target.conversationId);
      return;
    }
    if (action === "show") { await this.show(); return; }
    if (action === "hide") this.hidden = true;
    else if (action === "pause" || action === "resume") this.state.preferences.motion = action === "resume";
    else if (action === "focus") {
      this.window?.setFocusable(true);
      this.window?.show();
      this.window?.focus();
      this.window?.webContents.focus();
    } else {
      if (!this.canPosition) return;
      this.endDrag();
      const displays = screen.getAllDisplays();
      const position = this.window?.getBounds() ?? mascotPosition(this.state.positions, displays);
      const point = action === "reset-position" || !position ? null : {
        x: position.x + (action === "left" ? -16 : action === "right" ? 16 : 0),
        y: position.y + (action === "up" ? -16 : action === "down" ? 16 : 0),
      };
      const bounds = mascotBounds(point, displays);
      this.window?.setBounds(bounds);
      this.state.positions = point ? rememberMascotPosition(this.state.positions, bounds, displays) : [];
    }
    this.save();
    await this.reconcile();
    this.broadcast();
  }

  private menu(window: BrowserWindow): void {
    this.endDrag();
    const status = { ...this.status() };
    const pinned = this.pin();
    const follow = (conversationId: string | null) => () => { try { this.choose(conversationId); } catch { this.broadcast(); } };
    const choices = mascotChatChoices(this.feed.chats);
    Menu.buildFromTemplate([
      { label: MASCOT_LABELS[status.phase], enabled: false },
      { label: "Open chat", enabled: Boolean(status.conversationId), click: () => { void this.action("open-chat", status).catch(() => undefined); } },
      { label: "Show chat", enabled: this.feed.chats.length > 0, submenu: [
        { label: "Most urgent chat", type: "radio", checked: !pinned, click: follow(null) },
        { type: "separator" },
        ...this.feed.chats.map((chat, index) => ({
          label: [choices[index]!.title, choices[index]!.project, MASCOT_LABELS[chat.phase]].filter(Boolean).join(" — "), type: "radio" as const,
          checked: chat.conversationId === pinned, click: follow(chat.conversationId),
        })),
      ] },
      { label: this.state.preferences.motion ? "Pause animation" : "Resume animation", click: () => { void this.action(this.state.preferences.motion ? "pause" : "resume"); } },
      { label: "Hide mascot", click: () => { void this.action("hide"); } },
    ]).popup({ window });
  }
}
