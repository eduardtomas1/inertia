import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  WebContentsView,
  type BrowserWindow,
  type Input,
  type KeyboardInputEvent,
  type NativeImage,
  type Rectangle,
  type Session,
} from "electron";

import type { AgentBrowserActivity, AgentBrowserCommand, AgentBrowserResult, AgentBrowserState, AgentBrowserTab } from "../shared/agent-browser.js";
import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../shared/agent-browser.js";
import type { PreviewState } from "../shared/desktop.js";
import { previewNavigationTarget } from "../shared/preview-url.js";
import {
  agentPageHasSensitiveEvidence, agentPageRefHasFocus,
  installAgentPagePrivacyGuard,
  locateAgentPageRef, semanticPageSnapshot, setAgentPageInputGuard, showAgentPageCursor,
} from "./preview-agent-page.js";
import {
  agentPageActivationBlock, agentPageHasUnguardedNestedContent, beginAgentFileChooserBlock, ensureAgentFileChooserBlock, hoverAgentPageRef, releaseAgentFileChooserBlock, setAgentPageFrozen, settleAgentPageDebuggerBootstrap, settleAgentPageInput,
} from "./preview-agent-input.js";
import { capturedAgentScreenshotResult } from "./preview-agent-screenshot.js";
import { failedAgentBrowserResult as failure, successfulAgentBrowserResult } from "./preview-agent-result.js";
type PreviewOwner = "primary" | "secondary";

interface PreviewTab {
  id: string;
  view: WebContentsView;
}

interface PreviewSlot {
  contextId: string;
  partition: string;
  tabs: Map<string, PreviewTab>;
  activeTabId: string;
  bounds: Rectangle | null;
  boundsGeneration: number;
  activity: AgentBrowserActivity | null;
  agentQueue: Promise<void>;
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
const MAX_BROWSER_TABS = 8;
const PREVIEW_RENDERER_OPERATION_TIMEOUT_MS = 15_000;
const PREVIEW_NAVIGATION_COMMAND_TIMEOUT_MS = 30_000;

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

function previewTabId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Invalid preview tab");
  }
  return value;
}

class AgentBrowserRefusal extends Error {
  constructor(readonly result: AgentBrowserResult) {
    super(result.ok ? "The Browser action was refused." : result.message);
  }
}

function changedGeometry(): AgentBrowserResult {
  return failure(
    "not-found",
    "The Browser page layout changed during this action. Inspect the page again for current refs.",
  );
}

function sameBounds(left: Rectangle | null, right: Rectangle): boolean {
  return left !== null
    && left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function providerVisiblePageUrl(value: string): string {
  try {
    return new URL("/", value).origin;
  } catch {
    return "";
  }
}

function stopForAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("browser-action-cancelled");
}

