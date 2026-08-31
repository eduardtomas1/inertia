import type { BrowserWindow, NativeImage, Rectangle, WebContents } from "electron";

import type {
  AgentBrowserActivity,
  AgentBrowserCommand,
  AgentBrowserResult,
  AgentBrowserRunIdentity,
  AgentBrowserState,
  AgentBrowserTab,
} from "../shared/agent-browser.js";
import {
  sanitizeBrowserEvidenceText,
  type BrowserEvidenceImage,
} from "../shared/browser-evidence.js";
import type { PreviewState } from "../shared/desktop.js";
import { previewNavigationTarget } from "../shared/preview-url.js";
import {
  agentPageHasSensitiveEvidence, agentPageHasSensitiveScreenshotEvidence, agentPageInputRefusal, agentPageRefHasFocus,
  installAgentPagePrivacyGuard,
  locateAgentPageRef, semanticPageSnapshot, setAgentPageInputGuard, showAgentPageCursor,
} from "./preview-agent-page.js";
import {
  agentPageActivationFailureMessage, agentPageHasUnguardedNestedContent, beginAgentFileChooserBlock, beginAgentPageInputRefusalCapture, captureAgentPageInputRefusal, capturedAgentPageInputRefusal, deliverAgentPageActivation, endAgentPageInputRefusalCapture, ensureAgentFileChooserBlock, hoverAgentPageRef, releaseAgentFileChooserBlock, setAgentPageFrozen, settleAgentPageDebuggerBootstrap, settleAgentPageInput,
} from "./preview-agent-input.js";
import { capturedAgentScreenshotResult } from "./preview-agent-screenshot.js";
import { BrowserEvidenceCapture, type BrowserEvidenceAuthority, type BrowserEvidencePage } from "./browser-evidence-capture.js";
import { BrowserEvidenceInspectorRegistry, type BrowserEvidenceImageApproval, type BrowserEvidenceImageInspection } from "./browser-evidence-image-approval.js";
import { PreviewContextRegistry } from "./preview-lifecycle.js";
import {
  agentBrowserIdentity,
  previewContext,
  previewOwner,
  previewTabId,
  type PreviewOwner,
} from "./preview-identity.js";
import { boundedAgentStateText, failedAgentBrowserResult as failure, successfulAgentBrowserResult } from "./preview-agent-result.js";
import { createPreviewPartition } from "./preview-session.js";
import { createPreviewTab, type PreviewTab } from "./preview-tab.js";
export { previewAppShortcutKey } from "./preview-keyboard.js";
export { createPreviewPartition, hardenDesktopSession } from "./preview-session.js";

interface PreviewSlot {
  contextId: string;
  partition: string;
  tabs: Map<string, PreviewTab>;
  activeTabId: string;
  bounds: Rectangle | null;
  boundsGeneration: number;
  activity: AgentBrowserActivity | null;
  agentQueue: Promise<void>;
  activeIdentity: AgentBrowserRunIdentity | null;
  evidence: BrowserEvidenceCapture; evidenceInspectors: BrowserEvidenceInspectorRegistry;
  publishedEvidenceRevision: number | null;
  nextPageNumber: number;
}

interface PreviewBrokerOptions {
  getWindow: () => BrowserWindow | null;
  openExternal: (url: string) => Promise<void>;
  stateChannel: string;
  registerHealthRenderer?(contents: WebContents): () => void;
  partitionPrefix?: string;
}
const MAX_BROWSER_TABS = 8;
const PREVIEW_RENDERER_OPERATION_TIMEOUT_MS = 15_000;
const PREVIEW_NAVIGATION_COMMAND_TIMEOUT_MS = 30_000;

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

