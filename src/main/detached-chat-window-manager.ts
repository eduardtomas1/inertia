import type {
  BrowserWindow,
  Rectangle,
  WebContents,
} from "electron";

import {
  DETACHED_CHAT_WINDOW_LIMIT,
  type DetachedChatWindowOpenResult,
  type DetachedChatWindowRequest,
  type DetachedChatWindowSummary,
  type DesktopWindowContext,
} from "../shared/desktop.js";
import {
  type DetachedChatDisplay,
  type DetachedChatWindowBounds,
  DetachedChatWindowStateStore,
} from "./detached-chat-window-state.js";

export interface DetachedChatWindowFactoryInput {
  request: Readonly<DetachedChatWindowRequest>;
  bounds: Readonly<DetachedChatWindowBounds>;
}

export interface DetachedChatWindowManagerOptions {
  /** Creates a hidden, hardened BrowserWindow. No renderer URL is accepted. */
  createWindow(input: DetachedChatWindowFactoryInput): BrowserWindow;
  /** Loads the one fixed application renderer selected by the main process. */
  loadWindow(window: BrowserWindow): Promise<void>;
  getDisplays(): readonly DetachedChatDisplay[];
  state: DetachedChatWindowStateStore;
  onWindowsChanged?(windows: DetachedChatWindowSummary[]): void;
  onRendererGone?(conversationId: string): void;
  formatTitle?(title: string): string;
  saveDelayMs?: number;
}

interface DetachedChatWindowRecord {
  request: DetachedChatWindowRequest;
  window: BrowserWindow;
  contents: WebContents;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: unknown): void;
  readySettled: boolean;
  loaded: boolean;
  closing: boolean;
}

const UNTRUSTED_SENDER_ERROR = "Rejected untrusted detached-chat renderer";

export class DetachedChatWindowManager {
  readonly #byConversation = new Map<string, DetachedChatWindowRecord>();
  readonly #bySender = new Map<WebContents, DetachedChatWindowRecord>();
  readonly #options: DetachedChatWindowManagerOptions;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #closeAllOperation: Promise<void> | null = null;

  constructor(options: DetachedChatWindowManagerOptions) {
    this.#options = options;
  }

  async open(
    request: DetachedChatWindowRequest,
  ): Promise<DetachedChatWindowOpenResult> {
    if (this.#closeAllOperation) {
      throw new Error("Detached chat windows are closing.");
    }
    const existing = this.#byConversation.get(request.conversationId);
    if (existing) {
      existing.request = { ...request };
      this.#setTitle(existing);
      await existing.ready;
      if (this.#byConversation.get(request.conversationId) !== existing) {
        return await this.open(request);
      }
      this.#focusRecord(existing);
      return { disposition: "focused", ...this.#recordSummary(existing) };
    }
    if (this.#byConversation.size >= DETACHED_CHAT_WINDOW_LIMIT) {
      throw new Error(
        `No more than ${DETACHED_CHAT_WINDOW_LIMIT} detached chats can be open.`,
      );
    }

    const bounds = this.#options.state.restore(
      request.conversationId,
      this.#options.getDisplays(),
    );
    const window = this.#options.createWindow({
      request: { ...request },
      bounds,
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Every record is registered before privileged code begins loading the
    // renderer, so early preload invokes can be bound to this exact sender.
    const record: DetachedChatWindowRecord = {
      request: { ...request },
      window,
      contents: window.webContents,
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      loaded: false,
      closing: false,
    };
    this.#byConversation.set(request.conversationId, record);
    this.#bySender.set(record.contents, record);
    this.#bindWindow(record);
    this.#setTitle(record);
    this.#emitWindowsChanged();

    void Promise.resolve().then(
      () => this.#options.loadWindow(window),
    ).then(() => {
      if (!this.#ownsRecord(record) || window.isDestroyed()) {
        this.#rejectReady(
          record,
          new Error("The detached chat window closed while loading."),
        );
        return;
      }
      record.loaded = true;
      this.#resolveReady(record);
    }, (error: unknown) => {
      this.#rejectReady(record, error);
      this.#removeRecord(record);
      if (!window.isDestroyed()) window.destroy();
    });

    await ready;
    this.#focusRecord(record);
    return { disposition: "opened", ...this.#recordSummary(record) };
  }