export class PreviewBroker {
  readonly #slots = new Map<PreviewOwner, PreviewSlot>();
  readonly #pendingBounds = new Map<PreviewOwner, {
    contextId: string;
    bounds: Rectangle;
  }>();
  readonly #captureLocked = new WeakSet<PreviewTab["view"]["webContents"]>();

  constructor(private readonly options: PreviewBrokerOptions) {}

  async navigate(value: unknown): Promise<PreviewState> {
    const request = this.#request(value);
    const target = previewNavigationTarget(request.url);
    if (target.kind === "external") {
      await this.options.openExternal(target.url.toString());
      return this.#state(request.ownerId, request.contextId);
    }
    const slot = this.#ensure(request.ownerId, request.contextId);
    return await this.#serializeSlotAction(slot, async () => {
      if (this.#ownedSlot(request.ownerId, request.contextId) !== slot) {
        return this.#state(request.ownerId, request.contextId);
      }
      const contents = this.#active(slot).view.webContents;
      await this.#loadURL(contents, target.url.toString());
      return this.#state(request.ownerId, request.contextId);
    });
  }

  async command(value: unknown): Promise<PreviewState> {
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
    const slot = this.#ownedSlot(ownerId, contextId);
    const action = request.action;
    if (
      !slot
      || (action !== "back" && action !== "forward" && action !== "reload")
    ) return this.#state(ownerId, contextId);
    return await this.#serializeSlotAction(slot, async () => {
      if (this.#ownedSlot(ownerId, contextId) !== slot) {
        return this.#state(ownerId, contextId);
      }
      const contents = this.#active(slot).view.webContents;
      if (action === "back" && contents.navigationHistory.canGoBack()) {
        const targetUrl = contents.navigationHistory.getEntryAtIndex(
          contents.navigationHistory.getActiveIndex() - 1,
        )?.url;
        await this.#waitForNavigationCommand(
          contents,
          () => contents.navigationHistory.goBack(),
          targetUrl,
        );
      } else if (
        action === "forward"
        && contents.navigationHistory.canGoForward()
      ) {
        const targetUrl = contents.navigationHistory.getEntryAtIndex(
          contents.navigationHistory.getActiveIndex() + 1,
        )?.url;
        await this.#waitForNavigationCommand(
          contents,
          () => contents.navigationHistory.goForward(),
          targetUrl,
        );
      } else if (action === "reload") {
        await this.#waitForNavigationCommand(contents, () => contents.reload());
      }
      return this.#state(ownerId, contextId);
    });
  }

  async tab(value: unknown): Promise<PreviewState> {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid preview tab request");
    }
    const request = value as {
      ownerId?: unknown;
      contextId?: unknown;
      action?: unknown;
      tabId?: unknown;
      url?: unknown;
    };
    const ownerId = previewOwner(request.ownerId);
    const contextId = previewContext(request.contextId);
    const slot = this.#ensure(ownerId, contextId);
    return await this.#serializeSlotAction(slot, async () => {
      if (this.#ownedSlot(ownerId, contextId) !== slot) {
        return this.#state(ownerId, contextId);
      }
      if (request.action === "open") {
        const target = request.url === undefined
          ? null
          : previewNavigationTarget(request.url);
        if (target?.kind === "external") {
          throw new Error("Only local development pages can open in Inertia Browser tabs.");
        }
        const tab = this.#openTab(ownerId, slot);
        this.#activateTab(ownerId, slot, tab.id);
        if (target?.kind === "embed") {
          try {
            await this.#loadURL(tab.view.webContents, target.url.toString());
          } catch (error) {
            this.#closeTab(ownerId, slot, tab.id);
            throw error;
          }
        }
      } else if (request.action === "activate") {
        this.#activateTab(ownerId, slot, previewTabId(request.tabId));
      } else if (request.action === "close") {
        this.#closeTab(ownerId, slot, previewTabId(request.tabId));
      } else {
        throw new Error("Invalid preview tab action");
      }
      this.#publish(ownerId, contextId);
      return this.#state(ownerId, contextId);
    });
  }

  async perform(
    conversationId: string,
    command: AgentBrowserCommand,
    signal?: AbortSignal,
  ): Promise<AgentBrowserResult> {
    try {
      const contextId = previewContext(conversationId);
      const owned = this.#slotForContext(contextId);
      if (!owned) {
        return failure(
          "unavailable",
          "Open this chat's Preview once before asking the agent to use Inertia Browser.",
        );
      }
      const [ownerId, slot] = owned;
      return await this.#serializeSlotAction(slot, async () => {
        if (this.#ownedSlot(ownerId, contextId) !== slot) {
          return failure("unavailable", "This chat's Inertia Browser was closed.");
        }
        stopForAbort(signal);
        switch (command.action) {
          case "snapshot":
            return await this.#snapshot(ownerId, slot, signal);
          case "screenshot":
            return await this.#screenshot(ownerId, slot, signal);
          case "navigate":
            return await this.#agentNavigate(ownerId, slot, command.url, signal);
          case "click":
            return await this.#click(ownerId, slot, command.ref, signal);
          case "type":
            return await this.#type(ownerId, slot, command.ref, command.text, command.replace, signal);
          case "press":
            return await this.#press(ownerId, slot, command.key, signal);
          case "scroll":
            return await this.#scroll(ownerId, slot, command.deltaY, signal);
          case "tabs":
            return successfulAgentBrowserResult(this.#agentStateText(slot), this.#agentState(slot));
          case "tab-open":
            return await this.#agentOpenTab(ownerId, slot, command.url, signal);
          case "tab-activate":
            if (!slot.tabs.has(command.tabId)) {
              return failure("not-found", "That Inertia Browser tab no longer exists.");
            }
            this.#activateTab(ownerId, slot, command.tabId);
            this.#record(ownerId, slot, "tab-activate", "Agent switched pages");
            return successfulAgentBrowserResult(this.#agentStateText(slot), this.#agentState(slot));
          case "tab-close":
            if (!slot.tabs.has(command.tabId)) {
              return failure("not-found", "That Inertia Browser tab no longer exists.");
            }
            this.#closeTab(ownerId, slot, command.tabId);
            this.#record(
              ownerId,
              slot,
              "tab-close",
              "Agent closed a page",
              undefined,
              command.tabId,
            );
            return successfulAgentBrowserResult(this.#agentStateText(slot), this.#agentState(slot));
        }
      });
    } catch (error) {
      return error instanceof Error && error.message === "browser-action-cancelled"
        ? failure("cancelled", "The browser action was cancelled.")
        : failure(
            "unavailable",
            error instanceof Error
              ? error.message.slice(0, 1_000)
              : "The Inertia Browser action failed.",
          );
    }
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
        const bounds = {
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        };
        if (!sameBounds(slot.bounds, bounds)) slot.boundsGeneration += 1;
        slot.bounds = bounds;
        this.#active(slot).view.setBounds(slot.bounds);
      }
      return;
    }
    if (!request.bounds || typeof request.bounds !== "object") {
      throw new Error("Invalid preview bounds");
    }
    const candidate = request.bounds as Partial<Rectangle>;
    if (![
      candidate.x,
      candidate.y,
      candidate.width,
      candidate.height,
    ].every((entry) => Number.isInteger(entry))) {
      throw new Error("Invalid preview bounds");
    }
    const content = this.options.getWindow()?.getContentBounds();
    if (!content) return;
    const x = Math.max(0, Math.min(candidate.x as number, content.width));
    const y = Math.max(0, Math.min(candidate.y as number, content.height));
    const bounds = {
      x,
      y,
      width: Math.max(0, Math.min(candidate.width as number, content.width - x)),
      height: Math.max(0, Math.min(candidate.height as number, content.height - y)),
    };
    this.#pendingBounds.set(ownerId, { contextId, bounds });
    const slot = this.#ownedSlot(ownerId, contextId);
    if (slot) {
      if (!sameBounds(slot.bounds, bounds)) slot.boundsGeneration += 1;
      slot.bounds = bounds;
      this.#active(slot).view.setBounds(bounds);
    }
  }

  closeRequest(value: unknown): void {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid preview request");
    }
    const request = value as { ownerId?: unknown; contextId?: unknown };
    this.close(previewOwner(request.ownerId), previewContext(request.contextId));
  }

  close(ownerId?: PreviewOwner, contextId?: string): void {
    const slots = ownerId
      ? [[ownerId, this.#slots.get(ownerId)] as const]
      : [...this.#slots.entries()];
    for (const [id, slot] of slots) {
      const pending = this.#pendingBounds.get(id);
      if (!contextId || pending?.contextId === contextId) this.#pendingBounds.delete(id);
      if (!slot || (contextId && slot.contextId !== contextId)) continue;
      this.#slots.delete(id);
      const browserSession = slot.tabs.values().next().value
        ?.view.webContents.session;
      for (const tab of slot.tabs.values()) this.#destroyTab(tab);
      void browserSession?.clearStorageData().catch(() => {
        // The non-persistent session is destroyed with its owning slot.
      });
    }
  }

  async #serializeSlotAction<Result>(
    slot: PreviewSlot,
    action: () => Result | Promise<Result>,
  ): Promise<Result> {
    const previous = slot.agentQueue;
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    slot.agentQueue = previous.then(() => current);
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async #rendererOperation<Result>(
    contents: PreviewTab["view"]["webContents"],
    operation: () => Promise<Result>,
    options: {
      signal?: AbortSignal;
      cancel?: () => void;
      lateSuccess?: (value: Result) => void;
      timeoutMessage?: string;
    } = {},
  ): Promise<Result> {
    stopForAbort(options.signal);
    if (contents.isDestroyed()) {
      throw new Error("The active Browser tab was closed before the operation started.");
    }
    return await new Promise<Result>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        contents.removeListener("destroyed", onDestroyed);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const succeed = (value: Result): void => {
        if (settled) { options.lateSuccess?.(value); return; }
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = (error: Error, cancel = false): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (cancel) {
          try {
            options.cancel?.();
          } catch {
            // Cancellation is best-effort; the bounded queue release is authoritative.
          }
        }
        reject(error);
      };
      const onAbort = (): void => fail(new Error("browser-action-cancelled"), true);
      const onDestroyed = (): void => fail(
        new Error("The active Browser tab was closed during the operation."),
      );
      const timeout = setTimeout(() => fail(
        new Error(options.timeoutMessage ?? "The Browser page stopped responding."),
        true,
      ), PREVIEW_RENDERER_OPERATION_TIMEOUT_MS);
      timeout.unref();
      contents.once("destroyed", onDestroyed);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(operation).then(succeed, (error: unknown) => fail(
        error instanceof Error ? error : new Error("The Browser renderer operation failed."),
      ));
    });
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

  #ownedSlot(ownerId: PreviewOwner, contextId: string): PreviewSlot | undefined {
    const slot = this.#slots.get(ownerId);
    return slot?.contextId === contextId ? slot : undefined;
  }

  #slotForContext(contextId: string): [PreviewOwner, PreviewSlot] | undefined {
    return [...this.#slots.entries()].find(([, slot]) => slot.contextId === contextId);
  }

  #active(slot: PreviewSlot): PreviewTab {
    const tab = slot.tabs.get(slot.activeTabId);
    if (!tab) throw new Error("The active Inertia Browser tab is unavailable.");
    return tab;
  }

  #previewTab(tab: PreviewTab): AgentBrowserTab {
    const contents = tab.view.webContents;
    return {
      id: tab.id,
      title: contents.getTitle().slice(0, 300),
      url: contents.getURL().slice(0, 4_096),
      loading: contents.isLoading(),
    };
  }

  #agentTab(tab: PreviewTab): AgentBrowserTab {
    const contents = tab.view.webContents;
    return {
      id: tab.id,
      title: "Local page",
      url: providerVisiblePageUrl(contents.getURL()),
      loading: contents.isLoading(),
    };
  }

  #state(ownerId: PreviewOwner, contextId: string): PreviewState {
    const slot = this.#ownedSlot(ownerId, contextId);
    const contents = slot ? this.#active(slot).view.webContents : undefined;
    return {
      url: contents?.getURL() ?? "",
      loading: contents?.isLoading() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      activeTabId: slot?.activeTabId ?? null,
      tabs: slot ? [...slot.tabs.values()].map((tab) => this.#previewTab(tab)) : [],
      agentActivity: slot?.activity ?? null,
    };
  }

  #agentState(slot: PreviewSlot): AgentBrowserState {
    return {
      activeTabId: slot.activeTabId,
      tabs: [...slot.tabs.values()].map((tab) => this.#agentTab(tab)),
      activity: slot.activity,
    };
  }

  #agentStateText(
    slot: PreviewSlot,
    detail?: Record<string, unknown>,
  ): string {
    const state = this.#agentState(slot);
    const payload = detail ? { ...detail, state } : state;
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") <= MAX_AGENT_BROWSER_TEXT_BYTES) {
      return serialized;
    }
    const compactState = {
      ...state,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        title: tab.title.slice(0, 120),
        url: tab.url.slice(0, 1_024),
      })),
      activity: state.activity
        ? { ...state.activity, label: state.activity.label.slice(0, 160) }
        : null,
    };
    return JSON.stringify(detail
      ? { ...detail, state: compactState, truncated: true }
      : { ...compactState, truncated: true });
  }

  #publish(ownerId: PreviewOwner, contextId: string): void {
    const window = this.options.getWindow();
    if (!window || window.webContents.isDestroyed() || !this.#ownedSlot(ownerId, contextId)) return;
    window.webContents.send(this.options.stateChannel, {
      ownerId,
      contextId,
      ...this.#state(ownerId, contextId),
    });
  }

  #ensure(ownerId: PreviewOwner, contextId: string): PreviewSlot {
    const existing = this.#ownedSlot(ownerId, contextId);
    if (existing) return existing;
    if (this.#slots.has(ownerId)) this.close(ownerId);
    const slot: PreviewSlot = {
      contextId,
      partition: createPreviewPartition(),
      tabs: new Map(),
      activeTabId: "",
      bounds: null,
      boundsGeneration: 0,
      activity: null,
      agentQueue: Promise.resolve(),
    };
    const tab = this.#openTab(ownerId, slot);
    slot.activeTabId = tab.id;
    this.#slots.set(ownerId, slot);
    const pending = this.#pendingBounds.get(ownerId);
    const bounds = pending?.contextId === contextId ? pending.bounds : undefined;
    tab.view.setBounds(bounds ?? { x: 0, y: 0, width: 0, height: 0 });
    if (bounds) slot.bounds = bounds;
    this.options.getWindow()?.contentView.addChildView(tab.view);
    return slot;
  }

  #openTab(ownerId: PreviewOwner, slot: PreviewSlot): PreviewTab {
    if (slot.tabs.size >= MAX_BROWSER_TABS) {
      throw new Error("Inertia Browser allows at most eight tabs per chat.");
    }
    const window = this.options.getWindow();
    if (!window) throw new Error("The preview window is unavailable");
    const tab: PreviewTab = {
      id: randomUUID(),
      view: new WebContentsView({
        webPreferences: {
          partition: slot.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          devTools: false,
          disableDialogs: true,
          navigateOnDragDrop: false,
          preload: fileURLToPath(new URL(
            "../preload/preview-agent-privacy.cjs",
            import.meta.url,
          )),
        },
      }),
    };
    const contents = tab.view.webContents;
    tab.view.setBackgroundColor("#17171b");
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => this.#guardNavigation(event, url));
    contents.on("will-redirect", (event, url) => this.#guardNavigation(event, url));
    const ownedKeyUps = new Set<string>();
    contents.on("before-input-event", (event, input) => {
      if (this.#captureLocked.has(contents)) {
        event.preventDefault();
        return;
      }
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
    contents.on("before-mouse-event", (event) => {
      if (this.#captureLocked.has(contents)) event.preventDefault();
    });
    hardenDesktopSession(contents.session);
    const publish = () => this.#publish(ownerId, slot.contextId);
    contents.on("did-start-loading", publish);
    contents.on("did-stop-loading", publish);
    contents.on("did-navigate", publish);
    contents.on("did-navigate-in-page", publish);
    contents.on("page-title-updated", publish);
    slot.tabs.set(tab.id, tab);
    return tab;
  }

  #activateTab(ownerId: PreviewOwner, slot: PreviewSlot, tabId: string): void {
    const next = slot.tabs.get(tabId);
    if (!next) throw new Error("That Inertia Browser tab no longer exists.");
    const window = this.options.getWindow();
    if (!window) throw new Error("The preview window is unavailable");
    const previous = slot.tabs.get(slot.activeTabId);
    if (previous && previous !== next) {
      window.contentView.removeChildView(previous.view);
      previous.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    slot.activeTabId = tabId;
    window.contentView.addChildView(next.view);
    next.view.setBounds(slot.bounds ?? { x: 0, y: 0, width: 0, height: 0 });
  }

  #closeTab(ownerId: PreviewOwner, slot: PreviewSlot, tabId: string): void {
    const tab = slot.tabs.get(tabId);
    if (!tab) throw new Error("That Inertia Browser tab no longer exists.");
    const wasActive = slot.activeTabId === tabId;
    slot.tabs.delete(tabId);
    this.#destroyTab(tab);
    if (slot.tabs.size === 0) {
      const replacement = this.#openTab(ownerId, slot);
      slot.activeTabId = replacement.id;
    } else if (wasActive) {
      slot.activeTabId = slot.tabs.keys().next().value as string;
    }
    this.#activateTab(ownerId, slot, slot.activeTabId);
  }

  #destroyTab(tab: PreviewTab): void {
    this.options.getWindow()?.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  #record(
    ownerId: PreviewOwner,
    slot: PreviewSlot,
    action: AgentBrowserActivity["action"],
    label: string,
    point?: { x: number; y: number },
    tabId = slot.activeTabId,
  ): void {
    slot.activity = {
      action,
      label,
      tabId,
      at: new Date().toISOString(),
      ...point,
    };
    this.#publish(ownerId, slot.contextId);
  }

  async #snapshot(ownerId: PreviewOwner, slot: PreviewSlot, signal?: AbortSignal): Promise<AgentBrowserResult> {
    const tab = this.#active(slot);
    const tabId = tab.id;
    const contents = tab.view.webContents;
    if (!contents.getURL()) return failure("not-found", "The active Browser tab has no page.");
    await this.#prepareAgentPage(contents, signal);
    this.#captureLocked.add(contents);
    let text = "";
    let capturedState: AgentBrowserState | null = null;
    try {
      await this.#rendererOperation(contents, () => setAgentPageFrozen(contents, true), { signal });
      if (await this.#rendererOperation(contents, () => agentPageHasSensitiveEvidence(contents), { signal })) {
        return failure("invalid", "Page evidence is unavailable until the password-bearing document navigates away.");
      }
      if (await this.#rendererOperation(contents, () => agentPageHasUnguardedNestedContent(contents), { signal })) {
        return failure("invalid", "Page evidence is unavailable for nested page content.");
      }
      text = await this.#rendererOperation(contents, () => semanticPageSnapshot(contents), {
        signal,
      });
      if (await this.#rendererOperation(contents, () => agentPageHasSensitiveEvidence(contents), { signal })) return failure("invalid", "Page evidence is unavailable until the password-bearing document navigates away.");
      if (await this.#rendererOperation(contents, () => agentPageHasUnguardedNestedContent(contents), { signal })) return failure("invalid", "Page evidence is unavailable for nested page content.");
      stopForAbort(signal);
      this.#record(ownerId, slot, "snapshot", "Agent inspected this page");
      capturedState = this.#agentState(slot);
    } finally {
      try {
        if (!contents.isDestroyed()) {
          await this.#rendererOperation(
            contents,
            () => setAgentPageFrozen(contents, false),
          );
        }
      } finally {
        this.#captureLocked.delete(contents);
      }
    }
    stopForAbort(signal);
    if (!capturedState) {
      return failure("unavailable", "The Browser snapshot state could not be captured.");
    }
    if (slot.tabs.get(tabId) !== tab || contents.isDestroyed()) {
      return failure("not-found", "The Browser tab was closed before its snapshot completed.");
    }
    return successfulAgentBrowserResult(text, capturedState);
  }

  async #screenshot(ownerId: PreviewOwner, slot: PreviewSlot, signal?: AbortSignal): Promise<AgentBrowserResult> {
    const tab = this.#active(slot);
    const tabId = tab.id;
    const contents = tab.view.webContents;
    if (!contents.getURL()) return failure("not-found", "The active Browser tab has no page.");
    await this.#prepareAgentPage(contents, signal);
    this.#captureLocked.add(contents);
    let image: NativeImage;
    let capturedUrl = "";
    let capturedState: AgentBrowserState | null = null;
    try {
      await this.#rendererOperation(contents, () => setAgentPageFrozen(contents, true), { signal });
      if (await this.#rendererOperation(contents, () => agentPageHasSensitiveEvidence(contents), { signal })) {
        return failure("invalid", "Screenshots are unavailable until the password-bearing document navigates away.");
      }
      if (await this.#rendererOperation(contents, () => agentPageHasUnguardedNestedContent(contents), { signal })) {
        return failure("invalid", "Screenshots are unavailable for nested page content.");
      }
      image = await this.#rendererOperation(contents, () => contents.capturePage(), { signal });
      if (await this.#rendererOperation(contents, () => agentPageHasSensitiveEvidence(contents), { signal })) {
        return failure("invalid", "Screenshots are unavailable until the password-bearing document navigates away.");
      }
      if (await this.#rendererOperation(contents, () => agentPageHasUnguardedNestedContent(contents), { signal })) {
        return failure("invalid", "Screenshots are unavailable for nested page content.");
      }
      capturedUrl = contents.getURL();
      capturedState = this.#agentState(slot);
    } finally {
      try {
        if (!contents.isDestroyed()) {
          await this.#rendererOperation(
            contents,
            () => setAgentPageFrozen(contents, false),
          );
        }
      } finally {
        this.#captureLocked.delete(contents);
      }
    }
    stopForAbort(signal);
    if (!capturedState) {
      return failure("unavailable", "The Browser screenshot state could not be captured.");
    }
    if (slot.tabs.get(tabId) !== tab || contents.isDestroyed()) {
      return failure("not-found", "The captured Browser tab was closed before its screenshot completed.");
    }
    const result = capturedAgentScreenshotResult(
      image, tabId, providerVisiblePageUrl(capturedUrl), capturedState,
    );
    if (!result.ok) return result;
    this.#record(ownerId, slot, "screenshot", "Agent captured this page", undefined, tabId);
    return { ...result, state: { ...result.state, activity: slot.activity } };
  }

  async #agentNavigate(
    ownerId: PreviewOwner,
    slot: PreviewSlot,
    url: string,
    signal?: AbortSignal,
  ): Promise<AgentBrowserResult> {
    const target = previewNavigationTarget(url);
    if (target.kind !== "embed") {
      return failure("invalid", "Only local development URLs can open inside Inertia Browser.");
    }
    const contents = this.#active(slot).view.webContents;
    await this.#loadURL(contents, target.url.toString(), signal);
    stopForAbort(signal);
    this.#record(ownerId, slot, "navigate", `Agent opened ${target.url.host}`);
    return successfulAgentBrowserResult(this.#agentStateText(slot), this.#agentState(slot));
  }

  async #agentOpenTab(
    ownerId: PreviewOwner,
    slot: PreviewSlot,
    url: string | undefined,
    signal?: AbortSignal,
  ): Promise<AgentBrowserResult> {
    if (slot.tabs.size >= MAX_BROWSER_TABS) {
      return failure("too-large", "Inertia Browser allows at most eight tabs per chat.");
    }
    const target = url ? previewNavigationTarget(url) : null;
    if (target?.kind === "external") {
      return failure("invalid", "Only local development URLs can open inside Inertia Browser.");
    }
    stopForAbort(signal);
    const tab = this.#openTab(ownerId, slot);
    this.#activateTab(ownerId, slot, tab.id);
    if (target?.kind === "embed") {
      try {
        await this.#loadURL(tab.view.webContents, target.url.toString(), signal);
      } catch (error) {
        this.#closeTab(ownerId, slot, tab.id);
        throw error;
      }
    }
    stopForAbort(signal);
    this.#record(ownerId, slot, "tab-open", "Agent opened a new page");
    return successfulAgentBrowserResult(this.#agentStateText(slot), this.#agentState(slot));
  }

  async #click(ownerId: PreviewOwner, slot: PreviewSlot, ref: string, signal?: AbortSignal): Promise<AgentBrowserResult> {
    const contents = this.#active(slot).view.webContents;
    await this.#prepareAgentPage(contents, signal);
    const boundsGeneration = slot.boundsGeneration;
    const located = await this.#rendererOperation(
      contents,
      () => locateAgentPageRef(contents, ref),
      { signal },
    );
    if (slot.boundsGeneration !== boundsGeneration) return changedGeometry();
    let x = located.x;
    let y = located.y;
    if (!located.found || x === undefined || y === undefined) {
      return failure("not-found", "That page element is stale. Inspect the page again for current refs.");
    }
    if (located.blocked) return failure("invalid", "That page element cannot be controlled by the Browser agent.");
    if (located.disabled) return failure("invalid", "That page element is disabled.");
    const cursorX = x;
    const cursorY = y;
    stopForAbort(signal);
    await this.#rendererOperation(
      contents,
      () => showAgentPageCursor(contents, cursorX, cursorY, `Agent · ${located.label || ref}`),
      { signal },
    );
    if (slot.boundsGeneration !== boundsGeneration) return changedGeometry();
    const revalidated = await this.#rendererOperation(
      contents,
      () => locateAgentPageRef(contents, ref),
      { signal },
    );
    if (slot.boundsGeneration !== boundsGeneration) return changedGeometry();
    x = revalidated.x;
    y = revalidated.y;
    if (!revalidated.found || x === undefined || y === undefined) {
      return failure("not-found", "That page element changed before the click. Inspect the page again for current refs.");
    }
    if (revalidated.blocked) return failure("invalid", "That page element cannot be controlled by the Browser agent.");
    if (revalidated.disabled) return failure("invalid", "That page element is disabled.");
    stopForAbort(signal);
    try {
      await this.#sendInputAndWait(contents, async () => {
        const finalTarget = await this.#rendererOperation(
          contents,
          () => hoverAgentPageRef(contents, ref, x!, y!, signal),
          { signal },
        );
        if (slot.boundsGeneration !== boundsGeneration) {
          throw new AgentBrowserRefusal(changedGeometry());
        }
        x = finalTarget.x;
        y = finalTarget.y;
        if (!finalTarget.found || x === undefined || y === undefined) {
          throw new AgentBrowserRefusal(failure(
            "not-found",
            "That page element changed before the click. Inspect the page again for current refs.",
          ));
        }
        if (finalTarget.blocked) throw new AgentBrowserRefusal(failure(
          "invalid", "That page element cannot be controlled by the Browser agent.",
        ));
        if (finalTarget.disabled) throw new AgentBrowserRefusal(failure(
          "invalid", "That page element is disabled.",
        ));
        contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      }, signal);
    } catch (error) {
      if (error instanceof AgentBrowserRefusal) return error.result;
      throw error;
    }
    this.#record(ownerId, slot, "click", `Agent clicked ${located.label || ref}`, { x, y });
    return successfulAgentBrowserResult(
      this.#agentStateText(slot, { clicked: ref }),
      this.#agentState(slot),
    );
  }

  async #type(
    ownerId: PreviewOwner,
    slot: PreviewSlot,
    ref: string,
    text: string,
    replace: boolean,
    signal?: AbortSignal,
  ): Promise<AgentBrowserResult> {
    const contents = this.#active(slot).view.webContents;
    await this.#prepareAgentPage(contents, signal);
    const boundsGeneration = slot.boundsGeneration;
    const located = await this.#rendererOperation(
      contents,
      () => locateAgentPageRef(contents, ref),
      { signal },
    );
    if (slot.boundsGeneration !== boundsGeneration) return changedGeometry();
    let x = located.x;
    let y = located.y;
    if (!located.found || x === undefined || y === undefined) {
      return failure("not-found", "That page element is stale. Inspect the page again for current refs.");
    }
    if (located.blocked) return failure("invalid", "That page element cannot be controlled by the Browser agent.");
    if (located.disabled) return failure("invalid", "That page element is disabled.");
    if (!located.editable) return failure("invalid", "That page element does not accept text input.");
    const cursorX = x;
    const cursorY = y;
    stopForAbort(signal);
    await this.#rendererOperation(
      contents,
      () => showAgentPageCursor(contents, cursorX, cursorY, `Agent typing · ${located.label || ref}`),
      { signal },
    );
    if (slot.boundsGeneration !== boundsGeneration) return changedGeometry();
    const revalidated = await this.#rendererOperation(
      contents,
      () => locateAgentPageRef(contents, ref),
      { signal },
    );
    if (slot.boundsGeneration !== boundsGeneration) return changedGeometry();
    x = revalidated.x;
    y = revalidated.y;
    if (!revalidated.found || x === undefined || y === undefined) {
      return failure("not-found", "That page element lost focus before typing. Inspect the page again for current refs.");
    }
    if (revalidated.blocked) return failure("invalid", "That page element cannot be controlled by the Browser agent.");
    if (revalidated.disabled) return failure("invalid", "That page element is disabled.");
    if (!revalidated.editable) return failure("invalid", "That page element does not accept text input.");
    stopForAbort(signal);
    try {
      await this.#sendInputAndWait(contents, async () => {
        const finalTarget = await this.#rendererOperation(
          contents,
          () => locateAgentPageRef(contents, ref, true, replace),
          { signal },
        );
        if (slot.boundsGeneration !== boundsGeneration) {
          throw new AgentBrowserRefusal(changedGeometry());
        }
        x = finalTarget.x;
        y = finalTarget.y;
        if (!finalTarget.found || x === undefined || y === undefined) {
          throw new AgentBrowserRefusal(failure(
            "not-found",
            "That page element lost focus before typing. Inspect the page again for current refs.",
          ));
        }
        if (finalTarget.blocked) throw new AgentBrowserRefusal(failure(
          "invalid", "That page element cannot be controlled by the Browser agent.",
        ));
        if (finalTarget.disabled) throw new AgentBrowserRefusal(failure(
          "invalid", "That page element is disabled.",
        ));
        if (!finalTarget.editable) throw new AgentBrowserRefusal(failure(
          "invalid", "That page element does not accept text input.",
        ));
        const stillFocused = await this.#rendererOperation(
          contents,
          () => agentPageRefHasFocus(contents, ref),
          { signal },
        );
        if (!stillFocused) throw new AgentBrowserRefusal(failure(
          "not-found",
          "That page element lost focus before typing. Inspect the page again for current refs.",
        ));
        await contents.insertText(text);
      }, signal);
    } catch (error) {
      if (error instanceof AgentBrowserRefusal) return error.result;
      throw error;
    }
    stopForAbort(signal);
    this.#record(ownerId, slot, "type", `Agent typed in ${located.label || ref}`, { x, y });
    return successfulAgentBrowserResult(
      JSON.stringify({ typed: ref, characters: text.length }),
      this.#agentState(slot),
    );
  }

  async #press(ownerId: PreviewOwner, slot: PreviewSlot, key: string, signal?: AbortSignal): Promise<AgentBrowserResult> {
    stopForAbort(signal);
    const contents = this.#active(slot).view.webContents;
    await this.#prepareAgentPage(contents, signal);
    const keyCode = key === "Space" ? " " : key;
    let activationBlocked: "disabled" | "file" | "nested" | null = null;
    await this.#sendInputAndWait(contents, async () => {
      if (key === "Enter" || key === "Space") {
        activationBlocked = await this.#rendererOperation(contents,
          () => agentPageActivationBlock(contents), { signal });
        if (activationBlocked) return;
      }
      contents.sendInputEvent({ type: "keyDown", keyCode });
      if (key === "Enter" || key === "Space") {
        contents.sendInputEvent({ type: "char", keyCode: key === "Enter" ? "\r" : " " });
      }
      contents.sendInputEvent({ type: "keyUp", keyCode });
    }, signal);
    if (activationBlocked) {
      return failure("invalid", activationBlocked === "file" ? "File inputs cannot be activated by the Browser agent."
        : activationBlocked === "disabled" ? "The focused page element is disabled." : "Activation keys are unavailable for nested page content.");
    }
    this.#record(ownerId, slot, "press", `Agent pressed ${key}`);
    return successfulAgentBrowserResult(JSON.stringify({ pressed: key }), this.#agentState(slot));
  }

  async #scroll(ownerId: PreviewOwner, slot: PreviewSlot, deltaY: number, signal?: AbortSignal): Promise<AgentBrowserResult> {
    stopForAbort(signal);
    const contents = this.#active(slot).view.webContents;
    await this.#prepareAgentPage(contents, signal);
    const bounds = slot.bounds ?? { width: 800, height: 600 };
    await this.#sendInputAndWait(contents, () => contents.sendInputEvent({
      type: "mouseWheel",
      x: Math.max(0, Math.floor(bounds.width / 2)),
      y: Math.max(0, Math.floor(bounds.height / 2)),
      deltaX: 0,
      deltaY,
    }), signal);
    this.#record(ownerId, slot, "scroll", `Agent scrolled ${deltaY > 0 ? "down" : "up"}`);
    return successfulAgentBrowserResult(JSON.stringify({ scrolled: deltaY }), this.#agentState(slot));
  }

  #guardNavigation(event: { preventDefault: () => void }, url: string): void {
    try {
      if (previewNavigationTarget(url).kind !== "embed") event.preventDefault();
    } catch {
      event.preventDefault();
    }
  }
  async #loadURL(
    contents: PreviewTab["view"]["webContents"],
    url: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#rendererOperation(contents, () => ensureAgentFileChooserBlock(contents), { signal });
    await this.#rendererOperation(
      contents,
      async () => { await contents.loadURL(url); settleAgentPageDebuggerBootstrap(contents); },
      {
        signal,
        cancel: () => contents.stop(),
        timeoutMessage: "The Browser page did not finish loading.",
      },
    );
  }

  async #prepareAgentPage(
    contents: PreviewTab["view"]["webContents"],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#rendererOperation(
      contents,
      () => ensureAgentFileChooserBlock(contents),
      { signal },
    );
    await this.#rendererOperation(
      contents,
      () => installAgentPagePrivacyGuard(contents),
      { signal },
    );
  }

  async #waitForNavigationCommand(
    contents: PreviewTab["view"]["webContents"],
    dispatch: () => void,
    inPageTargetUrl?: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        contents.removeListener("did-stop-loading", onStopped);
        contents.removeListener("did-navigate-in-page", onInPage);
        contents.removeListener("destroyed", onDestroyed);
        if (error) reject(error);
        else resolve();
      };
      const onStopped = (): void => finish();
      const onInPage = (
        _event: unknown,
        url: string,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame && inPageTargetUrl && url === inPageTargetUrl) finish();
      };
      const onDestroyed = (): void => finish(
        new Error("The active Browser tab was closed during navigation."),
      );
      const timeout = setTimeout(() => {
        finish(new Error("The Browser navigation command timed out."));
        if (!contents.isDestroyed()) contents.stop();
      }, PREVIEW_NAVIGATION_COMMAND_TIMEOUT_MS);
      contents.once("did-stop-loading", onStopped);
      if (inPageTargetUrl) contents.on("did-navigate-in-page", onInPage);
      contents.once("destroyed", onDestroyed);
      try {
        if (contents.isDestroyed()) {
          finish(new Error("The active Browser tab was closed before navigation."));
          return;
        }
        dispatch();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("The Browser navigation command failed."));
      }
    });
  }

  async #sendInputAndWait(
    contents: PreviewTab["view"]["webContents"],
    dispatch: () => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    stopForAbort(signal);
    const chooserGeneration = await this.#rendererOperation(
      contents,
      () => beginAgentFileChooserBlock(contents),
      { signal, lateSuccess: (generation) => { void releaseAgentFileChooserBlock(contents, generation).catch(() => undefined); } },
    );
    try {
      await this.#rendererOperation(
        contents,
        () => setAgentPageInputGuard(contents, true),
        { signal },
      );
      await settleAgentPageInput(contents, dispatch, signal);
    } finally {
      if (!contents.isDestroyed()) {
        await this.#rendererOperation(
          contents,
          () => setAgentPageInputGuard(contents, false),
        ).catch(() => undefined);
        void releaseAgentFileChooserBlock(contents, chooserGeneration).catch(() => undefined);
      }
    }
  }
}
