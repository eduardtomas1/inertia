import { isAbsolute } from "node:path";

import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Display,
  IpcMainInvokeEvent,
  Session,
  WebContents,
} from "electron";

import {
  parseDetachedChatWindowRequest,
  type DesktopWindowContext,
  type DetachedChatWindowSummary,
} from "../shared/desktop.js";
import { DETACHED_CHAT_IPC } from "../shared/detached-chat-ipc.js";
import {
  DetachedChatWindowManager,
  type DetachedChatWindowFactoryInput,
} from "./detached-chat-window-manager.js";
import {
  DETACHED_CHAT_MIN_BOUNDS,
  DetachedChatWindowStateStore,
} from "./detached-chat-window-state.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UNTRUSTED_RENDERER_ERROR = "Rejected untrusted renderer request";

export interface DetachedChatIpcMain {
  handle(
    channel: string,
    listener: (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => unknown | Promise<unknown>,
  ): void;
  removeHandler(channel: string): void;
}

export interface DetachedChatMainOptions {
  ipcMain: DetachedChatIpcMain;
  mainWindow(): BrowserWindow | null;
  createBrowserWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  getDisplays(): readonly Pick<Display, "workArea">[];
  hardenSession(session: Session): void;
  rendererUrl: string;
  preloadPath: string;
  statePath: string;
  iconPath: string;
  backgroundColor: string;
  onDock(conversationId: string): void | Promise<void>;
}

type TrustedWindowRole = DesktopWindowContext["role"];

function fixedRendererUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Detached chats require a valid fixed renderer URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Detached chats require a fixed renderer URL without state");
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const loopback = parsed.hostname === "localhost"
      || parsed.hostname === "127.0.0.1"
      || parsed.hostname === "[::1]";
    if (!loopback) {
      throw new Error("Detached chat development renderers must be loopback-only");
    }
  } else if (parsed.protocol !== "inertia:") {
    throw new Error("Detached chats require the application renderer protocol");
  }
  return parsed.href;
}

function conversationId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Invalid detached-chat conversation");
  }
  return value;
}

function liveWindow(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed());
}

/**
 * Owns the privileged detached-chat boundary. Conversation identity lives only
 * in the main-process manager and never in the renderer URL or Chromium args.
 */
export class DetachedChatMain {
  readonly #options: DetachedChatMainOptions;
  readonly #rendererUrl: string;
  readonly #manager: DetachedChatWindowManager;
  #backgroundColor: string;
  #ipcRegistered = false;

