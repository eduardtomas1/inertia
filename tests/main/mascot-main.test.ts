import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent, Rectangle } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow } from "electron";
import { MascotMain } from "../../src/main/mascot-main";
import { MASCOT_PIN_TIMEOUT_MS } from "../../src/main/mascot-pin";
import { emptyMascotStatus, MASCOT_CHAT_LIMIT, MASCOT_IPC, type MascotCounts, type MascotSnapshot, type MascotStatus } from "../../src/shared/mascot";
import type { MascotFeed } from "../../src/shared/mascot-feed";
import { mascotTestClock } from "../helpers/mascot-fixture";
import { MascotStatusPublisher } from "../../src/server/runtime/mascot-status";
import type { ConversationShell } from "../../src/shared/contracts/app";
import { agentTurnStatusForRunState, type AgentRunState } from "../../src/shared/run-state";
import type { MascotSpriteImport, MascotSprites } from "../../src/shared/mascot-sprites";
import { writeMascotSpriteTemplate } from "../../src/main/mascot-sprites";
import { readMascotWindowState } from "../../src/main/mascot-placement";

function immediatePublisher(...args: Partial<ConstructorParameters<typeof MascotStatusPublisher>>): MascotStatusPublisher {
  return new MascotStatusPublisher(args[0], args[1], args[2], (task) => task(), mascotTestClock());
}

function feed(
  status: MascotStatus, chats: MascotStatus[] = [], focus: string | null = null,
  counts: MascotCounts | null = null, request?: number | null, rows: MascotStatus[] = [],
): MascotFeed {
  return { status, chats, rows, focus, counts, ...(request === undefined ? {} : { request }) };
}

interface MenuItemDouble { id?: string; label?: string; type?: string; click?: () => void }
interface AppMenuDouble {
  items: Array<{ role?: string; submenu?: { items: MenuItemDouble[]; append(item: MenuItemDouble): void } }>;
  getMenuItemById(id: string): MenuItemDouble | null;
}

function appMenuDouble(): AppMenuDouble {
  const windowItems: MenuItemDouble[] = [];
  return {
    items: [{ role: "editMenu" }, { role: "windowMenu", submenu: { items: windowItems, append: (item) => { windowItems.push(item); } } }],
    getMenuItemById: (id) => windowItems.find((item) => item.id === id) ?? null,
  };
}

const harness = vi.hoisted(() => ({
  options: [] as BrowserWindowConstructorOptions[],
  windows: [] as unknown[],
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  displays: [{ workArea: { x: 0, y: 24, width: 1440, height: 876 } }],
  cursor: { x: 1296, y: 820 },
  displayListeners: new Map<string, () => void>(),
  menus: [] as unknown[][],
  appMenu: null as AppMenuDouble | null,
  dockMenus: [] as unknown[],
  setApplicationMenu: vi.fn(),
  openDialog: vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>>(async () => ({ canceled: true, filePaths: [] })),
  saveDialog: vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>>(async () => ({ canceled: true })),
}));
vi.mock("../../src/main/preview-broker", () => ({ hardenDesktopSession: vi.fn() }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    bounds: Rectangle;
    destroyed = false;
    showInactive = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    setFocusable = vi.fn();
    setShape = vi.fn();
    setSize = vi.fn((width: number, height: number) => { this.bounds = { ...this.bounds, width, height }; });
    setIgnoreMouseEvents = vi.fn();
    setMenu = vi.fn();
    setBounds = vi.fn((value: Rectangle) => {
      if (JSON.stringify(this.bounds) !== JSON.stringify(value)) { this.bounds = value; this.emit("move"); }
    });
    webContents = Object.assign(new EventEmitter(), {
      session: {}, mainFrame: { url: "about:blank" },
      send: vi.fn(), focus: vi.fn(), setWindowOpenHandler: vi.fn(),
    });
    constructor(options: BrowserWindowConstructorOptions) {
      super();
      this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 100, height: options.height ?? 100 };
      harness.options.push(options); harness.windows.push(this);
    }
    isDestroyed(): boolean { return this.destroyed; }
    getBounds(): Rectangle { return { ...this.bounds }; }
    async loadURL(url: string): Promise<void> { this.webContents.mainFrame.url = url; }
    destroy(): void { this.destroyed = true; this.emit("closed"); }
  }
  return {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => "/documents", dock: { setMenu: (menu: unknown) => harness.dockMenus.push(menu) } },
    dialog: {
      showOpenDialog: (...args: unknown[]) => harness.openDialog(...args),
      showSaveDialog: (...args: unknown[]) => harness.saveDialog(...args),
    },
    BrowserWindow: Window,
    ipcMain: { handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => harness.handlers.set(channel, listener) },
    screen: { getAllDisplays: () => harness.displays, getCursorScreenPoint: () => harness.cursor,
      on: (event: string, listener: () => void) => harness.displayListeners.set(event, listener) },
    Menu: {
      buildFromTemplate: (template: unknown[]) => { harness.menus.push(template); return { popup: vi.fn(), template }; },
      getApplicationMenu: () => harness.appMenu,
      setApplicationMenu: (menu: unknown) => harness.setApplicationMenu(menu),
    },
    MenuItem: class { constructor(options: object) { Object.assign(this, options); } },
  };
});

interface WindowDouble {
  webContents: {
    mainFrame: { url: string };
    send: ReturnType<typeof vi.fn>;
    emit(event: string, ...args: unknown[]): boolean;
  };
  showInactive: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  setFocusable: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn<(bounds: Rectangle) => void>>;
  getBounds(): Rectangle;
  isDestroyed(): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers(); harness.windows.length = 0; harness.options.length = 0; harness.handlers.clear();
  harness.displays = [{ workArea: { x: 0, y: 24, width: 1440, height: 876 } }];
  harness.cursor = { x: 1296, y: 820 }; harness.displayListeners.clear(); harness.menus.length = 0; vi.unstubAllGlobals();
  harness.appMenu = appMenuDouble(); harness.dockMenus.length = 0; harness.setApplicationMenu.mockReset();
  harness.openDialog.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
  harness.saveDialog.mockReset().mockResolvedValue({ canceled: true });
});

