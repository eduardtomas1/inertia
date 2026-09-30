import type { AgentBrowserRequest } from "../shared/agent-browser-approval.js";
import { PreviewAgentApprovalRegistry } from "./preview-agent-approvals.js";
import { providerVisiblePageUrl, sameBounds, stopForAbort, waitForNavigationCommand } from "./preview-agent-action.js";
import type { BrowserWindow, NativeImage, Rectangle, Session, WebContents } from "electron";
import {
  AGENT_BROWSER_INSPECT_BUDGET_MS,
  AGENT_BROWSER_NAVIGATION_BUDGET_MS,
  AGENT_BROWSER_QUEUE_WAIT_MS,
  type AgentBrowserActivity,
  type AgentBrowserResult,
  type AgentBrowserRunIdentity,
  type AgentBrowserState,
  type AgentBrowserTab,
} from "../shared/agent-browser.js";
import {
  sanitizeBrowserEvidenceText,
  type BrowserEvidenceImage,
} from "../shared/browser-evidence.js";
import type { PreviewState } from "../shared/desktop.js";
import { previewNavigationTarget } from "../shared/preview-url.js";
import { captureAgentPageInputRefusal } from "./preview-agent-input.js";
import {
  agentOperationBudget,
  agentOperationFailure,
  AgentOperationScope,
  PARKED_PREVIEW_BOUNDS,
  PreviewAgentOperations,
  type AgentOperationSession,
} from "./preview-agent-operations.js";
import type { PreviewAgentOperationFailure } from "./preview-agent-phase.js";
import { BrowserEvidenceCapture, type BrowserEvidenceAuthority, type BrowserEvidencePage } from "./browser-evidence-capture.js";
import { BrowserEvidenceInspectorRegistry, type BrowserEvidenceImageApproval, type BrowserEvidenceImageInspection } from "./browser-evidence-image-approval.js";
import { PreviewContextRegistry } from "./preview-lifecycle.js";
import {
  agentBrowserIdentity,
  previewConnection,
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

interface PreviewSession extends AgentOperationSession {
  partition: string;
  browserSession: Session | null;
  surface: PreviewOwner | null;
  agentQueue: Promise<void>;
  evidenceInspectors: BrowserEvidenceInspectorRegistry;
  publishedEvidenceRevision: number | null;
  nextPageNumber: number;
  lastUsedAt: number;
  busy: number;
}

interface PreviewBrokerOptions {
  getWindow: () => BrowserWindow | null;
  openExternal: (url: string) => Promise<void>;
  stateChannel: string;
  registerHealthRenderer?(contents: WebContents): () => void;
  recordOperationFailure?(failure: PreviewAgentOperationFailure): void;
  partitionPrefix?: string;
  now?(): number;
}
const MAX_BROWSER_TABS = 8;
const MAX_PARKED_SESSIONS = 4;
const PARKED_SESSION_IDLE_MS = 30 * 60_000;

function budgetFor(request: AgentBrowserRequest): number {
  if (request.action === "perform-approved") return AGENT_BROWSER_NAVIGATION_BUDGET_MS;
  if (request.action === "prepare-approval" || request.action === "discard-approval") {
    return AGENT_BROWSER_INSPECT_BUDGET_MS;
  }
  return agentOperationBudget(request);
}

export class PreviewBroker {
  reportInputRefusal(contents: WebContents, value: unknown): boolean { return captureAgentPageInputRefusal(contents, value); }
  readonly #sessions = new Map<string, PreviewSession>();
  readonly #approvals = new PreviewAgentApprovalRegistry();
  readonly #registeredContexts = new PreviewContextRegistry();
  readonly #pendingBounds = new Map<PreviewOwner, {
    contextId: string;
    bounds: Rectangle;
  }>();
  readonly #captureLocked = new WeakSet<PreviewTab["view"]["webContents"]>();
  readonly #operations: PreviewAgentOperations<PreviewSession>;
  #idleSweep: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: PreviewBrokerOptions) {
    this.#operations = new PreviewAgentOperations<PreviewSession>({
      captureLocked: this.#captureLocked,
      active: (session) => this.#active(session),
      agentState: (session) => this.#agentState(session),
      record: (session, action, label, point) => this.#record(session, action, label, point),
      publish: (session) => this.#publish(session),
      openTab: (session) => this.#openTab(session),
      activateTab: (session, tabId) => this.#activateTab(session, tabId),
      closeTab: (session, tabId) => this.#closeTab(session, tabId),
      recordScreenshot: (session, tab, url, image) => this.#recordScreenshot(session, tab, url, image),
      recordOperationFailure: (operationFailure) => this.options.recordOperationFailure?.(operationFailure),
    });
  }

  #window(): BrowserWindow | null {
    const window = this.options.getWindow();
    return window && !window.isDestroyed() ? window : null;
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  connect(value: unknown): PreviewState {
    const { ownerId, contextId, priorContextId, accepted } = this.#registeredContexts.connect(value);
    if (accepted) {
      if (priorContextId && priorContextId !== contextId) this.#park(priorContextId, ownerId);
      const session = this.#sessions.get(contextId);
      if (session) this.#attach(session, ownerId);
    }
    return this.#state(ownerId, contextId);
  }

  async navigate(value: unknown): Promise<PreviewState> {
    const request = this.#request(value);
    const target = previewNavigationTarget(request.url);
    if (target.kind === "external") {
      await this.options.openExternal(target.url.toString());
      return this.#state(request.ownerId, request.contextId);
    }
    const session = this.#ensureAttached(request.ownerId, request.contextId);
    return await this.#serializeSessionAction(session, async () => {
      if (this.#ownedSession(request.ownerId, request.contextId) !== session) {
        return this.#state(request.ownerId, request.contextId);
      }
      const contents = this.#active(session).view.webContents;
      await this.#operations.loadURL(contents, target.url.toString());
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
    const session = this.#ownedSession(ownerId, contextId);
    const action = request.action;
    if (
      !session
      || (action !== "back" && action !== "forward" && action !== "reload")
    ) return this.#state(ownerId, contextId);
    return await this.#serializeSessionAction(session, async () => {
      if (this.#ownedSession(ownerId, contextId) !== session) {
        return this.#state(ownerId, contextId);
      }
      const contents = this.#active(session).view.webContents;
      if (action === "back" && contents.navigationHistory.canGoBack()) {
        const targetUrl = contents.navigationHistory.getEntryAtIndex(
          contents.navigationHistory.getActiveIndex() - 1,
        )?.url;
        await waitForNavigationCommand(
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
        await waitForNavigationCommand(
          contents,
          () => contents.navigationHistory.goForward(),
          targetUrl,
        );
      } else if (action === "reload") {
        await waitForNavigationCommand(contents, () => contents.reload());
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
    const session = this.#ensureAttached(ownerId, contextId);
    return await this.#serializeSessionAction(session, async () => {
      if (this.#ownedSession(ownerId, contextId) !== session) {
        return this.#state(ownerId, contextId);
      }
      if (request.action === "open") {
        const target = request.url === undefined
          ? null
          : previewNavigationTarget(request.url);
        if (target?.kind === "external") {
          throw new Error("Only local development pages can open in Inertia Browser tabs.");
        }
        const tab = this.#openTab(session);
        this.#activateTab(session, tab.id);
        if (target?.kind === "embed") {
          try {
            await this.#operations.loadURL(tab.view.webContents, target.url.toString());
          } catch (error) {
            this.#closeTab(session, tab.id);
            throw error;
          }
        }
      } else if (request.action === "activate") {
        this.#activateTab(session, previewTabId(request.tabId));
      } else if (request.action === "close") {
        this.#closeTab(session, previewTabId(request.tabId));
      } else {
        throw new Error("Invalid preview tab action");
      }
      this.#publish(session);
      return this.#state(ownerId, contextId);
    });
  }

  async perform(
    owner: string | AgentBrowserRunIdentity,
    request: AgentBrowserRequest,
    signal?: AbortSignal,
  ): Promise<AgentBrowserResult> {
    let scope: AgentOperationScope | undefined;
    try {
      const { contextId, identity } = agentBrowserIdentity(owner);
      stopForAbort(signal);
      const session = this.#sessionForAgent(contextId);
      if (!session) {
        return failure(
          "unavailable",
          "Inertia's main window is closed, so its Browser is unavailable. Ask the user to reopen the window, then try again.",
        );
      }
      session.busy += 1;
      try {
        const entered = await this.#serializeSessionAction(session, async () => {
          if (this.#sessions.get(contextId) !== session) {
            return failure("unavailable", "This chat's Inertia Browser was closed. Call the tool again to start a new one.");
          }
          stopForAbort(signal);
          session.activeIdentity = identity;
          session.lastUsedAt = this.#now();
          const operation = scope = new AgentOperationScope(budgetFor(request), signal);
          operation.keepAwake(this.#active(session).view.webContents);
          try {
            const resolved = await this.#approvals.resolve(
              request,
              identity,
              session,
              async (tab, ref) => await this.#operations.locate(tab, ref, operation.signal),
              operation.signal,
            );
            if (typeof resolved === "string") return this.#success(session, resolved);
            const command = "command" in resolved ? resolved.command : resolved;
            const validate = "command" in resolved ? resolved.validate : undefined;
            validate?.();
            switch (command.action) {
              case "snapshot":
                return await this.#operations.snapshot(session, operation);
              case "screenshot":
                return await this.#operations.screenshot(session, operation);
              case "wait":
                return await this.#operations.wait(session, command, operation);
              case "navigate":
                return await this.#operations.navigate(session, command.url, operation, validate);
              case "click":
                return await this.#operations.click(session, command.ref, operation, validate);
              case "type":
                return await this.#operations.type(session, command.ref, command.text, command.replace, operation, validate);
              case "press":
                return await this.#operations.press(session, command.key, operation, validate);
              case "scroll":
                return await this.#operations.scroll(session, command.deltaY, operation, validate);
              case "tabs":
                return this.#success(session, boundedAgentStateText(this.#agentState(session)));
              case "tab-open":
                return await this.#operations.openTab(session, command.url, operation, MAX_BROWSER_TABS);
              case "tab-activate":
                if (!session.tabs.has(command.tabId)) {
                  return failure("not-found", "That Inertia Browser tab no longer exists. List the tabs to see the current ids.");
                }
                this.#activateTab(session, command.tabId);
                this.#record(session, "tab-activate", "Agent switched pages");
                return this.#success(session, boundedAgentStateText(this.#agentState(session)));
              case "tab-close": {
                const closingTab = session.tabs.get(command.tabId);
                if (!closingTab) {
                  return failure("not-found", "That Inertia Browser tab no longer exists. List the tabs to see the current ids.");
                }
                this.#closeTab(session, command.tabId);
                this.#record(
                  session,
                  "tab-close",
                  "Agent closed a page",
                  undefined,
                  command.tabId,
                  closingTab,
                );
                return this.#success(session, boundedAgentStateText(this.#agentState(session)));
              }
            }
          } finally {
            if (session.activeIdentity === identity) session.activeIdentity = null;
          }
        }, AGENT_BROWSER_QUEUE_WAIT_MS);
        return entered ?? failure(
          "timeout",
          "Inertia Browser is still busy with an earlier action in this chat. Nothing was sent to the page for this call; try again shortly.",
        );
      } finally {
        session.busy -= 1;
        session.lastUsedAt = this.#now();
      }
    } catch (error) {
      return agentOperationFailure(error, scope);
    } finally {
      scope?.dispose();
    }
  }

  setBounds(value: unknown): boolean {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid preview request");
    }
    const request = value as {
      ownerId?: unknown;
      contextId?: unknown;
      connectionId?: unknown;
      bounds?: unknown;
    };
    const ownerId = previewOwner(request.ownerId);
    const contextId = previewContext(request.contextId);
    const connectionId = previewConnection(request.connectionId);
    if (!this.#registeredContexts.owns(ownerId, contextId, connectionId)) return this.#registeredContexts.has(ownerId);
    if (request.bounds === null) {
      const pending = this.#pendingBounds.get(ownerId);
      if (pending?.contextId === contextId) this.#pendingBounds.delete(ownerId);
      const session = this.#ownedSession(ownerId, contextId);
      if (session?.displayed) {
        session.displayed = false;
        this.#layout(session);
      }
      return true;
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
    const content = this.#window()?.getContentBounds();
    if (!content) return true;
    const x = Math.max(0, Math.min(candidate.x as number, content.width));
    const y = Math.max(0, Math.min(candidate.y as number, content.height));
    const bounds = {
      x,
      y,
      width: Math.max(0, Math.min(candidate.width as number, content.width - x)),
      height: Math.max(0, Math.min(candidate.height as number, content.height - y)),
    };
    this.#pendingBounds.set(ownerId, { contextId, bounds });
    this.#applyBounds(this.#ensureAttached(ownerId, contextId), bounds);
    return true;
  }

  closeRequest(value: unknown): void {
    const released = this.#registeredContexts.releaseRequest(value);
    if (!released) return;
    const pending = this.#pendingBounds.get(released.ownerId);
    if (pending?.contextId === released.contextId) this.#pendingBounds.delete(released.ownerId);
    this.#park(released.contextId, released.ownerId);
  }

  releaseSurfaces(): void {
    this.#registeredContexts.clear();
    this.#pendingBounds.clear();
    for (const session of this.#sessions.values()) {
      if (session.surface) this.#park(session.contextId, session.surface);
    }
  }

  async inspectEvidenceImage(value: unknown, requestApproval: BrowserEvidenceImageApproval, inspect: BrowserEvidenceImageInspection): Promise<boolean> {
    if (!value || typeof value !== "object") throw new Error("Invalid Browser evidence request");
    const request = value as { ownerId?: unknown; contextId?: unknown; evidenceId?: unknown };
    const ownerId = previewOwner(request.ownerId), contextId = previewContext(request.contextId);
    const evidenceId = previewTabId(request.evidenceId);
    const session = this.#ownedSession(ownerId, contextId); if (!session) return false;
    const lookup = (): BrowserEvidenceImage | null => {
      const current = this.#ownedSession(ownerId, contextId);
      return current === session ? current.evidence.image(evidenceId) : null;
    };
    return await session.evidenceInspectors.inspect(evidenceId, lookup, requestApproval, inspect);
  }

  close(ownerId?: PreviewOwner, contextId?: string): void {
    if (!ownerId && !contextId) {
      this.#registeredContexts.clear();
      this.#pendingBounds.clear();
    } else if (ownerId) {
      this.#registeredContexts.release(ownerId, contextId);
      const pending = this.#pendingBounds.get(ownerId);
      if (!contextId || pending?.contextId === contextId) this.#pendingBounds.delete(ownerId);
    }
    for (const session of this.#sessions.values()) {
      if (contextId ? session.contextId !== contextId : ownerId ? session.surface !== ownerId : false) continue;
      this.#destroy(session);
    }
  }

  async #serializeSessionAction<Result>(
    session: PreviewSession,
    action: () => Result | Promise<Result>,
  ): Promise<Result>;
  async #serializeSessionAction<Result>(
    session: PreviewSession,
    action: () => Result | Promise<Result>,
    waitLimitMs: number,
  ): Promise<Result | undefined>;
  async #serializeSessionAction<Result>(
    session: PreviewSession,
    action: () => Result | Promise<Result>,
    waitLimitMs?: number,
  ): Promise<Result | undefined> {
    const previous = session.agentQueue;
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    session.agentQueue = previous.then(() => current);
    if (waitLimitMs === undefined) {
      await previous;
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entered = await Promise.race([
        previous.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), waitLimitMs);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
      if (!entered) {
        release();
        return undefined;
      }
    }
    try {
      return await action();
    } finally {
      release();
    }
  }

  #request(value: unknown): {
    ownerId: PreviewOwner;
    contextId: string;
    url: string;
  } {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid preview request");
    }
    const request = value as {
      ownerId?: unknown;
      contextId?: unknown;
      url?: unknown;
    };
    if (typeof request.url !== "string") {
      throw new Error("Invalid preview request");
    }
    return {
      ownerId: previewOwner(request.ownerId),
      contextId: previewContext(request.contextId),
      url: request.url,
    };
  }

  #ownedSession(ownerId: PreviewOwner, contextId: string): PreviewSession | undefined {
    const session = this.#sessions.get(contextId);
    return session?.surface === ownerId ? session : undefined;
  }

  #active(session: PreviewSession): PreviewTab {
    const tab = session.tabs.get(session.activeTabId);
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
    const session = this.#ownedSession(ownerId, contextId);
    return {
      ...this.#stateWithoutEvidence(session),
      evidence: session?.evidence.snapshot() ?? { revision: 0, entries: [], omitted: false },
    };
  }
  #stateWithoutEvidence(session: PreviewSession | undefined): Omit<PreviewState, "evidence"> {
    const contents = session ? this.#active(session).view.webContents : undefined;
    return {
      url: contents?.getURL() ?? "", loading: contents?.isLoading() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false, canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      activeTabId: session?.activeTabId ?? null, agentActivity: session?.activity ?? null,
      tabs: session ? [...session.tabs.values()].map((tab) => this.#previewTab(tab)) : [],
    };
  }
  #agentState(session: PreviewSession): AgentBrowserState {
    return {
      activeTabId: session.activeTabId,
      tabs: [...session.tabs.values()].map((tab) => this.#agentTab(tab)),
      activity: session.activity,
    };
  }
  #publish(session: PreviewSession): void {
    const window = this.#window(), ownerId = session.surface;
    if (!window || window.webContents.isDestroyed() || !ownerId
      || this.#sessions.get(session.contextId) !== session) return;
    session.evidenceInspectors.closeUnavailable((id) => Boolean(session.evidence.image(id)));
    const evidenceRevision = session.evidence.revision(), publishEvidence = session.publishedEvidenceRevision !== evidenceRevision;
    window.webContents.send(this.options.stateChannel, {
      ownerId, contextId: session.contextId,
      ...this.#stateWithoutEvidence(session),
      ...(publishEvidence ? { evidence: session.evidence.snapshot() } : {}),
    });
    if (publishEvidence) session.publishedEvidenceRevision = evidenceRevision;
  }

  #sessionForAgent(contextId: string): PreviewSession | undefined {
    const existing = this.#sessions.get(contextId);
    if (existing) return existing;
    if (!this.#window()) return undefined;
    const session = this.#createSession(contextId);
    const ownerId = this.#registeredContexts.ownerFor(contextId);
    if (ownerId) this.#attach(session, ownerId);
    else this.#evictParked(session);
    return session;
  }

  #ensureAttached(ownerId: PreviewOwner, contextId: string): PreviewSession {
    const session = this.#sessions.get(contextId) ?? this.#createSession(contextId);
    this.#attach(session, ownerId);
    return session;
  }

  #attach(session: PreviewSession, ownerId: PreviewOwner): void {
    if (session.surface === ownerId) return;
    for (const other of this.#sessions.values()) {
      if (other !== session && other.surface === ownerId) this.#park(other.contextId, ownerId);
    }
    session.surface = ownerId;
    session.displayed = false;
    session.publishedEvidenceRevision = null;
    const pending = this.#pendingBounds.get(ownerId);
    if (pending?.contextId === session.contextId) this.#applyBounds(session, pending.bounds);
    else this.#layout(session);
    this.#publish(session);
  }

  #park(contextId: string, ownerId: PreviewOwner): void {
    const session = this.#sessions.get(contextId);
    if (!session || session.surface !== ownerId) return;
    session.surface = null;
    session.displayed = false;
    session.lastUsedAt = this.#now();
    session.evidenceInspectors.close();
    this.#layout(session);
    this.#evictParked();
  }

  #applyBounds(session: PreviewSession, bounds: Rectangle): void {
    if (bounds.width <= 0 || bounds.height <= 0) {
      session.displayed = false;
      this.#layout(session);
      return;
    }
    const previous = session.bounds ?? PARKED_PREVIEW_BOUNDS;
    if (previous.width !== bounds.width || previous.height !== bounds.height) {
      session.boundsGeneration += 1;
    }
    session.bounds = bounds;
    session.displayed = true;
    this.#layout(session);
  }

  #layout(session: PreviewSession): void {
    const tab = session.tabs.get(session.activeTabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const bounds = session.bounds ?? PARKED_PREVIEW_BOUNDS;
    if (!sameBounds(tab.view.getBounds(), bounds)) tab.view.setBounds(bounds);
    if (tab.view.getVisible() !== session.displayed) tab.view.setVisible(session.displayed);
  }

  #evictParked(keep?: PreviewSession): void {
    const now = this.#now();
    const parked = [...this.#sessions.values()].filter((session) => session.surface === null);
    const evictable = parked
      .filter((session) => session.busy === 0 && session !== keep)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    let remaining = parked.length;
    for (const session of evictable) {
      if (remaining <= MAX_PARKED_SESSIONS && now - session.lastUsedAt < PARKED_SESSION_IDLE_MS) continue;
      this.#destroy(session);
      remaining -= 1;
    }
    if (this.#idleSweep) clearTimeout(this.#idleSweep);
    this.#idleSweep = null;
    if (remaining === 0) return;
    this.#idleSweep = setTimeout(() => {
      this.#idleSweep = null;
      this.#evictParked();
    }, PARKED_SESSION_IDLE_MS);
    this.#idleSweep.unref();
  }

  #destroy(session: PreviewSession): void {
    if (this.#sessions.get(session.contextId) !== session) return;
    this.#sessions.delete(session.contextId);
    session.surface = null;
    session.displayed = false;
    const browserSession = session.browserSession;
    session.evidenceInspectors.close();
    session.evidence.close();
    for (const tab of session.tabs.values()) this.#destroyTab(tab);
    void browserSession?.clearStorageData().catch(() => {
      // The non-persistent session is destroyed with its owning slot.
    });
    if (this.#sessions.size === 0 && this.#idleSweep) {
      clearTimeout(this.#idleSweep);
      this.#idleSweep = null;
    }
  }

  #createSession(contextId: string): PreviewSession {
    let session!: PreviewSession;
    const evidence = new BrowserEvidenceCapture({
      isLive: () => this.#sessions.get(contextId) === session,
      isCurrent: (page) => {
        const tab = session.tabs.get(page.tabId);
        return tab?.view.webContents === page.contents
          && tab.documentSequence === page.documentSequence;
      },
      publish: () => this.#publish(session),
      sensitiveDocument: async (contents) => await this.#operations.sensitiveDocument(contents),
    });
    session = {
      contextId,
      partition: createPreviewPartition(this.options.partitionPrefix),
      browserSession: null,
      tabs: new Map(),
      activeTabId: "",
      surface: null,
      bounds: null,
      displayed: false,
      boundsGeneration: 0,
      activity: null,
      agentQueue: Promise.resolve(),
      activeIdentity: null,
      evidence,
      evidenceInspectors: new BrowserEvidenceInspectorRegistry(),
      publishedEvidenceRevision: null,
      nextPageNumber: 0,
      lastUsedAt: this.#now(),
      busy: 0,
    };
    const tab = this.#openTab(session);
    session.activeTabId = tab.id;
    this.#sessions.set(contextId, session);
    session.browserSession = tab.view.webContents.session;
    evidence.installSession(session.browserSession, (webContentsId) => {
      if (typeof webContentsId !== "number" || !Number.isInteger(webContentsId)) return null;
      const requestTab = [...session.tabs.values()].find(
        (candidate) => candidate.view.webContents.id === webContentsId,
      );
      return requestTab ? {
        tabId: requestTab.id,
        pageNumber: requestTab.pageNumber,
        documentSequence: requestTab.documentSequence,
        authority: this.#evidenceAuthority(session, requestTab.id),
      } : null;
    });
    this.#window()?.contentView.addChildView(tab.view);
    this.#layout(session);
    return session;
  }

  #openTab(session: PreviewSession): PreviewTab {
    if (session.tabs.size >= MAX_BROWSER_TABS) {
      throw new Error("Inertia Browser allows at most eight tabs per chat.");
    }
    const window = this.#window();
    if (!window) throw new Error("The preview window is unavailable");
    const publish = () => this.#publish(session);
    const tab = createPreviewTab({
      partition: session.partition,
      pageNumber: session.nextPageNumber += 1,
      captureLocked: this.#captureLocked,
      registerHealthRenderer: this.options.registerHealthRenderer,
      targetContents: () => this.#window()?.webContents,
      guardNavigation: (event, url) => this.#guardNavigation(event, url),
      publish,
      navigated: (currentTab, url, sameDocument) => {
        session.evidenceInspectors.close();
        session.evidence.recordNavigation(
          this.#evidencePage(currentTab),
          url,
          sameDocument,
          this.#evidenceAuthority(session, currentTab.id),
        );
      },
      consoleError: (currentTab, message) => {
        session.evidence.recordConsoleError(
          this.#evidencePage(currentTab),
          message,
          this.#evidenceAuthority(session, currentTab.id),
        );
      },
    });
    session.tabs.set(tab.id, tab);
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
    session: PreviewSession,
    tabId: string,
  ): BrowserEvidenceAuthority | undefined {
    const identity = tabId === session.activeTabId ? session.activeIdentity : null;
    return identity ? { runId: identity.runId, turnId: identity.turnId } : undefined;
  }

  #activateTab(session: PreviewSession, tabId: string): void {
    const next = session.tabs.get(tabId);
    if (!next) throw new Error("That Inertia Browser tab no longer exists.");
    const window = this.#window();
    if (!window) throw new Error("The preview window is unavailable");
    const previous = session.tabs.get(session.activeTabId);
    if (previous && previous !== next) {
      window.contentView.removeChildView(previous.view);
      previous.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    session.activeTabId = tabId;
    window.contentView.addChildView(next.view);
    this.#layout(session);
  }

  #closeTab(session: PreviewSession, tabId: string): void {
    const tab = session.tabs.get(tabId);
    if (!tab) throw new Error("That Inertia Browser tab no longer exists.");
    session.evidenceInspectors.close();
    const wasActive = session.activeTabId === tabId;
    session.tabs.delete(tabId);
    this.#destroyTab(tab);
    if (session.tabs.size === 0) {
      const replacement = this.#openTab(session);
      session.activeTabId = replacement.id;
    } else if (wasActive) {
      session.activeTabId = session.tabs.keys().next().value as string;
    }
    this.#activateTab(session, session.activeTabId);
  }

  #destroyTab(tab: PreviewTab): void {
    tab.unregisterHealth();
    this.#window()?.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  #record(
    session: PreviewSession,
    action: AgentBrowserActivity["action"],
    label: string,
    point?: { x: number; y: number },
    tabId = session.activeTabId,
    knownTab?: PreviewTab,
  ): void {
    const sanitized = sanitizeBrowserEvidenceText(
      label,
      "Agent controlled this page",
      240,
    );
    const at = new Date().toISOString();
    session.activity = {
      action,
      label: sanitized.text,
      tabId,
      at,
      ...point,
    };
    const tab = knownTab ?? session.tabs.get(tabId);
    if (tab) session.evidence.recordAgentAction(
      this.#evidencePage(tab),
      sanitized.text,
      at,
      session.activeIdentity
        ? { runId: session.activeIdentity.runId, turnId: session.activeIdentity.turnId }
        : undefined,
    );
    this.#publish(session);
  }

  #recordScreenshot(
    session: PreviewSession,
    tab: PreviewTab,
    url: string,
    image: NativeImage,
  ): AgentBrowserActivity | null {
    return session.evidence.recordScreenshot(
      this.#evidencePage(tab),
      url,
      image,
      this.#evidenceAuthority(session, tab.id),
    );
  }

  #success(
    session: PreviewSession,
    text: string,
  ): AgentBrowserResult {
    return successfulAgentBrowserResult(text, this.#agentState(session));
  }

  #guardNavigation(event: { preventDefault: () => void }, url: string): void {
    try {
      if (previewNavigationTarget(url).kind !== "embed") event.preventDefault();
    } catch {
      event.preventDefault();
    }
  }
}
