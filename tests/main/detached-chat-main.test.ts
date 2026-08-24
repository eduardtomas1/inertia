import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMainInvokeEvent,
  IpcMainEvent,
  Rectangle,
  Session,
  WebContents,
} from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DetachedChatMain,
  type DetachedChatIpcMain,
} from "../../src/main/detached-chat-main";
import { DETACHED_CHAT_IPC } from "../../src/shared/detached-chat-ipc";

const RENDERER_URL = "inertia://bundle/index.html";
const FIRST_ID = "00000001-1111-4111-8111-111111111111";
const SECOND_ID = "00000002-1111-4111-8111-111111111111";

const afterIpcReply = (): Promise<void> => new Promise((resolve) => {
  setImmediate(resolve);
});

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;
type EventListener = (
  event: IpcMainEvent,
  ...args: unknown[]
) => void;

class FakeIpcMain implements DetachedChatIpcMain {
  readonly handlers = new Map<string, InvokeHandler>();
  readonly listeners = new Map<string, Set<EventListener>>();

  handle(channel: string, listener: InvokeHandler): void {
    if (this.handlers.has(channel)) throw new Error(`Duplicate ${channel}`);
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  on(channel: string, listener: EventListener): void {
    const listeners = this.listeners.get(channel) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  removeListener(channel: string, listener: EventListener): void {
    this.listeners.get(channel)?.delete(listener);
  }

  emit(channel: string, event: IpcMainEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener(event, ...args);
    }
  }

  async invoke(
    channel: string,
    event: IpcMainInvokeEvent,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`Missing ${channel}`);
    return await handler(event, ...args);
  }
}

class FakeWebContents extends EventEmitter {
  readonly session = {} as Session;
  readonly mainFrame = { url: "about:blank" };
  readonly sent: Array<{ channel: string; args: unknown[] }> = [];
  destroyed = false;
  windowOpenHandler: (() => unknown) | null = null;

  isDestroyed(): boolean { return this.destroyed; }

  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args });
  }

  setWindowOpenHandler(handler: () => unknown): void {
    this.windowOpenHandler = handler;
  }
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  readonly loadedUrls: string[] = [];
  destroyed = false;
  minimized = false;
  focused = false;
  maximized = false;
  alwaysOnTop = false;
  visible = false;
  closeCalls = 0;
  destroyCalls = 0;
  title = "";
  backgroundColor = "";
  bounds: Rectangle;

  constructor(readonly options: BrowserWindowConstructorOptions = {}) {
    super();
    this.bounds = {
      x: options.x ?? 80,
      y: options.y ?? 80,
      width: options.width ?? 640,
      height: options.height ?? 780,
    };
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    this.webContents.mainFrame.url = url;
    this.emit("ready-to-show");
  }

  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return this.minimized; }
  isFocused(): boolean { return this.focused; }
  isMaximized(): boolean { return this.maximized; }
  isFullScreen(): boolean { return false; }
  isAlwaysOnTop(): boolean { return this.alwaysOnTop; }
  getBounds(): Rectangle { return { ...this.bounds }; }
  getNormalBounds(): Rectangle { return { ...this.bounds }; }
  setTitle(title: string): void { this.title = title; }
  setAlwaysOnTop(value: boolean): void { this.alwaysOnTop = value; }
  setBackgroundColor(value: string): void { this.backgroundColor = value; }
  show(): void { this.visible = true; }
  focus(): void { this.focused = true; }
  restore(): void { this.minimized = false; }

  close(): void {
    if (this.destroyed) return;
    this.closeCalls += 1;
    this.emit("close");
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyCalls += 1;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }
}