async function fixture(directory = mkdtempSync(join(tmpdir(), "mascot-main-"))) {
  harness.appMenu ??= appMenuDouble();
  const main = new BrowserWindow({});
  await main.loadURL("inertia://bundle/index.html");
  const openChat = vi.fn(async () => undefined);
  const focusChat = vi.fn();
  const feedRejected = vi.fn();
  const unregister = vi.fn();
  const mascot = new MascotMain({
    mainWindow: () => main, rendererUrl: "inertia://bundle/index.html", userDataDirectory: directory,
    registerProtocol: vi.fn(), registerHealthRenderer: () => unregister, openChat, focusChat, feedRejected,
    spriteOrigin: "inertia://bundle/",
  });
  mascot.attach();
  const invoke = async (channel: string, value: unknown[], sender = main as unknown as WindowDouble): Promise<unknown> => {
    return await harness.handlers.get(channel)!({
      sender: sender.webContents, senderFrame: sender.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent, ...value);
  };
  cleanups.push(() => { mascot.suspend(); rmSync(directory, { recursive: true, force: true }); });
  const gesture = (id = 1) => [mascot.snapshot().gesture![0], id] as const;
  return { mascot, main, invoke, openChat, focusChat, feedRejected, unregister, directory, gesture };
}

describe("mascot chat selection", () => {
  const chat = (id: string, phase: MascotStatus["phase"]): MascotStatus => ({
    ...emptyMascotStatus(), phase, conversationId: id, projectId: "project", runId: `${id}-run`, turnId: `${id}-turn`,
    activeCount: 1, chatTitle: `Chat ${id}`,
  });

  it("shows the unavailable state after a rejected feed and reports each run of rejections once", async () => {
    const app = await fixture();
    app.mascot.runtimePhase("ready");
    const working = chat("working", "running");
    app.mascot.observe(feed(working, [working]));
    app.mascot.reject();
    expect(app.mascot.snapshot()).toMatchObject({ status: { phase: "unavailable", conversationId: null }, chats: [], rows: [] });
    app.mascot.reject();
    app.mascot.reject();
    expect(app.feedRejected).toHaveBeenCalledTimes(1);
    app.mascot.observe(feed(working, [working]));
    expect(app.mascot.snapshot().status).toEqual(working);
    app.mascot.reject();
    expect(app.feedRejected).toHaveBeenCalledTimes(2);
    app.mascot.runtimePhase("restarting");
    app.mascot.runtimePhase("ready");
    app.mascot.reject();
    expect(app.feedRejected).toHaveBeenCalledTimes(3);
  });

  it("pins a listed chat through validated IPC and opens exactly that chat", async () => {
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const urgent = chat("urgent", "waiting-for-input");
    const quiet = chat("quiet", "running");
    app.mascot.observe(feed(urgent, [urgent, quiet]));
    expect(app.mascot.snapshot()).toMatchObject({ status: { conversationId: "urgent" }, pinned: null, chats: [urgent, quiet] });
    expect(app.mascot.snapshot()).not.toHaveProperty("counts");
    app.mascot.observe(feed(urgent, [urgent, quiet], null, { chats: 20, attention: 14, others: 1 }, null, [quiet]));
    expect(app.mascot.snapshot()).toMatchObject({ counts: { chats: 20, attention: 14, others: 1 }, rows: [quiet] });
    await app.invoke(MASCOT_IPC.action, ["pin", "quiet"], overlay);
    expect(app.focusChat).toHaveBeenLastCalledWith("quiet", 1);
    expect(app.mascot.snapshot()).toMatchObject({ status: { conversationId: "quiet" }, pinned: "quiet" });
    expect(overlay.webContents.send).toHaveBeenLastCalledWith(MASCOT_IPC.changed, expect.objectContaining({ pinned: "quiet" }));
    await app.invoke(MASCOT_IPC.action, ["open-chat", app.mascot.snapshot().status], overlay);
    expect(app.openChat).toHaveBeenLastCalledWith("quiet");
    await expect(app.invoke(MASCOT_IPC.action, ["open-chat", urgent], overlay)).rejects.toThrow("changed");
    await expect(app.invoke(MASCOT_IPC.action, ["pin", "missing"], overlay)).rejects.toThrow("changed");
    await expect(app.invoke(MASCOT_IPC.action, ["pin", 7], overlay)).rejects.toThrow("Invalid");
    await expect(app.invoke(MASCOT_IPC.action, ["pin"], overlay)).rejects.toThrow("untrusted");
    expect(app.focusChat).toHaveBeenCalledTimes(1);
    await app.invoke(MASCOT_IPC.action, ["pin", null], overlay);
    expect(app.focusChat).toHaveBeenLastCalledWith(null, 2);
    expect(app.mascot.snapshot()).toMatchObject({ status: { conversationId: "urgent" }, pinned: null });
  });

  it("keeps a runtime-ranked pin below the list cap and clears it only when the chat is archived or deleted", async () => {
    const app = await fixture();
    const publisher = immediatePublisher((value) => app.mascot.observe(value));
    app.focusChat.mockImplementation((conversationId: string | null, request: number) => publisher.focus(conversationId, request));
    const shell = (id: string, state: AgentRunState, extra: Partial<ConversationShell> = {}): ConversationShell => ({
      id, projectId: "project", title: `Chat ${id}`, status: "idle", archivedAt: null, lastViewedAt: "2026-09-06T11:00:00.000Z",
      latestTurn: {
        id: `${id}-turn`, runId: `${id}-run`, status: agentTurnStatusForRunState(state), runState: { state, revision: 1 },
        completedAt: "2026-09-06T10:00:00.000Z", requestedAt: "2026-09-06T09:00:00.000Z", updatedAt: "2026-09-06T10:00:00.000Z",
      },
      ...extra,
    }) as ConversationShell;
    const listed = () => app.mascot.snapshot().chats!.map(({ conversationId }) => conversationId);
    const pinned = shell("pinned", "completed");
    const busy = Array.from({ length: 2 * MASCOT_CHAT_LIMIT }, (_, index) => shell(`busy-${String(index).padStart(2, "0")}`, "running"));
    publisher.replace([pinned, ...busy.slice(0, 2)], [{ id: "project", name: "Inertia" }]);
    await app.invoke(MASCOT_IPC.action, ["pin", "pinned"]);
    expect(app.focusChat).toHaveBeenLastCalledWith("pinned", expect.any(Number));
    publisher.replace([pinned, ...busy], [{ id: "project", name: "Inertia" }]);
    expect(listed()).toHaveLength(MASCOT_CHAT_LIMIT);
    expect(listed()).toContain("pinned");
    expect(listed().filter((id) => id !== "pinned")).toEqual(busy.slice(0, MASCOT_CHAT_LIMIT - 1).map(({ id }) => id));
    expect(app.mascot.snapshot()).toMatchObject({
      pinned: "pinned",
      status: { conversationId: "pinned", phase: "completed", projectName: "Inertia", turnId: "pinned-turn" },
    });
    publisher.replace([pinned, ...busy.slice(0, 2)], [{ id: "project", name: "Inertia" }]);
    expect(listed()).toEqual(["busy-00", "busy-01", "pinned"]);
    expect(app.mascot.snapshot()).toMatchObject({ pinned: "pinned", status: { conversationId: "pinned" } });
    publisher.replace([{ ...pinned, archivedAt: "2026-09-06T12:00:00.000Z" }, ...busy], [{ id: "project", name: "Inertia" }]);
    expect(app.mascot.snapshot()).toMatchObject({ pinned: null, status: { conversationId: "busy-00" } });
    expect(app.focusChat).toHaveBeenCalledTimes(1);
    publisher.replace([pinned, ...busy.slice(0, 2)], [{ id: "project", name: "Inertia" }]);
    expect(app.mascot.snapshot()).toMatchObject({ pinned: null });
    expect(listed()).toContain("pinned");
    await app.invoke(MASCOT_IPC.action, ["pin", "pinned"]);
    expect(app.mascot.snapshot()).toMatchObject({ pinned: "pinned" });
    publisher.replace(busy, [{ id: "project", name: "Inertia" }]);
    expect(app.mascot.snapshot()).toMatchObject({ pinned: null, status: { conversationId: "busy-00" } });
    expect(listed()).toHaveLength(MASCOT_CHAT_LIMIT);
    expect(app.focusChat).toHaveBeenCalledTimes(2);
  });

  it("labels each native Show chat item with its project and an age ordinal for exact twins", async () => {
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const named = (id: string, phase: MascotStatus["phase"], context: Partial<MascotStatus>): MascotStatus => ({ ...chat(id, phase), ...context });
    const project = "P".repeat(64);
    const chats = [
      named("newer", "running", { chatTitle: "Fix login", projectName: "Alpha", since: "2026-09-06T10:05:00.000Z" }),
      named("beta", "running", { chatTitle: "Fix login", projectName: "Beta" }),
      named("older", "running", { chatTitle: "Fix login", projectName: "Alpha", since: "2026-09-06T10:00:00.000Z" }),
      named("loose", "running", { chatTitle: "Fix login", projectName: null }),
      named("long", "completed", { chatTitle: null, projectName: project }),
    ];
    app.mascot.observe(feed(chats[0]!, chats));
    overlay.webContents.emit("context-menu");
    const menu = harness.menus.at(-1) as Array<{ label?: string; submenu?: Array<{ label?: string; type?: string }> }>;
    const items = menu.find(({ label }) => label === "Show chat")!.submenu!.filter(({ type }) => type === "radio").slice(1);
    expect(items.map(({ label }) => label)).toEqual([
      "Fix login (2) — Alpha — Working",
      "Fix login — Beta — Working",
      "Fix login (1) — Alpha — Working",
      "Fix login — Working",
      `Untitled chat — ${project} — Work complete`,
    ]);
  });
});

describe("mascot pin state machine", () => {
  const chat = (id: string, phase: MascotStatus["phase"] = "running"): MascotStatus => ({
    ...emptyMascotStatus(), phase, conversationId: id, projectId: "project", runId: `${id}-run`, turnId: `${id}-turn`,
    activeCount: 1, chatTitle: `Chat ${id}`,
  });
  const a = chat("a");
  const b = chat("b");
  async function pinFixture() {
    const app = await fixture();
    app.mascot.runtimePhase("ready");
    const told = (): string | null | undefined => ((app.main as unknown as WindowDouble).webContents.send.mock.lastCall?.[1] as MascotSnapshot | undefined)?.pinned;
    const answer = (focus: string | null, request?: number | null, chats: MascotStatus[] = [a, b]): void => {
      app.mascot.observe(feed(chats[0] ?? emptyMascotStatus(), chats, focus, null, request));
    };
    answer(null, null);
    const pin = async (id: string | null): Promise<void> => { await app.invoke(MASCOT_IPC.action, ["pin", id]); };
    return { ...app, told, answer, pin };
  }

  it("confirms a selection from the answer to its own request and clears it when the chat is gone, without re-pinning on restore", async () => {
    const app = await pinFixture();
    await app.pin("b");
    expect(app.focusChat).toHaveBeenLastCalledWith("b", 1);
    expect(app.told()).toBe("b");
    app.answer(null, null);
    expect(app.mascot.snapshot().pinned).toBe("b");
    app.answer("b", 1);
    expect(app.mascot.snapshot().pinned).toBe("b");
    app.answer(null, 1, [a]);
    expect(app.mascot.snapshot()).toMatchObject({ pinned: null, status: { conversationId: "a" } });
    app.answer(null, 1);
    expect(app.mascot.snapshot().pinned).toBeNull();
    expect(app.told()).toBeNull();
    app.mascot.runtimePhase("stopped");
    app.mascot.runtimePhase("ready");
    expect(app.focusChat).toHaveBeenCalledTimes(1);
  });

  it("drops a selection the runtime rejects and never resends it", async () => {
    const app = await pinFixture();
    await app.pin("b");
    app.answer(null, 1, [a]);
    expect(app.mascot.snapshot().pinned).toBeNull();
    app.answer(null, 1);
    expect(app.mascot.snapshot().pinned).toBeNull();
    expect(app.told()).toBeNull();
    app.mascot.runtimePhase("restarting");
    app.mascot.runtimePhase("ready");
    expect(app.focusChat).toHaveBeenCalledTimes(1);
  });

  it("ignores every answer to a superseded selection, in any order", async () => {
    const app = await pinFixture();
    await app.pin("a");
    await app.pin("b");
    expect(app.focusChat).toHaveBeenLastCalledWith("b", 2);
    app.answer("a", 1);
    app.answer(null, 1);
    expect(app.mascot.snapshot().pinned).toBe("b");
    app.answer("b", 2);
    app.answer("a", 1);
    app.answer(null, 1);
    expect(app.mascot.snapshot().pinned).toBe("b");
    expect(app.told()).toBe("b");
  });

  it("returns to Auto while pending or confirmed and ignores the late confirmation", async () => {
    const app = await pinFixture();
    await app.pin("a");
    await app.pin(null);
    expect(app.focusChat).toHaveBeenLastCalledWith(null, 2);
    app.answer("a", 1);
    expect(app.mascot.snapshot().pinned).toBeNull();
    await app.pin("a");
    app.answer("a", 3);
    await app.pin(null);
    app.answer("a", 3);
    expect(app.mascot.snapshot().pinned).toBeNull();
    expect(app.told()).toBeNull();
    app.mascot.runtimePhase("stopped");
    app.mascot.runtimePhase("ready");
    expect(app.focusChat).toHaveBeenCalledTimes(4);
  });

  it("re-requests a pending or confirmed pin with a new token after a runtime restart", async () => {
    const app = await pinFixture();
    await app.pin("b");
    app.mascot.runtimePhase("stopped");
    expect(app.mascot.snapshot().pinned).toBeNull();
    expect(app.focusChat).toHaveBeenCalledTimes(1);
    app.mascot.runtimePhase("starting");
    app.mascot.runtimePhase("ready");
    expect(app.focusChat).toHaveBeenLastCalledWith("b", 2);
    app.mascot.runtimePhase("ready");
    expect(app.focusChat).toHaveBeenCalledTimes(2);
    app.answer("b", 1);
    app.answer(null, 1);
    expect(app.mascot.snapshot().pinned).toBe("b");
    app.answer("b", 2);
    app.mascot.runtimePhase("stopped");
    app.answer(null, null, [a]);
    app.mascot.runtimePhase("ready");
    expect(app.focusChat).toHaveBeenLastCalledWith("b", 3);
    app.answer(null, 3, [a]);
    expect(app.mascot.snapshot().pinned).toBeNull();
    expect(app.told()).toBeNull();
  });

  it("gives up on a selection the runtime never answers after the bounded wait", async () => {
    const app = await pinFixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await app.pin("b");
    vi.advanceTimersByTime(MASCOT_PIN_TIMEOUT_MS - 1);
    expect(app.mascot.snapshot().pinned).toBe("b");
    vi.advanceTimersByTime(1);
    expect(app.mascot.snapshot().pinned).toBeNull();
    expect(app.focusChat).toHaveBeenLastCalledWith(null, 2);
    expect(app.told()).toBeNull();
    app.answer("b", 1);
    expect(app.mascot.snapshot().pinned).toBeNull();
    await app.pin("a");
    app.answer("a", 3);
    vi.advanceTimersByTime(MASCOT_PIN_TIMEOUT_MS * 2);
    expect(app.mascot.snapshot().pinned).toBe("a");
  });

  it("accepts answers without a token from an older runtime only when they match or end a confirmed pin", async () => {
    const app = await pinFixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await app.pin("b");
    app.answer(null);
    expect(app.mascot.snapshot().pinned).toBe("b");
    app.answer("b");
    vi.advanceTimersByTime(MASCOT_PIN_TIMEOUT_MS);
    expect(app.mascot.snapshot().pinned).toBe("b");
    app.answer(null, undefined, [a]);
    expect(app.mascot.snapshot().pinned).toBeNull();
    await app.pin("a");
    app.answer(null);
    vi.advanceTimersByTime(MASCOT_PIN_TIMEOUT_MS);
    expect(app.mascot.snapshot().pinned).toBeNull();
    expect(app.focusChat).toHaveBeenLastCalledWith(null, 3);
  });
});

describe("mascot window ownership", () => {
  it("allocates nothing while disabled, creates an isolated non-focusing overlay, and destroys it on disable", async () => {
    const app = await fixture();
    expect(harness.windows).toHaveLength(1);
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    expect(harness.options[1]).toMatchObject({
      frame: false, transparent: true, alwaysOnTop: true, focusable: false, show: false,
      resizable: false, skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: true },
    });
    const overlay = harness.windows[1] as WindowDouble;
    expect(overlay.showInactive).toHaveBeenCalledOnce();
    expect(overlay.focus).not.toHaveBeenCalled();
    app.mascot.observe(feed({ ...emptyMascotStatus(), phase: "running", conversationId: "chat", projectId: "project", runId: "run", turnId: "turn", activeCount: 1 }));
    await app.invoke(MASCOT_IPC.action, ["open-chat", app.mascot.snapshot().status], overlay);
    expect(app.openChat).toHaveBeenCalledWith("chat");
    const previousStatus = app.mascot.snapshot().status;
    app.mascot.observe(feed({ ...previousStatus, turnId: "new-turn" }));
    await expect(app.invoke(MASCOT_IPC.action, ["open-chat", previousStatus], overlay)).rejects.toThrow("changed");
    expect(app.openChat).toHaveBeenCalledOnce();
    await app.invoke(MASCOT_IPC.action, ["focus"]);
    expect(overlay.setFocusable).toHaveBeenLastCalledWith(true);
    overlay.emit("blur");
    expect(overlay.setFocusable).toHaveBeenLastCalledWith(false);
    await app.invoke(MASCOT_IPC.configure, [{ enabled: false, motion: true }]);
    expect(overlay.isDestroyed()).toBe(true);
    expect(app.unregister).toHaveBeenCalledOnce();
  });

  it.each(["native release", "renderer capture loss"])("passes empty macOS corners through after %s without losing captured drags or polling at idle", async (ending) => {
    vi.useFakeTimers();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const hover = (x: number, y: number, button: "none" | "left" = "none"): void => {
      overlay.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x, y, button });
    };
    hover(20, 296);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    hover(120, 175);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    hover(4, 161); // Transparent rounded corner of the status bubble.
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    hover(120, 260);
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 260 });
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    hover(-100, -100, "left"); // Pointer capture must continue outside the window.
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    await app.invoke(MASCOT_IPC.action, ["drop", app.gesture()], overlay);
    hover(20, 296, "left"); // Losing capture does not prove a physical release.
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    if (ending === "native release") overlay.webContents.emit("before-mouse-event", {}, { type: "mouseUp", button: "left" });
    hover(20, 296);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    const calls = overlay.setIgnoreMouseEvents.mock.calls.length;
    hover(20, 296);
    vi.advanceTimersByTime(500);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains macOS input when hover leaves the grab region before pickup IPC arrives", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x: 20, y: 296 });
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x: 120, y: 260 });
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 260 });
    const bounds = overlay.getBounds();
    harness.cursor = { x: bounds.x + 20, y: bounds.y + 296 };
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x: 20, y: 296 });
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    expect(app.mascot.snapshot().dragging).toBe(true);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    // No further movement arrives to repair input before the native release.
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseUp", button: "left" });
    expect(app.mascot.snapshot().dragging).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["native release", "released hover", "blur", "hide", "reload", "display"])("releases pending macOS input on %s before pickup IPC and rejects the late pickup", async (reason) => {
    vi.useFakeTimers();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x: 20, y: 296 });
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x: 120, y: 260 });
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 260 });
    const bounds = overlay.getBounds();
    harness.cursor = { x: bounds.x + 20, y: bounds.y + 296 };
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x: 20, y: 296 });
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    if (reason === "native release") overlay.webContents.emit("before-mouse-event", {}, { type: "mouseUp", button: "left" });
    else if (reason === "released hover") overlay.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x: 20, y: 296, button: "none" });
    else if (reason === "reload") overlay.webContents.emit("did-start-loading");
    else if (reason === "display") harness.displayListeners.get("display-metrics-changed")!();
    else overlay.emit(reason);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    expect(app.mascot.snapshot().dragging).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pending", "active", "all messages late"])("isolates an earlier gesture's delayed messages from the %s next press", async (ordering) => {
    vi.useFakeTimers();
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const press = (x: number): void => {
      const bounds = overlay.getBounds();
      harness.cursor = { x: bounds.x + x, y: bounds.y + 260 };
      overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x, y: 260 });
    };
    press(120);
    if (ordering !== "all messages late") await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseUp", button: "left" });
    press(110);
    if (ordering === "active") await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture(2)], overlay);
    if (ordering === "all messages late") await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    await app.invoke(MASCOT_IPC.action, ["drop", app.gesture()], overlay);
    if (ordering !== "active") await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture(2)], overlay);
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay); // A replay cannot replace the new owner.
    expect(app.mascot.snapshot()).toMatchObject({ dragging: true, gesture: app.gesture(2) });
    harness.cursor = { x: 900, y: 500 };
    vi.advanceTimersByTime(16);
    expect(overlay.getBounds()).toMatchObject({ x: 790, y: 240 });
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseUp", button: "left" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a cancelled or previous-renderer gesture without consuming the current native press", async () => {
    vi.useFakeTimers();
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const stale = app.gesture();
    overlay.webContents.emit("did-start-loading");
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 260 });
    await app.invoke(MASCOT_IPC.action, ["pickup", stale], overlay);
    await app.invoke(MASCOT_IPC.action, ["drop", stale], overlay);
    expect(app.mascot.snapshot().dragging).toBe(false);
    await app.invoke(MASCOT_IPC.action, ["drop", app.gesture()], overlay);
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    expect(app.mascot.snapshot().dragging).toBe(false);
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture(2)], overlay);
    expect(app.mascot.snapshot().dragging).toBe(true);
    await app.invoke(MASCOT_IPC.action, ["drop", stale], overlay);
    expect(app.mascot.snapshot().dragging).toBe(true);
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseUp", button: "left" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, [1, NaN], [1, "1"], Object.assign([1, 1], { extra: true })].map((gesture) => ({ gesture })))("rejects a malformed gesture identity: %j", async ({ gesture }) => {
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    await expect(app.invoke(MASCOT_IPC.action, ["pickup", gesture], overlay)).rejects.toThrow("Invalid mascot gesture");
    expect(app.mascot.snapshot().dragging).toBe(false);
  });

  it("rejects foreign windows, subframes, navigation, malformed arguments and overlay configuration", async () => {
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const foreign = new BrowserWindow({});
    await foreign.loadURL("inertia://bundle/index.html");
    await expect(app.invoke(MASCOT_IPC.snapshot, [], foreign as unknown as WindowDouble)).rejects.toThrow("untrusted");
    await expect(app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }], overlay)).rejects.toThrow("untrusted");
    await expect(app.invoke(MASCOT_IPC.action, ["arbitrary-command"])).rejects.toThrow("Invalid");
    await expect(app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true, file: "/tmp" }])).rejects.toThrow("Invalid");
    await expect(app.invoke(MASCOT_IPC.snapshot, ["extra"])).rejects.toThrow("untrusted");
    expect(() => harness.handlers.get(MASCOT_IPC.snapshot)!({
      sender: overlay.webContents, senderFrame: { ...overlay.webContents.mainFrame },
    } as unknown as IpcMainInvokeEvent)).toThrow("untrusted");
    const preventDefault = vi.fn();
    overlay.webContents.emit("will-navigate", { preventDefault }, "https://example.com");
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("clamps a native drag once without a recurring save loop and clears stale runtime state", async () => {
    vi.useFakeTimers();
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    overlay.setBounds({ x: 2000, y: 2000, width: 240, height: 316 });
    vi.advanceTimersByTime(400);
    expect(overlay.getBounds()).toEqual({ x: 1200, y: 584, width: 240, height: 316 });
    expect(vi.getTimerCount()).toBe(0);
    app.mascot.runtimePhase("restarting");
    expect(app.mascot.snapshot().status).toEqual(emptyMascotStatus("unavailable"));
    app.mascot.suspend();
    expect(overlay.isDestroyed()).toBe(true);
    expect(app.mascot.snapshot().preferences.enabled).toBe(true);
    app.mascot.attach();
    await Promise.resolve();
    expect(harness.windows).toHaveLength(3);
  });

  it("moves from the grabbed offset, crosses negative displays, and saves only the final position", async () => {
    vi.useFakeTimers();
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const saved = (): ReturnType<typeof readMascotWindowState> => readMascotWindowState(join(app.directory, "mascot-window-state.json"));
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 260 });
    // A quick mouse movement can precede the renderer's asynchronous request.
    harness.cursor = { x: 1100, y: 700 };
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    expect(app.mascot.snapshot().dragging).toBe(true);
    const sends = overlay.webContents.send.mock.calls.length;
    vi.advanceTimersByTime(16);
    expect(overlay.getBounds()).toEqual({ x: 980, y: 440, width: 240, height: 316 });
    vi.advanceTimersByTime(1000); // Holding still must not drop, save, or broadcast.
    expect(saved().positions).toEqual([]);
    expect(overlay.webContents.send).toHaveBeenCalledTimes(sends);
    expect(overlay.focus).not.toHaveBeenCalled();
    app.mascot.observe(feed({ ...emptyMascotStatus(), phase: "running", activeCount: 1 }));
    expect(app.mascot.snapshot().dragging).toBe(true);
    harness.displays.push({ workArea: { x: -1920, y: -200, width: 1920, height: 1080 } });
    harness.cursor = { x: -1, y: 20 };
    vi.advanceTimersByTime(16);
    expect(overlay.getBounds()).toEqual({ x: -121, y: -240, width: 240, height: 316 });
    harness.cursor = { x: -1900, y: -190 };
    await app.invoke(MASCOT_IPC.action, ["drop", app.gesture()], overlay); // Flush the last cursor sample.
    expect(overlay.getBounds()).toEqual({ x: -1920, y: -200, width: 240, height: 316 });
    expect(saved().positions).toEqual([{ display: null, x: -1920, y: -200 }]);
    expect(app.mascot.snapshot()).toMatchObject({ dragging: false, status: { phase: "running" } });
    expect(vi.getTimerCount()).toBe(0);
    app.mascot.suspend(); app.mascot.attach(); await Promise.resolve();
    expect((harness.windows[2] as WindowDouble).getBounds()).toEqual(overlay.getBounds());
  });

  it("keeps each DIP of movement continuous across mixed-scale monitor seams, then bounds the drop", async () => {
    vi.useFakeTimers();
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const displays = [
      { workArea: { x: 0, y: 24, width: 1440, height: 876 }, scaleFactor: 2 },
      { workArea: { x: 1440, y: 100, width: 1920, height: 1080 }, scaleFactor: 1.25 },
    ];
    harness.displays = displays;
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 260 });
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    for (const x of [1438, 1439, 1440, 1441, 1440, 1439, 1441]) {
      harness.cursor = { x, y: 420 };
      vi.advanceTimersByTime(16);
      expect(overlay.getBounds()).toEqual({ x: x - 120, y: 160, width: 240, height: 316 });
    }
    await app.invoke(MASCOT_IPC.action, ["drop", app.gesture()], overlay);
    expect(overlay.getBounds()).toEqual({ x: 1440, y: 160, width: 240, height: 316 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["blur", "hide", "reload", "display", "timeout", "suspend", "native release"])("ends a lost drag on %s with no background tracking", async (reason) => {
    vi.useFakeTimers();
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 260 });
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    if (reason === "reload") overlay.webContents.emit("did-start-loading");
    else if (reason === "native release") overlay.webContents.emit("before-mouse-event", {}, { type: "mouseUp", button: "left" });
    else if (reason === "display") harness.displayListeners.get("display-metrics-changed")!();
    else if (reason === "timeout") vi.advanceTimersByTime(120_000);
    else if (reason === "suspend") app.mascot.suspend();
    else overlay.emit(reason);
    expect(app.mascot.snapshot().dragging).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects drag requests from settings, extra coordinates, and outside the mascot handle", async () => {
    vi.useFakeTimers();
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    await expect(app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()])).rejects.toThrow("untrusted");
    await expect(app.invoke(MASCOT_IPC.action, ["pickup"], overlay)).rejects.toThrow("untrusted");
    await expect(app.invoke(MASCOT_IPC.action, ["drop"], overlay)).rejects.toThrow("untrusted");
    await expect(app.invoke(MASCOT_IPC.action, ["pickup", app.gesture(), { x: 0, y: 0 }], overlay)).rejects.toThrow("untrusted");
    await expect(app.invoke(MASCOT_IPC.action, ["pickup", { x: 0, y: 0 }], overlay)).rejects.toThrow("Invalid");
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 116 });
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    expect(app.mascot.snapshot().dragging).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 260 });
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseUp", button: "left" });
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    expect(app.mascot.snapshot().dragging).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves Wayland movement to the compositor without starting cursor tracking", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("process", { ...process, platform: "linux", env: { ...process.env, WAYLAND_DISPLAY: "wayland-0" } });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], harness.windows[1] as WindowDouble);
    expect(app.mascot.snapshot()).toMatchObject({ placement: "system", dragging: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sizes the Wayland window to the drawn bubble and figure because the compositor cannot pass clicks through", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux", env: { ...process.env, WAYLAND_DISPLAY: "wayland-0" } });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble & { bounds: Rectangle; setBounds: ReturnType<typeof vi.fn>; setShape: ReturnType<typeof vi.fn> };
    expect(harness.options[1]).toMatchObject({ width: 240, height: 155 });
    expect(harness.options[1]).not.toHaveProperty("x");
    const bottom = overlay.bounds.y + overlay.bounds.height;
    await app.invoke(MASCOT_IPC.action, ["bubble", 192], overlay);
    expect(overlay.bounds).toEqual({ x: 0, y: bottom - 316, width: 240, height: 316 });
    await app.invoke(MASCOT_IPC.action, ["bubble", 116], overlay);
    expect(overlay.bounds).toEqual({ x: 0, y: bottom - 240, width: 240, height: 240 });
    const calls = overlay.setBounds.mock.calls.length;
    await app.invoke(MASCOT_IPC.action, ["bubble", 116], overlay);
    expect(overlay.setBounds).toHaveBeenCalledTimes(calls);
    expect(overlay.setShape).not.toHaveBeenCalled();
  });

  it("keeps the full overlay size where placement and pass-through are available", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble & { bounds: Rectangle };
    expect(harness.options[1]).toMatchObject({ width: 240, height: 316 });
    const before = { ...overlay.bounds };
    await app.invoke(MASCOT_IPC.action, ["bubble", 116], overlay);
    expect(overlay.bounds).toEqual(before);
  });
});