  constructor(options: DetachedChatMainOptions) {
    if (!isAbsolute(options.preloadPath)) {
      throw new Error("Detached chat preload path must be absolute");
    }
    this.#options = options;
    this.#rendererUrl = fixedRendererUrl(options.rendererUrl);
    this.#backgroundColor = options.backgroundColor;
    this.#manager = new DetachedChatWindowManager({
      createWindow: (input) => this.#createWindow(input),
      loadWindow: async (window) => {
        await window.loadURL(this.#rendererUrl);
      },
      getDisplays: () => options.getDisplays(),
      state: new DetachedChatWindowStateStore(options.statePath),
      onWindowsChanged: (windows) => this.#broadcastWindows(windows),
    });
  }

  registerIpc(): () => void {
    if (this.#ipcRegistered) return () => this.unregisterIpc();
    this.#ipcRegistered = true;

    this.#options.ipcMain.handle(
      DETACHED_CHAT_IPC.getWindowContext,
      (event, ...args) => this.assertTrustedChatIpc(event, args.length),
    );
    this.#options.ipcMain.handle(
      DETACHED_CHAT_IPC.open,
      async (event, ...args) => {
        this.assertMainIpc(event, args.length, 1);
        const request = parseDetachedChatWindowRequest(args[0]);
        if (!request) throw new Error("Invalid detached-chat window request");
        return await this.#manager.open(request);
      },
    );
    this.#options.ipcMain.handle(
      DETACHED_CHAT_IPC.focus,
      (event, ...args) => {
        this.assertMainIpc(event, args.length, 1);
        return this.#manager.focus(conversationId(args[0]));
      },
    );
    this.#options.ipcMain.handle(
      DETACHED_CHAT_IPC.getWindows,
      (event, ...args) => {
        this.assertMainIpc(event, args.length);
        return this.#manager.summary();
      },
    );
    this.#options.ipcMain.handle(
      DETACHED_CHAT_IPC.setAlwaysOnTop,
      (event, ...args) => {
        this.#assertDetachedIpc(event, args.length, 1);
        if (typeof args[0] !== "boolean") {
          throw new Error("Invalid detached-chat always-on-top request");
        }
        return this.#manager.setAlwaysOnTopForSender(event.sender, args[0]);
      },
    );
    this.#options.ipcMain.handle(
      DETACHED_CHAT_IPC.retarget,
      (event, ...args) => {
        this.#assertDetachedIpc(event, args.length, 1);
        const request = parseDetachedChatWindowRequest(args[0]);
        if (!request) throw new Error("Invalid detached-chat window request");
        return this.#manager.retargetForSender(event.sender, request);
      },
    );
    this.#options.ipcMain.handle(
      DETACHED_CHAT_IPC.dock,
      (event, ...args) => {
        const context = this.#assertDetachedIpc(event, args.length);
        this.#scheduleCloseAfterIpcReply(
          event.sender,
          context.conversationId,
        );
      },
    );
    this.#options.ipcMain.handle(
      DETACHED_CHAT_IPC.close,
      (event, ...args) => {
        this.#assertDetachedIpc(event, args.length);
        this.#scheduleCloseAfterIpcReply(event.sender);
      },
    );

    return () => this.unregisterIpc();
  }

  unregisterIpc(): void {
    if (!this.#ipcRegistered) return;
    this.#ipcRegistered = false;
    for (const channel of Object.values(DETACHED_CHAT_IPC)) {
      if (channel !== DETACHED_CHAT_IPC.windowsChanged) {
        this.#options.ipcMain.removeHandler(channel);
      }
    }
  }

  assertMainIpc(
    event: IpcMainInvokeEvent,
    argumentCount: number,
    expectedArguments = 0,
  ): void {
    if (
      this.#trustedRole(event, argumentCount, expectedArguments) !== "main"
    ) throw new Error(UNTRUSTED_RENDERER_ERROR);
  }

  assertTrustedChatIpc(
    event: IpcMainInvokeEvent,
    argumentCount: number,
    expectedArguments = 0,
  ): DesktopWindowContext {
    const role = this.#trustedRole(event, argumentCount, expectedArguments);
    if (role === "main") return { role };
    return this.#manager.contextForSender(event.sender);
  }

  windowForTrustedChatIpc(
    event: IpcMainInvokeEvent,
    argumentCount: number,
    expectedArguments = 0,
  ): BrowserWindow {
    const context = this.assertTrustedChatIpc(
      event,
      argumentCount,
      expectedArguments,
    );
    const window = context.role === "main"
      ? this.#options.mainWindow()
      : this.#manager.windowForSender(event.sender);
    if (!liveWindow(window)) throw new Error(UNTRUSTED_RENDERER_ERROR);
    return window;
  }

  summaries(): DetachedChatWindowSummary[] {
    return this.#manager.summary();
  }

  focusForNotification(conversationIdValue: string): boolean {
    return this.#manager.focus(conversationId(conversationIdValue));
  }

  isFocusedForNotification(conversationIdValue: string): boolean {
    return this.#manager.isFocused(conversationId(conversationIdValue));
  }

  windowForConversation(conversationIdValue: string): BrowserWindow | null {
    return this.#manager.windowForConversation(
      conversationId(conversationIdValue),
    );
  }

  sendToDetached(channel: string, ...args: unknown[]): void {
    this.#manager.sendToAll(channel, ...args);
  }

  setBackgroundColor(backgroundColor: string): void {
    if (!backgroundColor || /[\0\r\n]/u.test(backgroundColor)) {
      throw new Error("Invalid detached-chat background color");
    }
    this.#backgroundColor = backgroundColor;
    for (const { conversationId: id } of this.#manager.summary()) {
      const window = this.#manager.windowForConversation(id);
      if (liveWindow(window)) window.setBackgroundColor(backgroundColor);
    }
  }

  flushWindowState(): void {
    this.#manager.flushWindowState();
  }

  closeAll(): void {
    this.#manager.closeAll();
  }

  shutdown(): void {
    this.#manager.closeAll();
    this.unregisterIpc();
  }

  #trustedRole(
    event: IpcMainInvokeEvent,
    argumentCount: number,
    expectedArguments: number,
  ): TrustedWindowRole {
    const frame = event.senderFrame;
    if (
      argumentCount !== expectedArguments
      || !frame
      || frame !== event.sender.mainFrame
      || frame.url !== this.#rendererUrl
    ) throw new Error(UNTRUSTED_RENDERER_ERROR);

    const main = this.#options.mainWindow();
    if (liveWindow(main) && event.sender === main.webContents) return "main";
    if (this.#manager.ownsSender(event.sender)) return "detached-chat";
    throw new Error(UNTRUSTED_RENDERER_ERROR);
  }

  #assertDetachedIpc(
    event: IpcMainInvokeEvent,
    argumentCount: number,
    expectedArguments = 0,
  ): Extract<DesktopWindowContext, { role: "detached-chat" }> {
    const context = this.assertTrustedChatIpc(
      event,
      argumentCount,
      expectedArguments,
    );
    if (context.role !== "detached-chat") {
      throw new Error(UNTRUSTED_RENDERER_ERROR);
    }
    return context;
  }

  #createWindow(input: DetachedChatWindowFactoryInput): BrowserWindow {
    const { bounds } = input;
    const window = this.#options.createBrowserWindow({
      title: "Inertia",
      width: bounds.width,
      height: bounds.height,
      ...(bounds.x === undefined || bounds.y === undefined
        ? {}
        : { x: bounds.x, y: bounds.y }),
      minWidth: DETACHED_CHAT_MIN_BOUNDS.width,
      minHeight: DETACHED_CHAT_MIN_BOUNDS.height,
      show: false,
      frame: true,
      movable: true,
      resizable: true,
      minimizable: true,
      maximizable: true,
      fullscreenable: true,
      skipTaskbar: false,
      autoHideMenuBar: true,
      backgroundColor: this.#backgroundColor,
      icon: this.#options.iconPath,
      webPreferences: {
        preload: this.#options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
      },
    });

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const preventUntrustedNavigation = (
      event: Electron.Event,
      url: string,
    ): void => {
      if (url !== this.#rendererUrl) event.preventDefault();
    };
    window.webContents.on("will-navigate", preventUntrustedNavigation);
    window.webContents.on("will-redirect", preventUntrustedNavigation);
    window.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    this.#options.hardenSession(window.webContents.session);
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    return window;
  }

  #scheduleCloseAfterIpcReply(
    sender: WebContents,
    dockConversationId?: string,
  ): void {
    const window = this.#manager.windowForSender(sender);
    if (!liveWindow(window)) throw new Error(UNTRUSTED_RENDERER_ERROR);
    if (dockConversationId) {
      window.once("closed", () => {
        void Promise.resolve()
          .then(() => this.#options.onDock(dockConversationId))
          .catch(() => undefined);
      });
    }
    // Programmatic close is forceful because Electron can otherwise leave the
    // renderer and main process waiting on each other during beforeunload. The
    // renderer flushes its draft before invoking this boundary; the check-phase
    // callback lets Electron send the invoke reply before the window is gone.
    setImmediate(() => {
      if (!this.#manager.ownsSender(sender)) return;
      this.#manager.closeForSender(sender);
    });
  }

  #broadcastWindows(windows: DetachedChatWindowSummary[]): void {
    const main = this.#options.mainWindow();
    if (
      liveWindow(main)
      && !main.webContents.isDestroyed()
    ) main.webContents.send(DETACHED_CHAT_IPC.windowsChanged, windows);
    this.#manager.sendToAll(DETACHED_CHAT_IPC.windowsChanged, windows);
  }
}
