import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent, Rectangle } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow } from "electron";
import { MascotMain } from "../../src/main/mascot-main";
import { emptyMascotStatus, MASCOT_IPC } from "../../src/shared/mascot";
import { readMascotWindowState } from "../../src/main/mascot-placement";

const harness = vi.hoisted(() => ({
  options: [] as BrowserWindowConstructorOptions[],
  windows: [] as unknown[],
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  displays: [{ workArea: { x: 0, y: 24, width: 1440, height: 876 } }],
  cursor: { x: 1296, y: 820 },
  displayListeners: new Map<string, () => void>(),
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
    app: { commandLine: { getSwitchValue: () => "" } },
    BrowserWindow: Window,
    ipcMain: { handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => harness.handlers.set(channel, listener) },
    screen: { getAllDisplays: () => harness.displays, getCursorScreenPoint: () => harness.cursor,
      on: (event: string, listener: () => void) => harness.displayListeners.set(event, listener) },
    Menu: { buildFromTemplate: () => ({ popup: vi.fn() }) },
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
  harness.cursor = { x: 1296, y: 820 }; harness.displayListeners.clear(); vi.unstubAllGlobals();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mascot-main-"));
  const main = new BrowserWindow({});
  await main.loadURL("inertia://bundle/index.html");
  const openChat = vi.fn(async () => undefined);
  const unregister = vi.fn();
  const mascot = new MascotMain({
    mainWindow: () => main, rendererUrl: "inertia://bundle/index.html", userDataDirectory: directory,
    registerProtocol: vi.fn(), registerHealthRenderer: () => unregister, openChat,
  });
  mascot.attach();
  const invoke = async (channel: string, value: unknown[], sender = main as unknown as WindowDouble): Promise<unknown> => {
    return await harness.handlers.get(channel)!({
      sender: sender.webContents, senderFrame: sender.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent, ...value);
  };
  cleanups.push(() => { mascot.suspend(); rmSync(directory, { recursive: true, force: true }); });
  return { mascot, main, invoke, openChat, unregister, directory };
}

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
    app.mascot.observe({ ...emptyMascotStatus(), phase: "running", conversationId: "chat", projectId: "project", runId: "run", turnId: "turn", activeCount: 1 });
    await app.invoke(MASCOT_IPC.action, ["open-chat", app.mascot.snapshot().status], overlay);
    expect(app.openChat).toHaveBeenCalledWith("chat");
    const previousStatus = app.mascot.snapshot().status;
    app.mascot.observe({ ...previousStatus, turnId: "new-turn" });
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

  it("passes empty macOS corners through without losing captured drags or polling at idle", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    const hover = (x: number, y: number): void => {
      overlay.webContents.emit("before-mouse-event", {}, { type: "mouseMove", x, y });
    };
    hover(20, 220);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    hover(120, 40);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    hover(4, 0); // Transparent rounded corner of the status bubble.
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    hover(120, 184);
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 184 });
    await app.invoke(MASCOT_IPC.action, ["pickup"], overlay);
    hover(-100, -100); // Pointer capture must continue outside the window.
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    await app.invoke(MASCOT_IPC.action, ["drop"], overlay);
    hover(20, 220);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    const calls = overlay.setIgnoreMouseEvents.mock.calls.length;
    hover(20, 220);
    vi.advanceTimersByTime(500);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
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
    overlay.setBounds({ x: 2000, y: 2000, width: 240, height: 240 });
    vi.advanceTimersByTime(400);
    expect(overlay.getBounds()).toEqual({ x: 1200, y: 660, width: 240, height: 240 });
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
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 184 });
    // A quick mouse movement can precede the renderer's asynchronous request.
    harness.cursor = { x: 1100, y: 700 };
    await app.invoke(MASCOT_IPC.action, ["pickup"], overlay);
    expect(app.mascot.snapshot().dragging).toBe(true);
    const sends = overlay.webContents.send.mock.calls.length;
    vi.advanceTimersByTime(16);
    expect(overlay.getBounds()).toEqual({ x: 980, y: 516, width: 240, height: 240 });
    vi.advanceTimersByTime(1000); // Holding still must not drop, save, or broadcast.
    expect(saved().position).toBeNull();
    expect(overlay.webContents.send).toHaveBeenCalledTimes(sends);
    expect(overlay.focus).not.toHaveBeenCalled();
    app.mascot.observe({ ...emptyMascotStatus(), phase: "running", activeCount: 1 });
    expect(app.mascot.snapshot().dragging).toBe(true);
    harness.displays.push({ workArea: { x: -1920, y: -200, width: 1920, height: 1080 } });
    harness.cursor = { x: -1, y: 20 };
    vi.advanceTimersByTime(16);
    expect(overlay.getBounds()).toEqual({ x: -121, y: -164, width: 240, height: 240 });
    harness.cursor = { x: -1900, y: -190 };
    await app.invoke(MASCOT_IPC.action, ["drop"], overlay); // Flush the last cursor sample.
    expect(overlay.getBounds()).toEqual({ x: -1920, y: -200, width: 240, height: 240 });
    expect(saved().position).toEqual({ x: -1920, y: -200 });
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
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 184 });
    await app.invoke(MASCOT_IPC.action, ["pickup"], overlay);
    for (const x of [1438, 1439, 1440, 1441, 1440, 1439, 1441]) {
      harness.cursor = { x, y: 420 };
      vi.advanceTimersByTime(16);
      expect(overlay.getBounds()).toEqual({ x: x - 120, y: 236, width: 240, height: 240 });
    }
    await app.invoke(MASCOT_IPC.action, ["drop"], overlay);
    expect(overlay.getBounds()).toEqual({ x: 1440, y: 236, width: 240, height: 240 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["blur", "hide", "reload", "display", "timeout", "suspend", "native release"])("ends a lost drag on %s with no background tracking", async (reason) => {
    vi.useFakeTimers();
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    const overlay = harness.windows[1] as WindowDouble;
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 184 });
    await app.invoke(MASCOT_IPC.action, ["pickup"], overlay);
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
    await expect(app.invoke(MASCOT_IPC.action, ["pickup"])).rejects.toThrow("untrusted");
    await expect(app.invoke(MASCOT_IPC.action, ["pickup", { x: 0, y: 0 }], overlay)).rejects.toThrow("untrusted");
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 40 });
    await app.invoke(MASCOT_IPC.action, ["pickup"], overlay);
    expect(app.mascot.snapshot().dragging).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 120, y: 184 });
    overlay.webContents.emit("before-mouse-event", {}, { type: "mouseUp", button: "left" });
    await app.invoke(MASCOT_IPC.action, ["pickup"], overlay);
    expect(app.mascot.snapshot().dragging).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves Wayland movement to the compositor without starting cursor tracking", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("process", { ...process, platform: "linux", env: { ...process.env, WAYLAND_DISPLAY: "wayland-0" } });
    const app = await fixture();
    await app.invoke(MASCOT_IPC.configure, [{ enabled: true, motion: true }]);
    await app.invoke(MASCOT_IPC.action, ["pickup"], harness.windows[1] as WindowDouble);
    expect(app.mascot.snapshot()).toMatchObject({ placement: "system", dragging: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
