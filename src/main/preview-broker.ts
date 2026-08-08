import { randomUUID } from "node:crypto";

import {
  WebContentsView,
  type BrowserWindow,
  type Input,
  type KeyboardInputEvent,
  type Rectangle,
  type Session,
} from "electron";

import type { PreviewState } from "../shared/desktop.js";
import { previewNavigationTarget } from "../shared/preview-url.js";

type PreviewOwner = "primary" | "secondary";

interface PreviewSlot {
  view: WebContentsView;
  contextId: string;
  bounds: Rectangle | null;
}

interface PreviewBrokerOptions {
  getWindow: () => BrowserWindow | null;
  openExternal: (url: string) => Promise<void>;
  stateChannel: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hardenedSessions = new WeakSet<Session>();
const APP_SHORTCUT_KEYS = new Set(["b", "j", "k", "n"]);

export function previewAppShortcutKey(input: Pick<
  Input,
  "alt" | "control" | "key" | "meta" | "shift" | "type"
>): string | null {
  const key = input.key.toLowerCase();
  return input.type === "keyDown"
      && (input.meta || input.control)
      && !input.alt
      && !input.shift
      && APP_SHORTCUT_KEYS.has(key)
    ? key
    : null;
}

function forwardedKeyboardInput(input: Input): KeyboardInputEvent {
  const modifiers: NonNullable<KeyboardInputEvent["modifiers"]> = [];
  if (input.control) modifiers.push("control");
  if (input.meta) modifiers.push("meta");
  return {
    type: input.type === "keyUp" ? "keyUp" : "keyDown",
    keyCode: input.key,
    modifiers,
  };
}

export function createPreviewPartition(): string {
  return `inertia-preview-${randomUUID()}`;
}

export function hardenDesktopSession(session: Session): void {
  if (hardenedSessions.has(session)) return;
  hardenedSessions.add(session);
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.on("will-download", (event, item) => {
    event.preventDefault();
    item.cancel();
  });
}

function previewOwner(value: unknown): PreviewOwner {
  if (value !== "primary" && value !== "secondary") {
    throw new Error("Invalid preview owner");
  }
  return value;
}

function previewContext(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Invalid preview context");
  }
  return value;
}