  summary(): DetachedChatWindowSummary[] {
    return [...this.#byConversation.values()]
      .filter((record) => !record.window.isDestroyed())
      .map((record) => this.#recordSummary(record));
  }

  focus(conversationId: string): boolean {
    const record = this.#byConversation.get(conversationId);
    if (!record || record.window.isDestroyed()) return false;
    if (record.loaded) {
      this.#focusRecord(record);
    } else {
      void record.ready.then(() => this.#focusRecord(record), () => undefined);
    }
    return true;
  }

  isFocused(conversationId: string): boolean {
    const record = this.#byConversation.get(conversationId);
    return Boolean(
      record
      && !record.window.isDestroyed()
      && record.window.isFocused(),
    );
  }

  windowForConversation(conversationId: string): BrowserWindow | null {
    const record = this.#byConversation.get(conversationId);
    return record && !record.window.isDestroyed() ? record.window : null;
  }

  windowForSender(sender: WebContents): BrowserWindow | null {
    const record = this.#bySender.get(sender);
    return record && !record.window.isDestroyed() ? record.window : null;
  }

  ownsSender(sender: WebContents): boolean {
    return this.windowForSender(sender) !== null;
  }

  contextForSender(
    sender: WebContents,
  ): Omit<Extract<DesktopWindowContext, { role: "detached-chat" }>, "draft"> {
    const record = this.#requireSender(sender);
    return { role: "detached-chat", ...this.#recordSummary(record) };
  }

  setAlwaysOnTopForSender(
    sender: WebContents,
    alwaysOnTop: boolean,
  ): DetachedChatWindowSummary {
    if (typeof alwaysOnTop !== "boolean") {
      throw new Error("Invalid detached-chat always-on-top request");
    }
    const record = this.#requireSender(sender);
    record.window.setAlwaysOnTop(alwaysOnTop);
    this.#emitWindowsChanged();
    return this.#recordSummary(record);
  }

  retargetForSender(
    sender: WebContents,
    request: DetachedChatWindowRequest,
  ): DetachedChatWindowSummary {
    const record = this.#requireSender(sender);
    if (request.conversationId !== record.request.conversationId) {
      throw new Error("A detached chat window cannot change chats.");
    }
    record.request = { ...request };
    this.#setTitle(record);
    this.#emitWindowsChanged();
    return this.#recordSummary(record);
  }

  closeForSender(sender: WebContents): void {
    const record = this.#requireSender(sender);
    this.#rememberBounds(record);
    this.#options.state.flush();
    record.window.destroy();
  }

  close(conversationId: string): boolean {
    const record = this.#byConversation.get(conversationId);
    if (!record || record.window.isDestroyed()) return false;
    this.#rememberBounds(record);
    this.#options.state.flush();
    record.window.destroy();
    return true;
  }

  closeAll(closeTimeoutMs = 1_500): Promise<void> {
    if (this.#closeAllOperation) return this.#closeAllOperation;
    const operation = this.#closeAll(closeTimeoutMs);
    let tracked!: Promise<void>;
    tracked = operation.finally(() => {
      if (this.#closeAllOperation === tracked) this.#closeAllOperation = null;
    });
    this.#closeAllOperation = tracked;
    return tracked;
  }

  async #closeAll(closeTimeoutMs: number): Promise<void> {
    if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs < 0) {
      throw new Error("Invalid detached-chat close timeout");
    }
    this.#cancelScheduledSave();
    const records = [...this.#byConversation.values()];
    for (const record of records) this.#rememberBounds(record);
    this.#options.state.flush();
    await Promise.all(records.map((record) => this.#closeGracefully(
      record,
      closeTimeoutMs,
    )));
  }

  sendToAll(channel: string, ...args: unknown[]): void {
    for (const record of this.#byConversation.values()) {
      const contents = record.contents;
      if (!record.window.isDestroyed() && !contents.isDestroyed()) {
        contents.send(channel, ...args);
      }
    }
  }

  broadcast(channel: string, ...args: unknown[]): void {
    this.sendToAll(channel, ...args);
  }

  flushWindowState(): void {
    this.#cancelScheduledSave();
    for (const record of this.#byConversation.values()) {
      this.#rememberBounds(record);
    }
    this.#options.state.flush();
  }

  #bindWindow(record: DetachedChatWindowRecord): void {
    const scheduleSave = (): void => this.#scheduleSave();
    record.window.on("move", scheduleSave);
    record.window.on("resize", scheduleSave);
    record.window.on("close", () => {
      record.closing = true;
      this.#rememberBounds(record);
      this.#options.state.flush();
    });
    record.contents.on("will-prevent-unload", () => {
      if (this.#ownsRecord(record) && !record.window.isDestroyed()) {
        record.closing = false;
      }
    });
    record.window.once("closed", () => {
      if (!record.loaded) {
        this.#rejectReady(
          record,
          new Error("The detached chat window closed while loading."),
        );
      }
      this.#removeRecord(record);
    });
    record.contents.once("render-process-gone", () => {
      if (
        !record.closing
        && this.#ownsRecord(record)
        && !record.window.isDestroyed()
      ) {
        // A renderer crash has no beforeunload work to preserve. Destroying
        // avoids recursively entering close while Electron tears it down.
        try {
          this.#options.onRendererGone?.(record.request.conversationId);
        } catch {
          // A crashed renderer cannot be retained when recovery persistence fails.
        }
        record.window.destroy();
      }
    });
  }

  #closeGracefully(
    record: DetachedChatWindowRecord,
    closeTimeoutMs: number,
  ): Promise<void> {
    const window = record.window;
    if (window.isDestroyed()) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      window.once("closed", finish);
      timer = setTimeout(() => {
        try {
          if (!window.isDestroyed()) window.destroy();
        } catch {
          // Shutdown proceeds after the bounded attempt.
        } finally {
          finish();
        }
      }, closeTimeoutMs);
      try {
        window.close();
      } catch {
        try {
          if (!window.isDestroyed()) window.destroy();
        } catch {
          // Shutdown proceeds after the bounded attempt.
        } finally {
          finish();
        }
      }
    });
  }

  #requireSender(sender: WebContents): DetachedChatWindowRecord {
    const record = this.#bySender.get(sender);
    if (!record || record.window.isDestroyed() || !this.#ownsRecord(record)) {
      throw new Error(UNTRUSTED_SENDER_ERROR);
    }
    return record;
  }

  #ownsRecord(record: DetachedChatWindowRecord): boolean {
    return this.#byConversation.get(record.request.conversationId) === record
      && this.#bySender.get(record.contents) === record;
  }

  #focusRecord(record: DetachedChatWindowRecord): void {
    const window = record.window;
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  #recordSummary(
    record: DetachedChatWindowRecord,
  ): DetachedChatWindowSummary {
    return {
      conversationId: record.request.conversationId,
      alwaysOnTop: record.window.isAlwaysOnTop(),
    };
  }

  #setTitle(record: DetachedChatWindowRecord): void {
    const title = this.#options.formatTitle?.(record.request.title)
      ?? `${record.request.title} — Inertia`;
    record.window.setTitle(title);
  }

  #removeRecord(record: DetachedChatWindowRecord): void {
    if (this.#bySender.get(record.contents) === record) {
      this.#bySender.delete(record.contents);
    }
    if (this.#byConversation.get(record.request.conversationId) === record) {
      this.#byConversation.delete(record.request.conversationId);
      this.#emitWindowsChanged();
    }
  }

  #resolveReady(record: DetachedChatWindowRecord): void {
    if (record.readySettled) return;
    record.readySettled = true;
    record.resolveReady();
  }

  #rejectReady(record: DetachedChatWindowRecord, error: unknown): void {
    if (record.readySettled) return;
    record.readySettled = true;
    record.rejectReady(error);
  }

  #rememberBounds(
    record: DetachedChatWindowRecord,
    conversationId = record.request.conversationId,
  ): void {
    if (record.window.isDestroyed()) return;
    let bounds: Rectangle;
    try {
      bounds = record.window.isMaximized() || record.window.isFullScreen()
        ? record.window.getNormalBounds()
        : record.window.getBounds();
    } catch {
      return;
    }
    this.#options.state.remember(conversationId, bounds);
  }

  #scheduleSave(): void {
    this.#cancelScheduledSave();
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.flushWindowState();
    }, this.#options.saveDelayMs ?? 300);
  }

  #cancelScheduledSave(): void {
    if (this.#saveTimer === null) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
  }

  #emitWindowsChanged(): void {
    this.#options.onWindowsChanged?.(this.summary());
  }
}
