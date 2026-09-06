import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent, Rectangle } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow } from "electron";
import { MascotMain } from "../../src/main/mascot-main";
import { emptyMascotStatus, MASCOT_IPC } from "../../src/shared/mascot";

const harness = vi.hoisted(() => ({
  options: [] as BrowserWindowConstructorOptions[],
  windows: [] as unknown[],
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  displays: [{ workArea: { x: 0, y: 24, width: 1440, height: 876 } }],
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
    screen: { getAllDisplays: () => harness.displays, on: vi.fn() },
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
  setBounds: ReturnType<typeof vi.fn<(bounds: Rectangle) => void>>;
  getBounds(): Rectangle;
  isDestroyed(): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers(); harness.windows.length = 0; harness.options.length = 0; harness.handlers.clear();
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
  return { mascot, main, invoke, openChat, unregister };
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
    overlay.setBounds({ x: 2000, y: 2000, width: 176, height: 168 });
    vi.advanceTimersByTime(400);
    expect(overlay.getBounds()).toEqual({ x: 1264, y: 732, width: 176, height: 168 });
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
});