export class PreviewBroker {
  readonly #slots = new Map<PreviewOwner, PreviewSlot>();
  readonly #pendingBounds = new Map<PreviewOwner, {
    contextId: string;
    bounds: Rectangle;
  }>();

  constructor(private readonly options: PreviewBrokerOptions) {}

  async navigate(value: unknown): Promise<PreviewState> {
    const request = this.#request(value);
    const target = previewNavigationTarget(request.url);
    if (target.kind === "external") {
      await this.options.openExternal(target.url.toString());
      return this.#state(request.ownerId, request.contextId);
    }
    const view = this.#ensure(request.ownerId, request.contextId);
    await view.webContents.loadURL(target.url.toString());
    return this.#state(request.ownerId, request.contextId);
  }

  command(value: unknown): PreviewState {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid preview request");
    }
    const request = value as {
      ownerId?: unknown;
      contextId?: unknown;
      action?: unknown;
    };
    const ownerId = previewOwner(request.ownerId);
    const contextId = previewContext(request.contextId);
    const contents = this.#ownedSlot(ownerId, contextId)?.view.webContents;
    const action = request.action;
    if (
      !contents
      || (action !== "back" && action !== "forward" && action !== "reload")
    ) return this.#state(ownerId, contextId);
    if (action === "back" && contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    } else if (
      action === "forward"
      && contents.navigationHistory.canGoForward()
    ) {
      contents.navigationHistory.goForward();
    } else if (action === "reload") {
      contents.reload();
    }
    return this.#state(ownerId, contextId);
  }

  setBounds(value: unknown): void {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid preview request");
    }
    const request = value as {
      ownerId?: unknown;
      contextId?: unknown;
      bounds?: unknown;
    };
    const ownerId = previewOwner(request.ownerId);
    const contextId = previewContext(request.contextId);
    if (request.bounds === null) {
      const pending = this.#pendingBounds.get(ownerId);
      if (pending?.contextId === contextId) this.#pendingBounds.delete(ownerId);
      const slot = this.#ownedSlot(ownerId, contextId);
      if (slot) {
        slot.bounds = { x: 0, y: 0, width: 0, height: 0 };
        slot.view.setBounds(slot.bounds);
      }
      return;
    }
    if (!request.bounds || typeof request.bounds !== "object") {
      throw new Error("Invalid preview bounds");
    }
    const candidate = request.bounds as Partial<Rectangle>;
    if (
      ![
        candidate.x,
        candidate.y,
        candidate.width,
        candidate.height,
      ].every((entry) => Number.isInteger(entry))
    ) throw new Error("Invalid preview bounds");
    const content = this.options.getWindow()?.getContentBounds();
    if (!content) return;
    const x = Math.max(0, Math.min(candidate.x as number, content.width));
    const y = Math.max(0, Math.min(candidate.y as number, content.height));
    const bounds = {
      x,
      y,
      width: Math.max(
        0,
        Math.min(candidate.width as number, content.width - x),
      ),
      height: Math.max(
        0,
        Math.min(candidate.height as number, content.height - y),
      ),
    };
    this.#pendingBounds.set(ownerId, { contextId, bounds });
    const slot = this.#ownedSlot(ownerId, contextId);
    if (slot) {
      slot.bounds = bounds;
      slot.view.setBounds(bounds);
    }
  }

  closeRequest(value: unknown): void {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid preview request");
    }
    const request = value as {
      ownerId?: unknown;
      contextId?: unknown;
    };
    this.close(
      previewOwner(request.ownerId),
      previewContext(request.contextId),
    );
  }

  close(ownerId?: PreviewOwner, contextId?: string): void {
    const slots = ownerId
      ? [[ownerId, this.#slots.get(ownerId)] as const]
      : [...this.#slots.entries()];
    for (const [id, slot] of slots) {
      const pending = this.#pendingBounds.get(id);
      if (!contextId || pending?.contextId === contextId) {
        this.#pendingBounds.delete(id);
      }
      if (!slot || (contextId && slot.contextId !== contextId)) continue;
      this.#slots.delete(id);
      this.options.getWindow()?.contentView.removeChildView(slot.view);
      void slot.view.webContents.session.clearStorageData().catch(() => {
        // The non-persistent session is destroyed with its owning view.
      });
      if (!slot.view.webContents.isDestroyed()) slot.view.webContents.close();
    }
  }

  #request(value: unknown): {
    ownerId: PreviewOwner;
    contextId: string;
    url: unknown;
  } {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid preview request");
    }
    const request = value as {
      ownerId?: unknown;
      contextId?: unknown;
      url?: unknown;
    };
    return {
      ownerId: previewOwner(request.ownerId),
      contextId: previewContext(request.contextId),
      url: request.url,
    };
  }

  #ownedSlot(
    ownerId: PreviewOwner,
    contextId: string,
  ): PreviewSlot | undefined {
    const slot = this.#slots.get(ownerId);
    return slot?.contextId === contextId ? slot : undefined;
  }

  #state(ownerId: PreviewOwner, contextId: string): PreviewState {
    const contents = this.#ownedSlot(ownerId, contextId)?.view.webContents;
    return {
      url: contents?.getURL() ?? "",
      loading: contents?.isLoading() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
    };
  }

  #publish(ownerId: PreviewOwner, contextId: string): void {
    const window = this.options.getWindow();
    if (
      !window
      || window.webContents.isDestroyed()
      || !this.#ownedSlot(ownerId, contextId)
    ) return;
    window.webContents.send(this.options.stateChannel, {
      ownerId,
      contextId,
      ...this.#state(ownerId, contextId),
    });
  }

  #ensure(ownerId: PreviewOwner, contextId: string): WebContentsView {
    const existing = this.#ownedSlot(ownerId, contextId);
    if (existing) return existing.view;
    if (this.#slots.has(ownerId)) this.close(ownerId);
    const window = this.options.getWindow();
    if (!window) throw new Error("The preview window is unavailable");
    const partition = createPreviewPartition();
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    view.setBackgroundColor("#17171b");
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event, url) => {
      this.#guardNavigation(event, url);
    });
    view.webContents.on("will-redirect", (event, url) => {
      this.#guardNavigation(event, url);
    });
    const ownedKeyUps = new Set<string>();
    view.webContents.on("before-input-event", (event, input) => {
      const shortcutKey = previewAppShortcutKey(input);
      const key = input.key.toLowerCase();
      const ownsKeyUp = input.type === "keyUp" && ownedKeyUps.delete(key);
      if (!shortcutKey && !ownsKeyUp) {
        if (input.type === "keyDown") ownedKeyUps.delete(key);
        return;
      }
      event.preventDefault();
      if (shortcutKey) ownedKeyUps.add(shortcutKey);
      const target = this.options.getWindow()?.webContents;
      if (!target || target.isDestroyed()) return;
      target.sendInputEvent(forwardedKeyboardInput(input));
    });
    hardenDesktopSession(view.webContents.session);
    const publish = () => this.#publish(ownerId, contextId);
    view.webContents.on("did-start-loading", publish);
    view.webContents.on("did-stop-loading", publish);
    view.webContents.on("did-navigate", publish);
    view.webContents.on("did-navigate-in-page", publish);
    window.contentView.addChildView(view);
    const slot: PreviewSlot = { view, contextId, bounds: null };
    this.#slots.set(ownerId, slot);
    const pending = this.#pendingBounds.get(ownerId);
    const bounds = pending?.contextId === contextId
      ? pending.bounds
      : undefined;
    view.setBounds(bounds ?? { x: 0, y: 0, width: 0, height: 0 });
    if (bounds) slot.bounds = bounds;
    return view;
  }

  #guardNavigation(event: { preventDefault: () => void }, url: string): void {
    try {
      if (previewNavigationTarget(url).kind !== "embed") {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  }
}