describe("mascot custom sprites", () => {
  it("imports a validated preview, applies it to both windows, restores it after restart and resets", async () => {
    const app = await fixture();
    const folder = mkdtempSync(join(tmpdir(), "mascot-sprite-folder-"));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    await writeMascotSpriteTemplate(join(folder, "set"));
    harness.openDialog.mockResolvedValue({ canceled: false, filePaths: [join(folder, "set")] });
    const preview = await app.invoke(MASCOT_IPC.sprites, ["import"]) as MascotSpriteImport;
    expect(preview).toMatchObject({ status: "ready", sprites: { animated: 0 } });
    const { id } = (preview as { sprites: MascotSprites }).sprites;
    expect(app.mascot.snapshot().sprites).toBeUndefined();
    expect(app.mascot.sprite(id, "idle.png")?.type).toBe("image/png");
    expect(app.mascot.sprite(id, "idle.webp")).toBeNull();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    await expect(app.invoke(MASCOT_IPC.sprites, ["import"], overlay)).rejects.toThrow("untrusted");
    await expect(app.invoke(MASCOT_IPC.sprites, ["read", "/etc/passwd"])).rejects.toThrow("untrusted");
    await expect(app.invoke(MASCOT_IPC.sprites, ["delete"])).rejects.toThrow("Invalid mascot sprite action");
    await expect(app.invoke(MASCOT_IPC.sprites, ["apply", "../../etc/passwd"])).rejects.toThrow("Invalid mascot sprite set");
    await expect(app.invoke(MASCOT_IPC.sprites, ["apply", "0000000000000000"])).rejects.toThrow("preview changed");
    const applied = await app.invoke(MASCOT_IPC.sprites, ["apply", id]) as MascotSnapshot;
    expect(applied.sprites?.files.idle).toEqual({
      poster: `inertia://bundle/mascot-sprites/${id}/idle.png`, animation: `inertia://bundle/mascot-sprites/${id}/idle.png`,
    });
    expect(overlay.webContents.send).toHaveBeenLastCalledWith(MASCOT_IPC.changed, expect.objectContaining({ sprites: applied.sprites }));
    expect(existsSync(join(app.directory, "mascot-sprites", "pickup.png"))).toBe(true);

    const restarted = await fixture(app.directory);
    expect((await restarted.invoke(MASCOT_IPC.snapshot, []) as MascotSnapshot).sprites?.id).toBe(id);
    expect(restarted.mascot.sprite(id, "working.png")?.bytes.byteLength).toBeGreaterThan(0);
    const reset = await restarted.invoke(MASCOT_IPC.sprites, ["reset"]) as MascotSnapshot;
    expect(reset.sprites).toBeUndefined();
    expect(restarted.mascot.sprite(id, "idle.png")).toBeNull();
    expect(existsSync(join(app.directory, "mascot-sprites"))).toBe(false);
  });

  it("reports invalid folders and exports the template through the owned save dialog only", async () => {
    const app = await fixture();
    const folder = mkdtempSync(join(tmpdir(), "mascot-sprite-folder-"));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    expect(await app.invoke(MASCOT_IPC.sprites, ["import"])).toEqual({ status: "cancelled" });
    harness.openDialog.mockResolvedValue({ canceled: false, filePaths: [folder] });
    expect(await app.invoke(MASCOT_IPC.sprites, ["import"])).toEqual({
      status: "invalid", message: "idle.png is missing. The Idle state needs a 96 × 96 PNG named idle.png.",
    });
    expect(await app.invoke(MASCOT_IPC.sprites, ["export-template"])).toEqual({ status: "cancelled" });
    harness.saveDialog.mockResolvedValue({ canceled: false, filePath: join(folder, "template") });
    expect(await app.invoke(MASCOT_IPC.sprites, ["export-template"])).toEqual({ status: "exported" });
    expect(JSON.parse(readFileSync(join(folder, "template", "template.json"), "utf8"))).toMatchObject({ requiredImages: 5, width: 96, height: 96 });
    expect(await app.invoke(MASCOT_IPC.sprites, ["export-template"])).toEqual({
      status: "invalid", message: "That name is already in use. Choose a new folder name for the template.",
    });
    await expect(app.invoke(MASCOT_IPC.sprites, ["export-template", folder])).rejects.toThrow("untrusted");
    expect(harness.saveDialog).toHaveBeenCalledTimes(3);
    expect(harness.saveDialog).toHaveBeenLastCalledWith(app.main, expect.objectContaining({
      title: "Export mascot sprite template", defaultPath: join("/documents", "Inertia mascot sprites"),
    }));
    expect(harness.openDialog).toHaveBeenLastCalledWith(app.main, expect.objectContaining({ properties: ["openDirectory"] }));
  });
});