function sameBounds(left: Rectangle | null, right: Rectangle): boolean { return left !== null && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height; }
function providerVisiblePageUrl(value: string): string { try { return new URL("/", value).origin; } catch { return ""; } }
function stopForAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("browser-action-cancelled"); }
export class PreviewBroker {
  reportInputRefusal(contents: WebContents, value: unknown): boolean { return captureAgentPageInputRefusal(contents, value); }
  readonly #slots = new Map<PreviewOwner, PreviewSlot>();
  readonly #registeredContexts = new PreviewContextRegistry();
  readonly #pendingBounds = new Map<PreviewOwner, {
    contextId: string;
    bounds: Rectangle;
  }>();
  readonly #captureLocked = new WeakSet<PreviewTab["view"]["webContents"]>();
  constructor(private readonly options: PreviewBrokerOptions) {}

  connect(value: unknown): PreviewState {
    const { ownerId, contextId, priorContextId } = this.#registeredContexts.connect(value);
    if (priorContextId && priorContextId !== contextId) this.close(ownerId, priorContextId);
    return this.#state(ownerId, contextId);
  }

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
    owner: string | AgentBrowserRunIdentity,
    command: AgentBrowserCommand,
    signal?: AbortSignal,
  ): Promise<AgentBrowserResult> {
    try {
      const { contextId, identity } = agentBrowserIdentity(owner);
      stopForAbort(signal);
      const registeredOwnerId = this.#registeredContexts.ownerFor(contextId);
      const owned = this.#slotForContext(contextId) ?? (registeredOwnerId
        ? [registeredOwnerId, this.#ensure(registeredOwnerId, contextId)]
        : undefined);
      if (!owned) {
        return failure(
          "unavailable",
          "Open this chat in the main workspace before using Inertia Browser.",
        );
      }
      const [ownerId, slot] = owned;
      return await this.#serializeSlotAction(slot, async () => {
        if (this.#ownedSlot(ownerId, contextId) !== slot) {
          return failure("unavailable", "This chat's Inertia Browser was closed.");
        }
        stopForAbort(signal);
        slot.activeIdentity = identity;
        try {
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
              return this.#success(slot, boundedAgentStateText(this.#agentState(slot)));
            case "tab-open":
              return await this.#agentOpenTab(ownerId, slot, command.url, signal);
            case "tab-activate":
              if (!slot.tabs.has(command.tabId)) {
                return failure("not-found", "That Inertia Browser tab no longer exists.");
              }
              this.#activateTab(ownerId, slot, command.tabId);
              this.#record(ownerId, slot, "tab-activate", "Agent switched pages");
              return this.#success(slot, boundedAgentStateText(this.#agentState(slot)));
            case "tab-close": {
              const closingTab = slot.tabs.get(command.tabId);
              if (!closingTab) {
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
                closingTab,
              );
              return this.#success(slot, boundedAgentStateText(this.#agentState(slot)));
            }
          }
        } finally {
          if (slot.activeIdentity === identity) slot.activeIdentity = null;
        }
      });
    } catch (error) {
      return error instanceof Error && error.message === "browser-action-cancelled"
        ? failure("cancelled", "The browser action was cancelled.")
        : failure(
            "unavailable",
            error instanceof Error
              ? sanitizeBrowserEvidenceText(
                  error.message,
                  "The Inertia Browser action failed.",
                  600,
                ).text
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
    const slot = this.#ownedSlot(ownerId, contextId)
      ?? this.#ensure(ownerId, contextId);
    if (!sameBounds(slot.bounds, bounds)) slot.boundsGeneration += 1;
    slot.bounds = bounds;
    this.#active(slot).view.setBounds(bounds);
  }

  closeRequest(value: unknown): void {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid preview request");
    }
    const request = value as { ownerId?: unknown; contextId?: unknown };
    this.close(previewOwner(request.ownerId), previewContext(request.contextId));
  }
  async inspectEvidenceImage(value: unknown, requestApproval: BrowserEvidenceImageApproval, inspect: BrowserEvidenceImageInspection): Promise<boolean> {
    if (!value || typeof value !== "object") throw new Error("Invalid Browser evidence request");
    const request = value as { ownerId?: unknown; contextId?: unknown; evidenceId?: unknown };
    const ownerId = previewOwner(request.ownerId), contextId = previewContext(request.contextId);
    const evidenceId = previewTabId(request.evidenceId);
    const slot = this.#ownedSlot(ownerId, contextId); if (!slot) return false;
    const lookup = (): BrowserEvidenceImage | null => {
      const current = this.#ownedSlot(ownerId, contextId);
      return current === slot ? current.evidence.image(evidenceId) : null;
    };
    return await slot.evidenceInspectors.inspect(evidenceId, lookup, requestApproval, inspect);
  }
  close(ownerId?: PreviewOwner, contextId?: string): void {
    if (!ownerId && !contextId) this.#registeredContexts.clear();
    const slots = ownerId
      ? [[ownerId, this.#slots.get(ownerId)] as const]
      : [...this.#slots.entries()];
    for (const [id, slot] of slots) {
      this.#registeredContexts.release(id, contextId);
      const pending = this.#pendingBounds.get(id);
      if (!contextId || pending?.contextId === contextId) this.#pendingBounds.delete(id);
      if (!slot || (contextId && slot.contextId !== contextId)) continue;
      this.#slots.delete(id);
      const browserSession = slot.tabs.values().next().value
        ?.view.webContents.session;
      slot.evidenceInspectors.close();
      slot.evidence.close();
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
    return {
      ...this.#stateWithoutEvidence(slot),
      evidence: slot?.evidence.snapshot() ?? { revision: 0, entries: [], omitted: false },
    };
  }
  #stateWithoutEvidence(slot: PreviewSlot | undefined): Omit<PreviewState, "evidence"> {
    const contents = slot ? this.#active(slot).view.webContents : undefined;
    return {
      url: contents?.getURL() ?? "", loading: contents?.isLoading() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false, canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      activeTabId: slot?.activeTabId ?? null, agentActivity: slot?.activity ?? null,
      tabs: slot ? [...slot.tabs.values()].map((tab) => this.#previewTab(tab)) : [],
    };
  }
  #agentState(slot: PreviewSlot): AgentBrowserState {
    return {
      activeTabId: slot.activeTabId,
      tabs: [...slot.tabs.values()].map((tab) => this.#agentTab(tab)),
      activity: slot.activity,
    };
  }
  #publish(ownerId: PreviewOwner, contextId: string): void {
    const window = this.options.getWindow(), slot = this.#ownedSlot(ownerId, contextId);
    if (!window || window.webContents.isDestroyed() || !slot) return;
    slot.evidenceInspectors.closeUnavailable((id) => Boolean(slot.evidence.image(id)));
    const evidenceRevision = slot.evidence.revision(), publishEvidence = slot.publishedEvidenceRevision !== evidenceRevision;
    window.webContents.send(this.options.stateChannel, {
      ownerId, contextId,
      ...this.#stateWithoutEvidence(slot),
      ...(publishEvidence ? { evidence: slot.evidence.snapshot() } : {}),
    });
    if (publishEvidence) slot.publishedEvidenceRevision = evidenceRevision;
  }

  #ensure(ownerId: PreviewOwner, contextId: string): PreviewSlot {
    const existing = this.#ownedSlot(ownerId, contextId);
    if (existing) return existing;
    const displaced = this.#slots.get(ownerId);
    if (displaced) this.close(ownerId, displaced.contextId);
    let slot!: PreviewSlot;
    const evidence = new BrowserEvidenceCapture({
      isLive: () => this.#ownedSlot(ownerId, contextId) === slot,
      isCurrent: (page) => {
        const tab = slot.tabs.get(page.tabId);
        return tab?.view.webContents === page.contents
          && tab.documentSequence === page.documentSequence;
      },
      publish: () => this.#publish(ownerId, contextId),
      sensitiveDocument: async (contents) => await this.#rendererOperation(
        contents,
        () => agentPageHasSensitiveEvidence(contents),
      ),
    });
    slot = {
      contextId,
      partition: createPreviewPartition(this.options.partitionPrefix),
      tabs: new Map(),
      activeTabId: "",
      bounds: null,
      boundsGeneration: 0,
      activity: null,
      agentQueue: Promise.resolve(),
      activeIdentity: null,
      evidence,
      evidenceInspectors: new BrowserEvidenceInspectorRegistry(),
      publishedEvidenceRevision: null,
      nextPageNumber: 0,
    };
    const tab = this.#openTab(ownerId, slot);
    slot.activeTabId = tab.id;
    this.#slots.set(ownerId, slot);
    evidence.installSession(tab.view.webContents.session, (webContentsId) => {
      if (typeof webContentsId !== "number" || !Number.isInteger(webContentsId)) return null;
      const requestTab = [...slot.tabs.values()].find(
        (candidate) => candidate.view.webContents.id === webContentsId,
      );
      return requestTab ? {
        tabId: requestTab.id,
        pageNumber: requestTab.pageNumber,
        documentSequence: requestTab.documentSequence,
        authority: this.#evidenceAuthority(slot, requestTab.id),
      } : null;
    });
    const pending = this.#pendingBounds.get(ownerId);
    const bounds = pending?.contextId === contextId ? pending.bounds : undefined;
    tab.view.setBounds(bounds ?? { x: 0, y: 0, width: 0, height: 0 });
    if (bounds) slot.bounds = bounds;
    this.options.getWindow()?.contentView.addChildView(tab.view);
    this.#publish(ownerId, contextId);
    return slot;
  }

  #openTab(ownerId: PreviewOwner, slot: PreviewSlot): PreviewTab {
    if (slot.tabs.size >= MAX_BROWSER_TABS) {
      throw new Error("Inertia Browser allows at most eight tabs per chat.");
    }
    const window = this.options.getWindow();
    if (!window) throw new Error("The preview window is unavailable");
    const publish = () => this.#publish(ownerId, slot.contextId);
    const tab = createPreviewTab({
      partition: slot.partition,
      pageNumber: slot.nextPageNumber += 1,
      captureLocked: this.#captureLocked,
      registerHealthRenderer: this.options.registerHealthRenderer,
      targetContents: () => this.options.getWindow()?.webContents,
      guardNavigation: (event, url) => this.#guardNavigation(event, url),
      publish,
      navigated: (currentTab, url, sameDocument) => {
        slot.evidenceInspectors.close();
        slot.evidence.recordNavigation(
          this.#evidencePage(currentTab),
          url,
          sameDocument,
          this.#evidenceAuthority(slot, currentTab.id),
        );
      },
      consoleError: (currentTab, message) => {
        slot.evidence.recordConsoleError(
          this.#evidencePage(currentTab),
          message,
          this.#evidenceAuthority(slot, currentTab.id),
        );
      },
    });
    slot.tabs.set(tab.id, tab);
    return tab;
  }

  #evidencePage(tab: PreviewTab): BrowserEvidencePage {
    return {
      tabId: tab.id,
      pageNumber: tab.pageNumber,
      documentSequence: tab.documentSequence,
      contents: tab.view.webContents,
    };
  }

  #evidenceAuthority(
    slot: PreviewSlot,
    tabId: string,
  ): BrowserEvidenceAuthority | undefined {
    const identity = tabId === slot.activeTabId ? slot.activeIdentity : null;
    return identity ? { runId: identity.runId, turnId: identity.turnId } : undefined;
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
    slot.evidenceInspectors.close();
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
    tab.unregisterHealth();
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
    knownTab?: PreviewTab,
  ): void {
    const sanitized = sanitizeBrowserEvidenceText(
      label,
      "Agent controlled this page",
      240,
    );
    const at = new Date().toISOString();
    slot.activity = {
      action,
      label: sanitized.text,
      tabId,
      at,
      ...point,
    };
    const tab = knownTab ?? slot.tabs.get(tabId);
    if (tab) slot.evidence.recordAgentAction(
      this.#evidencePage(tab),
      sanitized.text,
      at,
      slot.activeIdentity
        ? { runId: slot.activeIdentity.runId, turnId: slot.activeIdentity.turnId }
        : undefined,
    );
    this.#publish(ownerId, slot.contextId);
  }

  #success(
    slot: PreviewSlot,
    text: string,
  ): AgentBrowserResult {
    return successfulAgentBrowserResult(text, this.#agentState(slot));
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
    const documentSequence = tab.documentSequence;
    const contents = tab.view.webContents;
    if (!contents.getURL()) return failure("not-found", "The active Browser tab has no page.");
    await this.#prepareAgentPage(contents, signal);
    this.#captureLocked.add(contents);
    let image: NativeImage;
    let capturedUrl = "";
    let capturedState: AgentBrowserState | null = null;
    try {
      await this.#rendererOperation(contents, () => setAgentPageFrozen(contents, true), { signal });
      if (await this.#rendererOperation(contents, () => agentPageHasSensitiveScreenshotEvidence(contents), { signal })) {
        return failure("invalid", "Screenshots are unavailable while the document contains sensitive evidence.");
      }
      if (await this.#rendererOperation(contents, () => agentPageHasUnguardedNestedContent(contents), { signal })) {
        return failure("invalid", "Screenshots are unavailable for nested page content.");
      }
      image = await this.#rendererOperation(contents, () => contents.capturePage(), { signal });
      if (await this.#rendererOperation(contents, () => agentPageHasSensitiveScreenshotEvidence(contents), { signal })) {
        return failure("invalid", "Screenshots are unavailable while the document contains sensitive evidence.");
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
    if (
      slot.tabs.get(tabId) !== tab
      || contents.isDestroyed()
      || tab.documentSequence !== documentSequence
    ) {
      return failure("not-found", "The captured Browser tab was closed before its screenshot completed.");
    }
    const result = capturedAgentScreenshotResult(
      image, tabId, providerVisiblePageUrl(capturedUrl), capturedState,
    );
    if (!result.ok) return result;
    slot.activity = slot.evidence.recordScreenshot(
      this.#evidencePage(tab),
      capturedUrl,
      image,
      this.#evidenceAuthority(slot, tab.id),
    );
    this.#publish(ownerId, slot.contextId);
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
    this.#record(ownerId, slot, "navigate", "Agent navigated the page");
    return this.#success(slot, boundedAgentStateText(this.#agentState(slot)));
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
    return this.#success(slot, boundedAgentStateText(this.#agentState(slot)));
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
      () => showAgentPageCursor(contents, cursorX, cursorY, "Agent click"),
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
      const deliveryRefusal = await this.#sendInputAndWait(contents, async () => {
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
      }, signal, ref);
      if (deliveryRefusal === "retargeted") return failure("not-found", "That page element changed during the click. Inspect the page again for current refs.");
      if (deliveryRefusal) return failure("invalid", deliveryRefusal === "file"
        ? "File inputs cannot be activated by the Browser agent."
        : deliveryRefusal === "disabled" ? "That page element became disabled during the click."
          : "Page controls are unavailable for nested page content.");
    } catch (error) {
      if (error instanceof AgentBrowserRefusal) return error.result;
      throw error;
    }
    this.#record(ownerId, slot, "click", "Agent clicked a page element", { x, y });
    return this.#success(slot, boundedAgentStateText(this.#agentState(slot), { clicked: ref }));
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
      () => showAgentPageCursor(contents, cursorX, cursorY, "Agent typing"),
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
    this.#record(ownerId, slot, "type", "Agent typed in a page element", { x, y });
    return this.#success(slot, JSON.stringify({ typed: ref, characters: text.length }));
  }

  async #press(ownerId: PreviewOwner, slot: PreviewSlot, key: string, signal?: AbortSignal): Promise<AgentBrowserResult> {
    stopForAbort(signal);
    const contents = this.#active(slot).view.webContents;
    await this.#prepareAgentPage(contents, signal);
    let activationBlocked: "disabled" | "file" | "nested" | "retargeted" | null = null;
    const deliveryRefusal = await this.#sendInputAndWait(contents, async () => {
      if (key === "Enter" || key === "Space") {
        activationBlocked = await deliverAgentPageActivation(
          contents,
          key,
          async (operation) => await this.#rendererOperation(contents, operation, { signal }),
          signal,
        );
        if (activationBlocked) return;
      } else {
        contents.sendInputEvent({ type: "keyDown", keyCode: key });
        contents.sendInputEvent({ type: "keyUp", keyCode: key });
      }
    }, signal);
    const refusal = activationBlocked || deliveryRefusal;
    if (refusal) return failure("invalid", agentPageActivationFailureMessage(refusal));
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

  async #sendInputAndWait(contents: PreviewTab["view"]["webContents"], dispatch: () => void | Promise<void>,
    signal?: AbortSignal, expectedClickRef?: string): Promise<Awaited<ReturnType<typeof agentPageInputRefusal>>> {
    stopForAbort(signal);
    const chooserGeneration = await this.#rendererOperation(
      contents,
      () => beginAgentFileChooserBlock(contents),
      { signal, lateSuccess: (generation) => { void releaseAgentFileChooserBlock(contents, generation).catch(() => undefined); } },
    );
    try {
      await this.#rendererOperation(
        contents,
        () => setAgentPageInputGuard(contents, true, expectedClickRef),
        { signal },
      );
      beginAgentPageInputRefusalCapture(contents);
      await settleAgentPageInput(contents, dispatch, signal);
      const isolated = await this.#rendererOperation(contents, () => agentPageInputRefusal(contents), { signal });
      return capturedAgentPageInputRefusal(contents) ?? isolated;
    } finally {
      if (!contents.isDestroyed()) {
        await this.#rendererOperation(
          contents,
          () => setAgentPageInputGuard(contents, false),
        ).catch(() => undefined);
        void releaseAgentFileChooserBlock(contents, chooserGeneration).catch(() => undefined);
      }
      endAgentPageInputRefusalCapture(contents);
    }
  }
}