function eventFor(
  contents: FakeWebContents,
  frame: object | null = contents.mainFrame,
): IpcMainInvokeEvent {
  return {
    sender: contents as unknown as WebContents,
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
}

interface Fixture {
  directory: string;
  ipc: FakeIpcMain;
  main: FakeBrowserWindow;
  popups: FakeBrowserWindow[];
  hardened: Session[];
  protocolSessions: Session[];
  protocolConversationIds: string[];
  docked: ReturnType<typeof vi.fn>;
  coordinator: DetachedChatMain;
}

function fixture(
  onDock?: (conversationId: string) => void | Promise<void>,
  protocolFailure?: Error,
  productName?: string,
): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "inertia-detached-main-"));
  const ipc = new FakeIpcMain();
  const main = new FakeBrowserWindow();
  main.webContents.mainFrame.url = RENDERER_URL;
  const popups: FakeBrowserWindow[] = [];
  const hardened: Session[] = [];
  const protocolSessions: Session[] = [];
  const protocolConversationIds: string[] = [];
  const docked = vi.fn(onDock ?? (() => undefined));
  const coordinator = new DetachedChatMain({
    ipcMain: ipc,
    mainWindow: () => main as unknown as BrowserWindow,
    createBrowserWindow: (options) => {
      const popup = new FakeBrowserWindow(options);
      popups.push(popup);
      return popup as unknown as BrowserWindow;
    },
    getDisplays: () => [{
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }],
    hardenSession: (session) => hardened.push(session),
    registerRendererProtocol: (session, conversationId) => {
      protocolSessions.push(session);
      protocolConversationIds.push(conversationId);
      if (protocolFailure) throw protocolFailure;
    },
    registerHealthRenderer: () => () => undefined,
    rendererUrl: RENDERER_URL,
    productName,
    preloadPath: join(directory, "detached-chat.cjs"),
    statePath: join(directory, "detached-chat-window-state.json"),
    draftStatePath: join(directory, "detached-chat-pending-drafts.json"),
    iconPath: join(directory, "icon.png"),
    backgroundColor: "#101214",
    onDock: docked,
  });
  coordinator.registerIpc();
  return {
    directory,
    ipc,
    main,
    popups,
    hardened,
    protocolSessions,
    protocolConversationIds,
    docked,
    coordinator,
  };
}