describe("mascot window presence, input region and placement memory", () => {
  const chat = (id: string, phase: MascotStatus["phase"]): MascotStatus => ({
    ...emptyMascotStatus(), phase, conversationId: id, projectId: "project", runId: `${id}-run`, turnId: `${id}-turn`,
    activeCount: 1, chatTitle: `Chat ${id}`,
  });
  const saved = (directory: string) => readMascotWindowState(join(directory, "mascot-window-state.json"));

  it("hides for this app session from the context menu and returns from the app menu, the Dock menu or Settings without changing the setting", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const app = await fixture();
    const show = harness.appMenu!.getMenuItemById("show-mascot")! as MenuItemDouble & { visible?: boolean };
    const dock = (): MenuItemDouble[] => (harness.dockMenus.at(-1) as { template: MenuItemDouble[] } | undefined)?.template ?? [];
    expect(show).toMatchObject({ label: "Show mascot", visible: false });
    expect(dock()).toEqual([]);
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    expect(app.mascot.snapshot()).not.toHaveProperty("hidden");
    overlay.webContents.emit("context-menu");
    (harness.menus.at(-1) as MenuItemDouble[]).find(({ label }) => label === "Hide mascot")!.click!();
    await vi.waitFor(() => expect(overlay.isDestroyed()).toBe(true));
    expect(app.mascot.snapshot()).toMatchObject({ hidden: true, preferences: { enabled: true } });
    expect(saved(app.directory).preferences.enabled).toBe(true);
    expect(show.visible).toBe(true);
    expect(dock().map(({ label }) => label)).toEqual(["Show mascot"]);
    expect(harness.setApplicationMenu).toHaveBeenLastCalledWith(harness.appMenu);
    app.mascot.attach();
    await Promise.resolve();
    expect(harness.windows).toHaveLength(2);
    show.click!();
    await vi.waitFor(() => expect(harness.windows).toHaveLength(3));
    expect(show.visible).toBe(false);
    expect(dock()).toEqual([]);
    await app.invoke(MASCOT_IPC.action, ["hide"], harness.windows[2] as WindowDouble);
    dock()[0]!.click!();
    await vi.waitFor(() => expect(harness.windows).toHaveLength(4));
    await app.invoke(MASCOT_IPC.action, ["hide"], harness.windows[3] as WindowDouble);
    await app.invoke(MASCOT_IPC.action, ["show"]);
    expect(harness.windows).toHaveLength(5);
    await app.invoke(MASCOT_IPC.action, ["hide"], harness.windows[4] as WindowDouble);
    await app.invoke(MASCOT_IPC.configure, [{ enabled: false, motion: true }]);
    expect(show.visible).toBe(false);
    expect(app.mascot.snapshot()).not.toHaveProperty("hidden");
    show.click!();
    await app.invoke(MASCOT_IPC.action, ["show"]);
    await Promise.resolve();
    expect(harness.windows).toHaveLength(5);
    expect(saved(app.directory).preferences.enabled).toBe(false);
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    expect(harness.windows).toHaveLength(6);
    expect(harness.appMenu!.items[1]!.submenu!.items.filter(({ id }) => id === "show-mascot")).toHaveLength(1);
  });

  it("starts visible again on the next launch after a session hide", async () => {
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    await app.invoke(MASCOT_IPC.action, ["hide"], harness.windows[1] as WindowDouble);
    expect((harness.windows[1] as WindowDouble).isDestroyed()).toBe(true);
    await fixture(app.directory);
    await vi.waitFor(() => expect(harness.windows.filter((window) => !(window as WindowDouble).isDestroyed())).toHaveLength(3));
  });

  it.each([["darwin", false], ["win32", true], ["linux", true]] as const)("on %s, closing the main window removes the mascot: %s", async (platform, removed) => {
    vi.stubGlobal("process", { ...process, platform });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    app.mascot.mainWindowClosed();
    expect(overlay.isDestroyed()).toBe(removed);
    app.mascot.attach();
    await vi.waitFor(() => expect(harness.windows).toHaveLength(removed ? 3 : 2));
  });

  it("trims the native input region to the visible figure and grows the bubble region with its rows", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble & { setShape: ReturnType<typeof vi.fn> };
    expect(overlay.setShape).toHaveBeenLastCalledWith([
      { x: 4, y: 161, width: 232, height: 33 }, { x: 108, y: 192, width: 36, height: 36 }, { x: 89, y: 214, width: 60, height: 88 },
    ]);
    const shown = chat("shown", "waiting-for-input");
    const rows = [chat("a", "failed"), chat("b", "running")];
    app.mascot.observe(feed(shown, [shown, ...rows], null, { chats: 9, attention: 1, others: 7 }, null, rows));
    expect(overlay.setShape).toHaveBeenLastCalledWith([
      { x: 4, y: 36, width: 232, height: 158 }, { x: 108, y: 192, width: 36, height: 36 }, { x: 89, y: 214, width: 60, height: 88 },
    ]);
    const calls = overlay.setShape.mock.calls.length;
    app.mascot.observe(feed(shown, [shown, ...rows], null, { chats: 9, attention: 1, others: 7 }, null, rows));
    expect(overlay.setShape).toHaveBeenCalledTimes(calls);
    await app.invoke(MASCOT_IPC.action, ["bubble", 192], overlay);
    expect(overlay.setShape).toHaveBeenLastCalledWith([
      { x: 4, y: 0, width: 232, height: 194 }, { x: 108, y: 192, width: 36, height: 36 }, { x: 89, y: 214, width: 60, height: 88 },
    ]);
    for (const height of [30, 193, 116.5, "116", null]) {
      await expect(app.invoke(MASCOT_IPC.action, ["bubble", height], overlay)).rejects.toThrow("Invalid");
    }
    await expect(app.invoke(MASCOT_IPC.action, ["bubble", 31])).rejects.toThrow("untrusted");
    await expect(app.invoke(MASCOT_IPC.action, ["bubble"], overlay)).rejects.toThrow("untrusted");
    await app.invoke(MASCOT_IPC.action, ["bubble", 31], overlay);
    expect(overlay.setShape.mock.lastCall![0][0]).toEqual({ x: 4, y: 161, width: 232, height: 33 });
  });

  it("passes clicks through the empty corners of the figure box on macOS", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const hover = (x: number, y: number): unknown => {
      overlay.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x, y, button: "none" });
      return overlay.setIgnoreMouseEvents.mock.lastCall?.[0] ?? false;
    };
    expect(hover(120, 100)).toBe(true);
    expect(hover(120, 175)).toBe(false);
    expect(hover(120, 260)).toBe(false);
    expect(hover(76, 300)).toBe(true);
    expect(hover(160, 220)).toBe(true);
    expect(hover(90, 215)).toBe(false);
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 76, y: 300 });
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    expect(app.mascot.snapshot().dragging).toBe(false);
    expect(hover(120, 40)).toBe(true);
    await app.invoke(MASCOT_IPC.action, ["bubble", 116], overlay);
    expect(hover(120, 100)).toBe(false);
    const rows = [chat("a", "failed"), chat("b", "running"), chat("c", "running")];
    app.mascot.observe(feed(chat("shown", "waiting-for-input"), [chat("shown", "waiting-for-input"), ...rows], null, { chats: 4, attention: 1, others: 3 }, null, rows));
    await app.invoke(MASCOT_IPC.action, ["bubble", 156], overlay);
    expect(hover(120, 40)).toBe(false);
  });

  it("remembers the position per display and restores it when an unplugged display returns", async () => {
    vi.useFakeTimers();
    const primary = { id: 1, workArea: { x: 0, y: 24, width: 1440, height: 876 } };
    const external = { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };
    harness.displays = [primary, external];
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 260 });
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    harness.cursor = { x: 2500, y: 500 };
    await app.invoke(MASCOT_IPC.action, ["drop", app.gesture()], overlay);
    expect(overlay.getBounds()).toEqual({ x: 2380, y: 240, width: 240, height: 316 });
    expect(saved(app.directory).positions).toEqual([{ display: "2", x: 2380, y: 240 }]);
    harness.displays = [primary];
    harness.displayListeners.get("display-removed")!();
    expect(overlay.getBounds()).toEqual({ x: 1200, y: 240, width: 240, height: 316 });
    vi.advanceTimersByTime(400);
    expect(saved(app.directory).positions).toEqual([{ display: "2", x: 2380, y: 240 }]);
    await app.invoke(MASCOT_IPC.action, ["left"]);
    expect(saved(app.directory).positions).toEqual([{ display: "1", x: 1184, y: 240 }, { display: "2", x: 2380, y: 240 }]);
    harness.displays = [primary, external];
    harness.displayListeners.get("display-added")!();
    expect(overlay.getBounds()).toEqual({ x: 1184, y: 240, width: 240, height: 316 });
    await app.invoke(MASCOT_IPC.action, ["reset-position"]);
    expect(saved(app.directory).positions).toEqual([]);
  });

  it("returns the window to a display the user placed it on when that display is the first one remembered", async () => {
    vi.useFakeTimers();
    const primary = { id: 1, workArea: { x: 0, y: 24, width: 1440, height: 876 } };
    const external = { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };
    harness.displays = [primary, external];
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 260 });
    await app.invoke(MASCOT_IPC.action, ["pickup", app.gesture()], overlay);
    harness.cursor = { x: 2500, y: 500 };
    await app.invoke(MASCOT_IPC.action, ["drop", app.gesture()], overlay);
    harness.displays = [primary];
    harness.displayListeners.get("display-removed")!();
    harness.displays = [primary, external];
    harness.displayListeners.get("display-added")!();
    expect(overlay.getBounds()).toEqual({ x: 2380, y: 240, width: 240, height: 316 });
    app.mascot.suspend();
    harness.displays = [primary];
    app.mascot.attach();
    await vi.waitFor(() => expect(harness.windows).toHaveLength(3));
    expect((harness.windows[2] as WindowDouble).getBounds()).toEqual({ x: 1200, y: 240, width: 240, height: 316 });
  });

  it("opens a chat listed in the rows, leaves the pinned chat out of them, and rejects a row that changed", async () => {
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const shown = chat("shown", "waiting-for-input");
    const failed = { ...chat("failed", "failed"), activeCount: 1 };
    const busy = chat("busy", "running");
    app.mascot.observe(feed(shown, [shown, failed, busy], null, { chats: 3, attention: 1, others: 2 }, null, [failed, busy]));
    expect(app.mascot.snapshot().rows).toEqual([failed, busy]);
    await app.invoke(MASCOT_IPC.action, ["open-chat", failed], overlay);
    expect(app.openChat).toHaveBeenLastCalledWith("failed");
    await expect(app.invoke(MASCOT_IPC.action, ["open-chat", { ...failed, turnId: "older-turn" }], overlay)).rejects.toThrow("changed");
    await app.invoke(MASCOT_IPC.action, ["pin", "busy"], overlay);
    expect(app.mascot.snapshot()).toMatchObject({ pinned: "busy", status: { conversationId: "busy" }, rows: [failed] });
    await expect(app.invoke(MASCOT_IPC.action, ["open-chat", busy], overlay)).resolves.toBeUndefined();
    expect(app.openChat).toHaveBeenLastCalledWith("busy");
  });
});