async function cleanup(value: Fixture): Promise<void> {
  await value.coordinator.shutdown();
  rmSync(value.directory, { recursive: true, force: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detached chat main-process boundary", () => {
  it("uses the channel product name for native detached windows", async () => {
    const value = fixture(undefined, undefined, "Inertia Canary");
    try {
      await value.ipc.invoke(
        DETACHED_CHAT_IPC.open,
        eventFor(value.main.webContents),
        { conversationId: FIRST_ID, title: "Canary chat", draft: "" },
      );
      expect(value.popups[0]?.title).toBe("Canary chat — Inertia Canary");
    } finally {
      await cleanup(value);
    }
  });

  it("creates one hardened native window at the fixed renderer URL", async () => {
    const value = fixture();
    try {
      expect(await value.ipc.invoke(
        DETACHED_CHAT_IPC.getWindowContext,
        eventFor(value.main.webContents),
      )).toEqual({ role: "main" });

      const opened = await value.ipc.invoke(
        DETACHED_CHAT_IPC.open,
        eventFor(value.main.webContents),
        {
          conversationId: FIRST_ID,
          title: "Build the feature",
          draft: "initial draft",
        },
      );
      expect(opened).toEqual({
        disposition: "opened",
        conversationId: FIRST_ID,
        alwaysOnTop: false,
      });
      const popup = value.popups[0]!;
      expect(popup.options).toMatchObject({
        width: 640,
        height: 780,
        minWidth: 440,
        minHeight: 520,
        show: false,
        frame: true,
        movable: true,
        resizable: true,
        skipTaskbar: false,
        backgroundColor: "#101214",
        webPreferences: {
          preload: join(value.directory, "detached-chat.cjs"),
          partition: expect.stringMatching(/^inertia-detached-chat-/u),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          navigateOnDragDrop: false,
        },
      });
      expect(popup.options).not.toHaveProperty("parent");
      expect(popup.options).not.toHaveProperty("modal");
      expect(popup.options.webPreferences).not.toHaveProperty(
        "additionalArguments",
      );
      expect(popup.loadedUrls).toEqual([RENDERER_URL]);
      expect(popup.loadedUrls[0]).not.toContain(FIRST_ID);
      expect(value.protocolSessions).toEqual([popup.webContents.session]);
      expect(value.protocolConversationIds).toEqual([FIRST_ID]);
      expect(value.hardened).toEqual([popup.webContents.session]);
      expect(popup.webContents.windowOpenHandler?.()).toEqual({
        action: "deny",
      });
      expect(popup.visible).toBe(true);
      expect(popup.focused).toBe(true);

      const blockedNavigation = { preventDefault: vi.fn() };
      popup.webContents.emit(
        "will-navigate",
        blockedNavigation,
        "https://example.com/",
      );
      expect(blockedNavigation.preventDefault).toHaveBeenCalledOnce();
      const fixedNavigation = { preventDefault: vi.fn() };
      popup.webContents.emit("will-redirect", fixedNavigation, RENDERER_URL);
      expect(fixedNavigation.preventDefault).not.toHaveBeenCalled();
      const webview = { preventDefault: vi.fn() };
      popup.webContents.emit("will-attach-webview", webview);
      expect(webview.preventDefault).toHaveBeenCalledOnce();

      expect(await value.ipc.invoke(
        DETACHED_CHAT_IPC.getWindowContext,
        eventFor(popup.webContents),
      )).toEqual({
        role: "detached-chat",
        conversationId: FIRST_ID,
        alwaysOnTop: false,
        draft: "initial draft",
      });
      expect(value.main.webContents.sent).toContainEqual({
        channel: DETACHED_CHAT_IPC.windowsChanged,
        args: [[{ conversationId: FIRST_ID, alwaysOnTop: false }]],
      });

      const duplicate = await value.ipc.invoke(
        DETACHED_CHAT_IPC.open,
        eventFor(value.main.webContents),
        {
          conversationId: FIRST_ID,
          title: "Renamed",
          draft: "must not replace the live owner",
        },
      );
      expect(duplicate).toMatchObject({ disposition: "focused" });
      expect(value.popups).toHaveLength(1);
      expect(popup.title).toBe("Renamed — Inertia");
    } finally {
      await cleanup(value);
    }
  });

  it("binds every IPC method to an exact trusted role and main frame", async () => {
    const value = fixture();
    try {
      await value.ipc.invoke(
        DETACHED_CHAT_IPC.open,
        eventFor(value.main.webContents),
        { conversationId: FIRST_ID, title: "First", draft: "draft" },
      );
      const popup = value.popups[0]!;

      await expect(value.ipc.invoke(
        DETACHED_CHAT_IPC.open,
        eventFor(popup.webContents),
        { conversationId: SECOND_ID, title: "Second", draft: "draft" },
      )).rejects.toThrow("Rejected untrusted renderer request");
      await expect(value.ipc.invoke(
        DETACHED_CHAT_IPC.close,
        eventFor(value.main.webContents),
        "draft",
      )).rejects.toThrow("Rejected untrusted renderer request");
      await expect(value.ipc.invoke(
        DETACHED_CHAT_IPC.getWindows,
        eventFor(value.main.webContents),
        "extra",
      )).rejects.toThrow("Rejected untrusted renderer request");

      const untrustedFrame = { url: `${RENDERER_URL}#${FIRST_ID}` };
      await expect(value.ipc.invoke(
        DETACHED_CHAT_IPC.getWindowContext,
        eventFor(popup.webContents, untrustedFrame),
      )).rejects.toThrow("Rejected untrusted renderer request");
      const sameUrlSubframe = { url: RENDERER_URL };
      await expect(value.ipc.invoke(
        DETACHED_CHAT_IPC.getWindowContext,
        eventFor(popup.webContents, sameUrlSubframe),
      )).rejects.toThrow("Rejected untrusted renderer request");
      await expect(value.ipc.invoke(
        DETACHED_CHAT_IPC.focus,
        eventFor(value.main.webContents),
        "not-a-conversation",
      )).rejects.toThrow("Invalid detached-chat conversation");

      expect(value.coordinator.windowForTrustedChatIpc(
        eventFor(value.main.webContents),
        0,
      )).toBe(value.main);
      expect(value.coordinator.windowForTrustedChatIpc(
        eventFor(popup.webContents),
        1,
        1,
      )).toBe(popup);

      const pinned = await value.ipc.invoke(
        DETACHED_CHAT_IPC.setAlwaysOnTop,
        eventFor(popup.webContents),
        true,
      );
      expect(pinned).toEqual({
        conversationId: FIRST_ID,
        alwaysOnTop: true,
      });
      await value.ipc.invoke(
        DETACHED_CHAT_IPC.retarget,
        eventFor(popup.webContents),
        { conversationId: FIRST_ID, title: "Renamed" },
      );
      expect(value.coordinator.summaries()).toEqual([{
        conversationId: FIRST_ID,
        alwaysOnTop: true,
      }]);
      expect(popup.title).toBe("Renamed — Inertia");
      await expect(value.ipc.invoke(
        DETACHED_CHAT_IPC.retarget,
        eventFor(popup.webContents),
        { conversationId: SECOND_ID, title: "Second" },
      )).rejects.toThrow("cannot change chats");
      expect(value.coordinator.focusForNotification(FIRST_ID)).toBe(true);
      expect(value.coordinator.isFocusedForNotification(FIRST_ID)).toBe(true);

      value.coordinator.sendToDetached("inertia:runtime-ready");
      expect(popup.webContents.sent.at(-1)).toEqual({
        channel: "inertia:runtime-ready",
        args: [],
      });
      value.coordinator.setBackgroundColor("#22262a");
      expect(popup.backgroundColor).toBe("#22262a");
    } finally {
      await cleanup(value);
    }
  });

  it("uses a unique non-persistent session for every popup", async () => {
    const value = fixture();
    try {
      for (const [conversationId, title] of [
        [FIRST_ID, "First"],
        [SECOND_ID, "Second"],
      ] as const) {
        await value.ipc.invoke(
          DETACHED_CHAT_IPC.open,
          eventFor(value.main.webContents),
          { conversationId, title, draft: "" },
        );
      }
      const partitions = value.popups.map((popup) =>
        popup.options.webPreferences?.partition
      );
      expect(partitions).toHaveLength(2);
      expect(partitions[0]).toMatch(/^inertia-detached-chat-/u);
      expect(partitions[1]).toMatch(/^inertia-detached-chat-/u);
      expect(partitions[0]).not.toBe(partitions[1]);
      expect(partitions.every((partition) => !partition?.startsWith("persist:")))
        .toBe(true);
    } finally {
      await cleanup(value);
    }
  });

  it("destroys a hidden popup when its isolated protocol cannot register", async () => {
    const value = fixture(undefined, new Error("protocol unavailable"));
    try {
      await expect(value.ipc.invoke(
        DETACHED_CHAT_IPC.open,
        eventFor(value.main.webContents),
        { conversationId: FIRST_ID, title: "First", draft: "draft" },
      )).rejects.toThrow("protocol unavailable");
      expect(value.popups).toHaveLength(1);
      expect(value.popups[0]?.destroyCalls).toBe(1);
      expect(value.coordinator.summaries()).toEqual([]);
    } finally {
      await cleanup(value);
    }
  });

  it("hands exact drafts across isolated renderer sessions", async () => {
    const value = fixture();
    try {
      await value.ipc.invoke(
        DETACHED_CHAT_IPC.open,
        eventFor(value.main.webContents),
        { conversationId: FIRST_ID, title: "First", draft: "initial draft" },
      );
      const popup = value.popups[0]!;
      const persistenceEvent = eventFor(
        popup.webContents,
      ) as unknown as IpcMainEvent;

      value.ipc.emit(
        DETACHED_CHAT_IPC.persistDraft,
        persistenceEvent,
        "latest popup draft",
      );

      expect(persistenceEvent.returnValue).toBe(true);
      expect(value.main.webContents.sent).toContainEqual({
        channel: DETACHED_CHAT_IPC.draftChanged,
        args: [expect.objectContaining({
          conversationId: FIRST_ID,
          draft: "latest popup draft",
          handoffId: expect.any(String),
        })],
      });
      expect(await value.ipc.invoke(
        DETACHED_CHAT_IPC.getWindowContext,
        eventFor(popup.webContents),
      )).toMatchObject({ draft: "latest popup draft" });

      const [firstPending] = await value.ipc.invoke(
        DETACHED_CHAT_IPC.getPendingDrafts,
        eventFor(value.main.webContents),
      ) as Array<{ conversationId: string; draft: string; handoffId: string }>;
      expect(firstPending).toMatchObject({
        conversationId: FIRST_ID,
        draft: "latest popup draft",
        handoffId: expect.any(String),
      });

      value.ipc.emit(
        DETACHED_CHAT_IPC.persistDraft,
        persistenceEvent,
        "newer popup draft",
      );
      const [newerPending] = await value.ipc.invoke(
        DETACHED_CHAT_IPC.getPendingDrafts,
        eventFor(value.main.webContents),
      ) as Array<{ conversationId: string; draft: string; handoffId: string }>;
      expect(newerPending?.handoffId).not.toBe(firstPending?.handoffId);
      await expect(value.ipc.invoke(
        DETACHED_CHAT_IPC.getPendingDrafts,
        eventFor(popup.webContents),
      )).rejects.toThrow("Rejected untrusted renderer request");
      expect(await value.ipc.invoke(
        DETACHED_CHAT_IPC.acknowledgeDraft,
        eventFor(value.main.webContents),
        {
          conversationId: FIRST_ID,
          handoffId: firstPending!.handoffId,
        },
      )).toBe(false);
      expect(await value.ipc.invoke(
        DETACHED_CHAT_IPC.acknowledgeDraft,
        eventFor(value.main.webContents),
        {
          conversationId: FIRST_ID,
          handoffId: newerPending!.handoffId,
        },
      )).toBe(true);
      expect(await value.ipc.invoke(
        DETACHED_CHAT_IPC.getPendingDrafts,
        eventFor(value.main.webContents),
      )).toEqual([expect.objectContaining({
        conversationId: FIRST_ID,
        draft: "newer popup draft",
        handoffId: expect.not.stringMatching(newerPending!.handoffId),
      })]);

      const rejectedEvent = eventFor(
        value.main.webContents,
      ) as unknown as IpcMainEvent;
      value.ipc.emit(
        DETACHED_CHAT_IPC.persistDraft,
        rejectedEvent,
        "foreign draft",
      );
      expect(rejectedEvent.returnValue).toBe(false);

      const subframeEvent = eventFor(
        popup.webContents,
        { url: RENDERER_URL },
      ) as unknown as IpcMainEvent;
      value.ipc.emit(
        DETACHED_CHAT_IPC.persistDraft,
        subframeEvent,
        "subframe draft",
      );
      expect(subframeEvent.returnValue).toBe(false);
    } finally {
      await cleanup(value);
    }
  });

  it("recovers the latest mirrored draft after a popup renderer crash", async () => {
    const value = fixture();
    try {
      await value.ipc.invoke(
        DETACHED_CHAT_IPC.open,
        eventFor(value.main.webContents),
        { conversationId: FIRST_ID, title: "First", draft: "initial" },
      );
      const popup = value.popups[0]!;
      const mirrorEvent = eventFor(popup.webContents) as unknown as IpcMainEvent;
      value.ipc.emit(
        DETACHED_CHAT_IPC.mirrorDraft,
        mirrorEvent,
        "latest mirrored draft",
      );

      expect(mirrorEvent.returnValue).toBe(true);
      expect(value.main.webContents.sent).toContainEqual({
        channel: DETACHED_CHAT_IPC.draftMirrored,
        args: [{
          conversationId: FIRST_ID,
          draft: "latest mirrored draft",
        }],
      });
      popup.webContents.emit("render-process-gone");

      expect(popup.destroyCalls).toBe(1);
      expect(value.coordinator.summaries()).toEqual([]);
      expect(await value.ipc.invoke(
        DETACHED_CHAT_IPC.getPendingDrafts,
        eventFor(value.main.webContents),
      )).toEqual([expect.objectContaining({
        conversationId: FIRST_ID,
        draft: "latest mirrored draft",
        handoffId: expect.any(String),
      })]);
    } finally {
      await cleanup(value);
    }
  });

  it("docks only after an explicit dock closes; native close stays silent", async () => {
    let value: Fixture;
    const dockObservations: Array<{ destroyed: boolean; summaries: number }> = [];
    value = fixture(() => {
      dockObservations.push({
        destroyed: value.popups.at(-1)?.destroyed ?? false,
        summaries: value.coordinator.summaries().length,
      });
    });
    try {
      const open = async (): Promise<FakeBrowserWindow> => {
        await value.ipc.invoke(
          DETACHED_CHAT_IPC.open,
          eventFor(value.main.webContents),
          { conversationId: FIRST_ID, title: "First", draft: "initial" },
        );
        return value.popups.at(-1)!;
      };

      const nativeClosed = await open();
      nativeClosed.close();
      expect(nativeClosed.closeCalls).toBe(1);
      expect(nativeClosed.destroyCalls).toBe(0);
      expect(value.docked).not.toHaveBeenCalled();

      const explicitlyClosed = await open();
      await value.ipc.invoke(
        DETACHED_CHAT_IPC.close,
        eventFor(explicitlyClosed.webContents),
        "closed draft",
      );
      expect(explicitlyClosed.destroyed).toBe(false);
      await afterIpcReply();
      expect(explicitlyClosed.destroyed).toBe(true);
      expect(explicitlyClosed.closeCalls).toBe(0);
      expect(explicitlyClosed.destroyCalls).toBe(1);
      expect(value.docked).not.toHaveBeenCalled();

      const docked = await open();
      await value.ipc.invoke(
        DETACHED_CHAT_IPC.dock,
        eventFor(docked.webContents),
        "docked draft",
      );
      await value.ipc.invoke(
        DETACHED_CHAT_IPC.dock,
        eventFor(docked.webContents),
        "newer docked draft",
      );
      expect(docked.destroyed).toBe(false);
      await afterIpcReply();
      expect(value.docked).toHaveBeenCalledOnce();
      expect(value.docked).toHaveBeenCalledWith(FIRST_ID);
      expect(dockObservations).toEqual([{ destroyed: true, summaries: 0 }]);
    } finally {
      await cleanup(value);
    }
  });

  it("removes only its invoke handlers during shutdown", async () => {
    const value = fixture();
    try {
      expect(value.ipc.handlers.size).toBe(10);
      expect(value.ipc.listeners.get(DETACHED_CHAT_IPC.persistDraft)?.size)
        .toBe(1);
      expect(value.ipc.listeners.get(DETACHED_CHAT_IPC.mirrorDraft)?.size)
        .toBe(1);
      await value.coordinator.shutdown();
      expect(value.ipc.handlers.size).toBe(0);
      expect(value.ipc.listeners.get(DETACHED_CHAT_IPC.persistDraft)?.size)
        .toBe(0);
      expect(value.ipc.listeners.get(DETACHED_CHAT_IPC.mirrorDraft)?.size)
        .toBe(0);
      value.coordinator.unregisterIpc();
    } finally {
      rmSync(value.directory, { recursive: true, force: true });
    }
  });
});
