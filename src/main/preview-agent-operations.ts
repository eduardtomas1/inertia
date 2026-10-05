import type { NativeImage, Rectangle } from "electron";

import {
  AGENT_BROWSER_INPUT_BUDGET_MS,
  AGENT_BROWSER_INSPECT_BUDGET_MS,
  AGENT_BROWSER_NAVIGATION_BUDGET_MS,
  type AgentBrowserActivity,
  type AgentBrowserCommand,
  type AgentBrowserResult,
  type AgentBrowserRunIdentity,
  type AgentBrowserState,
} from "../shared/agent-browser.js";
import { sanitizeBrowserEvidenceText } from "../shared/browser-evidence.js";
import { previewNavigationTarget } from "../shared/preview-url.js";
import type { BrowserEvidenceCapture } from "./browser-evidence-capture.js";
import { AgentBrowserRefusal, changedGeometry, providerVisiblePageUrl, stopForAbort } from "./preview-agent-action.js";
import type { BrowserApprovalGuard } from "./preview-agent-approvals.js";
import {
  agentPageActivationFailureMessage, agentPageBoundaryGaps, beginAgentFileChooserBlock, beginAgentPageInputRefusalCapture, capturedAgentPageInputRefusal, deliverAgentPageActivation, endAgentPageInputRefusalCapture, ensureAgentFileChooserBlock, hoverAgentPageRef, releaseAgentFileChooserBlock, resetAgentFileChooserBlock, setAgentPageFrozen, settleAgentPageDebuggerBootstrap, settleAgentPageInput,
} from "./preview-agent-input.js";
import {
  agentPageEvidencePrivacy, agentPageHasSensitiveScreenshotEvidence, agentPageInputRefusal, agentPageRefHasFocus,
  installAgentPagePrivacyGuard,
  locateAgentPageRef, semanticPageSnapshot, setAgentPageInputGuard, showAgentPageCursor,
  type AgentPageNotInspected, type AgentPageWithheldReason,
} from "./preview-agent-page.js";
import { previewAgentPhaseTimeoutMessage, type PreviewAgentOperationFailure, type PreviewAgentOperationPhase } from "./preview-agent-phase.js";
import { boundedAgentStateText, failedAgentBrowserResult as failure, successfulAgentBrowserResult } from "./preview-agent-result.js";
import { capturedAgentScreenshotResult } from "./preview-agent-screenshot.js";
import type { PreviewTab } from "./preview-tab.js";

const PREVIEW_RENDERER_OPERATION_TIMEOUT_MS = 15_000;
const NAVIGATION_REPORT_RESERVE_MS = 3_000;
const AGENT_PAGE_REST_DELAY_MS = 2_000;
const WAIT_POLL_MS = 400;
const WAIT_REPORT_RESERVE_MS = 5_000;
export const PARKED_PREVIEW_BOUNDS: Rectangle = { x: 0, y: 0, width: 1_280, height: 800 };

const BLANK_TAB_NEXT_STEP = "This tab is blank. Open a page with the navigate tool and a local development URL such as http://localhost:3000, then take a snapshot.";
const STILL_LOADING_NOTE = "The page is still loading. Wait for it with the wait tool, or take a snapshot to read what has rendered so far.";
const FAILED_LOAD_MESSAGE = "This tab is showing a browser error page because its last navigation failed. Check that the development server is running, then navigate again.";
const CANCELLED_NAVIGATION_MESSAGE = "The navigation was cancelled before a page loaded, usually because it redirected to an address outside this machine or started a download. The tab still shows its previous page.";
const CRASHED_PAGE_MESSAGE = "This tab's page crashed. Navigate to the page again to reload it.";
const NAVIGATION_REPLACED_NOTE = "The page replaced this navigation before it finished. Take a snapshot to see which page is showing.";

type PreviewContents = PreviewTab["view"]["webContents"];

export interface AgentOperationSession {
  contextId: string;
  tabs: Map<string, PreviewTab>;
  activeTabId: string;
  bounds: Rectangle | null;
  displayed: boolean;
  boundsGeneration: number;
  activity: AgentBrowserActivity | null;
  activeIdentity: AgentBrowserRunIdentity | null;
  evidence: BrowserEvidenceCapture;
}

export interface AgentOperationHost<Session extends AgentOperationSession> {
  captureLocked: WeakSet<PreviewContents>;
  active(session: Session): PreviewTab;
  agentState(session: Session): AgentBrowserState;
  record(
    session: Session,
    action: AgentBrowserActivity["action"],
    label: string,
    point?: { x: number; y: number },
  ): void;
  publish(session: Session): void;
  openTab(session: Session): PreviewTab;
  activateTab(session: Session, tabId: string): void;
  closeTab(session: Session, tabId: string): void;
  recordScreenshot(session: Session, tab: PreviewTab, url: string, image: NativeImage): AgentBrowserActivity | null;
  recordOperationFailure?(failure: PreviewAgentOperationFailure): void;
}

class AgentBrowserTimeout extends Error {}

type PageReading =
  | { ok: true; text: string; state: AgentBrowserState }
  | { ok: false; result: AgentBrowserResult };

const restTimers = new WeakMap<PreviewContents, ReturnType<typeof setTimeout>>();

export class AgentOperationScope {
  readonly signal: AbortSignal;
  inputSent = false;
  timedOut = false;
  readonly #deadlineAt: number;
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #awake = new Set<PreviewContents>();
  readonly #caller: AbortSignal | undefined;
  readonly #onCallerAbort = (): void => this.#controller.abort();

  constructor(budgetMs: number, caller?: AbortSignal) {
    this.#deadlineAt = Date.now() + budgetMs;
    this.#caller = caller;
    this.signal = this.#controller.signal;
    this.#timer = setTimeout(() => {
      this.timedOut = true;
      this.#controller.abort();
    }, budgetMs);
    this.#timer.unref();
    if (caller?.aborted) this.#controller.abort();
    else caller?.addEventListener("abort", this.#onCallerAbort, { once: true });
  }

  remaining(): number {
    return Math.max(0, this.#deadlineAt - Date.now());
  }

  keepAwake(contents: PreviewContents): void {
    if (contents.isDestroyed() || this.#awake.has(contents)) return;
    this.#awake.add(contents);
    const pending = restTimers.get(contents);
    if (pending) clearTimeout(pending);
    restTimers.delete(contents);
    contents.setBackgroundThrottling(false);
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#caller?.removeEventListener("abort", this.#onCallerAbort);
    for (const contents of this.#awake) {
      const timer = setTimeout(() => {
        if (restTimers.get(contents) !== timer) return;
        restTimers.delete(contents);
        if (!contents.isDestroyed()) contents.setBackgroundThrottling(true);
      }, AGENT_PAGE_REST_DELAY_MS);
      timer.unref();
      restTimers.set(contents, timer);
    }
    this.#awake.clear();
  }
}

export function agentOperationBudget(command: AgentBrowserCommand): number {
  switch (command.action) {
    case "navigate":
    case "tab-open":
      return AGENT_BROWSER_NAVIGATION_BUDGET_MS;
    case "click":
    case "type":
    case "press":
    case "scroll":
      return AGENT_BROWSER_INPUT_BUDGET_MS;
    case "wait":
      return command.timeoutMs + WAIT_REPORT_RESERVE_MS;
    default:
      return AGENT_BROWSER_INSPECT_BUDGET_MS;
  }
}

function outcomeAfterTimeout(scope: AgentOperationScope | undefined): string {
  return scope?.inputSent
    ? " Input may already have reached the page, so its effect is unknown: take a snapshot before repeating it."
    : " Nothing had been sent to the page yet, so it is safe to try again.";
}

export function agentOperationFailure(
  error: unknown,
  scope: AgentOperationScope | undefined,
): AgentBrowserResult {
  if (error instanceof AgentBrowserRefusal) return error.result;
  if (error instanceof AgentBrowserTimeout) {
    return failure("timeout", `${error.message}${outcomeAfterTimeout(scope)}`);
  }
  if (error instanceof Error && error.message === "browser-action-cancelled") {
    return scope?.timedOut
      ? failure("timeout", `The browser action ran out of time.${outcomeAfterTimeout(scope)}`)
      : failure("cancelled", "The browser action was cancelled.");
  }
  return failure(
    "unavailable",
    error instanceof Error
      ? sanitizeBrowserEvidenceText(error.message, "The Inertia Browser action failed.", 600).text
      : "The Inertia Browser action failed.",
  );
}

function withheldEvidenceMessage(reason: AgentPageWithheldReason, subject: string): string {
  const recovery = " Navigate to the page again to load a new document, then continue.";
  if (reason === "password") {
    return `${subject} withheld because this document holds a password value, which Inertia never sends to a model.${recovery}`;
  }
  if (reason === "redaction-limit") {
    return `${subject} withheld because this document exceeds the limit for safely hiding sensitive values.${recovery}`;
  }
  if (reason === "hidden-input") {
    return `${subject} withheld because text was typed into a control Inertia cannot inspect (inside a closed shadow root), so it could be a password.${recovery}`;
  }
  if (reason === "document-too-large") {
    return `${subject} withheld because this page has more than 4,000 inputs, too many for Inertia to check safely for password values. Open a smaller page or a more specific route that shows fewer inputs, then continue.`;
  }
  return `${subject} withheld because a script changed a password field in this document.${recovery}`;
}

function navigationFailureMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  const code = /\bERR_[A-Z_]+/u.exec(text)?.[0] ?? "";
  if (code === "ERR_CONNECTION_REFUSED") {
    return "Nothing answered at that address (connection refused). Start the development server or check its port, then navigate again.";
  }
  if (code === "ERR_UNSAFE_PORT") {
    return "Chromium refuses to open that port. Run the development server on a different port, then navigate to it.";
  }
  if (code === "ERR_NAME_NOT_RESOLVED") {
    return "That host name could not be resolved. Use localhost, 127.0.0.1 or [::1] with the development server's port.";
  }
  if (["ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_EMPTY_RESPONSE"].includes(code)) {
    return "The server closed the connection before sending a page. Check the development server's output, then navigate again.";
  }
  if (["ERR_CONNECTION_TIMED_OUT", "ERR_TIMED_OUT"].includes(code)) {
    return "The server did not answer in time. Check that the development server is running, then navigate again.";
  }
  if (code.startsWith("ERR_CERT_") || code === "ERR_SSL_PROTOCOL_ERROR") {
    return "The page's HTTPS certificate is not trusted by Inertia Browser. Use the development server's http:// address if it has one.";
  }
  if (code === "ERR_BLOCKED_BY_CLIENT" || code === "ERR_BLOCKED_BY_RESPONSE") {
    return "The page was blocked, usually because it redirected to an address outside this machine. Inertia Browser only opens local development pages.";
  }
  return `The page could not be loaded${code ? ` (${code})` : ""}. Check that the development server is running, then navigate again.`;
}

function blankTab(contents: PreviewContents): boolean {
  const url = contents.getURL();
  return !url || url === "about:blank";
}

export function blankTabRefusal(
  contents: PreviewContents,
  command: AgentBrowserCommand,
): AgentBrowserResult | null {
  return ["click", "type", "press", "scroll"].includes(command.action) && blankTab(contents)
    ? failure("not-found", BLANK_TAB_NEXT_STEP)
    : null;
}

function snapshotIsErrorPage(snapshot: string): boolean {
  try {
    const parsed = JSON.parse(snapshot) as unknown;
    return typeof parsed === "object" && parsed !== null
      && (parsed as { errorPage?: unknown }).errorPage === true;
  } catch {
    return false;
  }
}

function snapshotContains(snapshot: string, needle: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const page = parsed as { text?: unknown; elements?: unknown };
  const matches = (value: unknown): boolean => typeof value === "string"
    && value.replace(/\s+/gu, " ").toLowerCase().includes(needle);
  if (matches(page.text)) return true;
  if (!Array.isArray(page.elements)) return false;
  return page.elements.some((element) => {
    if (typeof element !== "object" || element === null) return false;
    const candidate = element as { name?: unknown; value?: unknown };
    return matches(candidate.name) || matches(candidate.value);
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("browser-action-cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class PreviewAgentOperations<Session extends AgentOperationSession> {
  constructor(private readonly host: AgentOperationHost<Session>) {}

  async rendererOperation<Result>(
    contents: PreviewContents,
    operation: () => Promise<Result>,
    options: {
      phase: PreviewAgentOperationPhase;
      scope?: AgentOperationScope;
      signal?: AbortSignal;
      cancel?: () => void;
      lateSuccess?: (value: Result) => void;
    },
  ): Promise<Result> {
    const signal = options.scope?.signal ?? options.signal;
    stopForAbort(signal);
    if (contents.isDestroyed()) {
      throw new Error("The active Browser tab was closed before the operation started.");
    }
    const timeoutMs = PREVIEW_RENDERER_OPERATION_TIMEOUT_MS;
    return await new Promise<Result>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        contents.removeListener("destroyed", onDestroyed);
        signal?.removeEventListener("abort", onAbort);
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
      const onAbort = (): void => {
        if (options.scope?.timedOut) {
          this.host.recordOperationFailure?.({ phase: options.phase, category: "timeout" });
        }
        fail(new Error("browser-action-cancelled"), true);
      };
      const onDestroyed = (): void => fail(
        new Error("The active Browser tab was closed during the operation."),
      );
      const timeout = setTimeout(() => {
        this.host.recordOperationFailure?.({ phase: options.phase, category: "timeout" });
        fail(
          new AgentBrowserTimeout(previewAgentPhaseTimeoutMessage(options.phase, timeoutMs)),
          true,
        );
      }, timeoutMs);
      timeout.unref();
      contents.once("destroyed", onDestroyed);
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(operation).then(succeed, (error: unknown) => {
        if (!settled
          && !(error instanceof AgentBrowserRefusal)
          && !(error instanceof Error && error.message === "browser-action-cancelled")) {
          this.host.recordOperationFailure?.({ phase: options.phase, category: "failed" });
        }
        fail(error instanceof Error ? error : new Error("The Browser renderer operation failed."));
      });
    });
  }

  async loadURL(
    contents: PreviewContents,
    url: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#ensureSecurityDebugger(contents, undefined, signal);
    await this.rendererOperation(
      contents,
      async () => { await contents.loadURL(url); settleAgentPageDebuggerBootstrap(contents); },
      { signal, phase: "page-load", cancel: () => contents.stop() },
    );
  }

  async locate(tab: PreviewTab, ref: string, signal?: AbortSignal) {
    const contents = tab.view.webContents;
    if (blankTab(contents)) throw new AgentBrowserRefusal(failure("not-found", BLANK_TAB_NEXT_STEP));
    await this.#ensureSecurityDebugger(contents, undefined, signal);
    await this.rendererOperation(contents, () => installAgentPagePrivacyGuard(contents), { signal, phase: "privacy-guard" });
    return await this.rendererOperation(contents, () => locateAgentPageRef(contents, ref), { signal, phase: "element-lookup" });
  }

  async sensitiveDocument(contents: PreviewContents): Promise<boolean> {
    return (await this.rendererOperation(
      contents,
      () => agentPageEvidencePrivacy(contents),
      { phase: "privacy-check" },
    )).withheld !== null;
  }

  async snapshot(session: Session, scope: AgentOperationScope): Promise<AgentBrowserResult> {
    const tab = this.host.active(session);
    const contents = tab.view.webContents;
    if (blankTab(contents)) {
      return successfulAgentBrowserResult(
        JSON.stringify({ blank: true, nextStep: BLANK_TAB_NEXT_STEP }),
        this.host.agentState(session),
      );
    }
    const page = await this.#readPage(session, tab, scope, true);
    if (!page.ok) return page.result;
    stopForAbort(scope.signal);
    if (session.tabs.get(tab.id) !== tab || contents.isDestroyed()) {
      return failure("not-found", "The Browser tab was closed before its snapshot completed. List the tabs, then take a new snapshot.");
    }
    return successfulAgentBrowserResult(page.text, page.state);
  }

  async wait(
    session: Session,
    command: Extract<AgentBrowserCommand, { action: "wait" }>,
    scope: AgentOperationScope,
  ): Promise<AgentBrowserResult> {
    const startedAt = Date.now();
    const needle = command.text?.replace(/\s+/gu, " ").toLowerCase();
    const report = (matched: boolean, nextStep?: string): AgentBrowserResult => successfulAgentBrowserResult(
      boundedAgentStateText(this.host.agentState(session), {
        matched,
        waitedMs: Date.now() - startedAt,
        ...(nextStep ? { nextStep } : {}),
      }),
      this.host.agentState(session),
    );
    for (;;) {
      stopForAbort(scope.signal);
      const tab = this.host.active(session);
      const contents = tab.view.webContents;
      if (blankTab(contents)) return report(false, BLANK_TAB_NEXT_STEP);
      if (needle === undefined) {
        if (!contents.isLoading()) return report(true);
      } else {
        const page = await this.#pollPage(session, tab, scope);
        if (page && !page.ok) return page.result;
        if (page && snapshotContains(page.text, needle) === (command.state === "present")) return report(true);
      }
      if (Date.now() - startedAt + WAIT_POLL_MS >= command.timeoutMs) {
        return report(false, "The condition was not reached in time. Take a snapshot to see what the page shows now.");
      }
      await delay(WAIT_POLL_MS, scope.signal);
    }
  }

  async screenshot(session: Session, scope: AgentOperationScope): Promise<AgentBrowserResult> {
    const tab = this.host.active(session);
    const tabId = tab.id;
    const documentSequence = tab.documentSequence;
    const contents = tab.view.webContents;
    if (blankTab(contents)) return failure("not-found", BLANK_TAB_NEXT_STEP);
    await this.#prepareAgentPage(contents, scope);
    this.host.captureLocked.add(contents);
    let image: NativeImage;
    let capturedUrl = "";
    let capturedState: AgentBrowserState | null = null;
    try {
      await this.rendererOperation(contents, () => setAgentPageFrozen(contents, true), { scope, phase: "page-freeze" });
      const privacy = await this.rendererOperation(contents, () => agentPageEvidencePrivacy(contents), { scope, phase: "privacy-check" });
      if (privacy.withheld) return failure("sensitive", withheldEvidenceMessage(privacy.withheld, "Screenshots are"));
      if (await this.rendererOperation(contents, () => agentPageHasSensitiveScreenshotEvidence(contents), { scope, phase: "privacy-check" })) {
        return failure("sensitive", "Screenshots are unavailable because the visible page shows a secret, or is too large for Inertia to check for one.");
      }
      image = await this.rendererOperation(contents, () => contents.capturePage(), { scope, phase: "screenshot-capture" });
      if (await this.rendererOperation(contents, () => agentPageHasSensitiveScreenshotEvidence(contents), { scope, phase: "privacy-check" })) {
        return failure("sensitive", "Screenshots are unavailable because the visible page shows a secret, or is too large for Inertia to check for one.");
      }
      capturedUrl = contents.getURL();
      capturedState = this.host.agentState(session);
    } finally {
      try {
        await this.#resumeAgentPage(session, tab);
      } finally {
        this.host.captureLocked.delete(contents);
      }
    }
    stopForAbort(scope.signal);
    if (!capturedState) {
      return failure("unavailable", "The Browser screenshot state could not be captured.");
    }
    if (
      session.tabs.get(tabId) !== tab
      || contents.isDestroyed()
      || tab.documentSequence !== documentSequence
    ) {
      return failure("not-found", "The captured Browser tab was closed before its screenshot completed.");
    }
    const result = capturedAgentScreenshotResult(
      image, tabId, providerVisiblePageUrl(capturedUrl), capturedState,
    );
    if (!result.ok) return result;
    session.activity = this.host.recordScreenshot(session, tab, capturedUrl, image);
    this.host.publish(session);
    return { ...result, state: { ...result.state, activity: session.activity } };
  }

  async navigate(
    session: Session,
    url: string,
    scope: AgentOperationScope,
    validate?: BrowserApprovalGuard,
  ): Promise<AgentBrowserResult> {
    const target = this.#localTarget(url);
    if (!target) return this.#remoteAddressFailure();
    const contents = this.host.active(session).view.webContents;
    const loaded = await this.#agentLoad(contents, target, scope, validate);
    stopForAbort(scope.signal);
    this.host.record(session, "navigate", "Agent navigated the page");
    return this.#stateResult(session, this.#loadNote(contents, loaded));
  }

  async openTab(
    session: Session,
    url: string | undefined,
    scope: AgentOperationScope,
    maximumTabs: number,
  ): Promise<AgentBrowserResult> {
    if (session.tabs.size >= maximumTabs) {
      return failure("too-large", "Inertia Browser allows at most eight tabs per chat. Close a tab you no longer need, then open another.");
    }
    const target = url === undefined ? undefined : this.#localTarget(url);
    if (target === null) return this.#remoteAddressFailure();
    stopForAbort(scope.signal);
    const tab = this.host.openTab(session);
    this.host.activateTab(session, tab.id);
    scope.keepAwake(tab.view.webContents);
    let loaded = true;
    if (target) {
      try {
        loaded = await this.#agentLoad(tab.view.webContents, target, scope);
      } catch (error) {
        this.host.closeTab(session, tab.id);
        throw error;
      }
    }
    stopForAbort(scope.signal);
    this.host.record(session, "tab-open", "Agent opened a new page");
    return this.#stateResult(session, this.#loadNote(tab.view.webContents, loaded));
  }

  async click(session: Session, ref: string, scope: AgentOperationScope, validate?: BrowserApprovalGuard): Promise<AgentBrowserResult> {
    const contents = this.host.active(session).view.webContents;
    if (blankTab(contents)) return failure("not-found", BLANK_TAB_NEXT_STEP);
    await this.#prepareAgentPage(contents, scope);
    const boundsGeneration = session.boundsGeneration;
    const located = await this.rendererOperation(
      contents,
      () => locateAgentPageRef(contents, ref),
      { scope, phase: "element-lookup" },
    );
    if (session.boundsGeneration !== boundsGeneration) return changedGeometry();
    let x = located.x;
    let y = located.y;
    if (!located.found || x === undefined || y === undefined) {
      return failure("not-found", "That page element is stale. Inspect the page again for current refs.");
    }
    if (located.blocked) return failure("invalid", "That page element cannot be controlled by the Browser agent.");
    if (located.disabled) return failure("invalid", "That page element is disabled.");
    const cursorX = x;
    const cursorY = y;
    stopForAbort(scope.signal);
    await this.rendererOperation(
      contents,
      () => showAgentPageCursor(contents, cursorX, cursorY, "Agent click"),
      { scope, phase: "page-cursor" },
    );
    if (session.boundsGeneration !== boundsGeneration) return changedGeometry();
    const revalidated = await this.rendererOperation(
      contents,
      () => locateAgentPageRef(contents, ref),
      { scope, phase: "element-lookup" },
    );
    if (session.boundsGeneration !== boundsGeneration) return changedGeometry();
    x = revalidated.x;
    y = revalidated.y;
    if (!revalidated.found || x === undefined || y === undefined) {
      return failure("not-found", "That page element changed before the click. Inspect the page again for current refs.");
    }
    if (revalidated.blocked) return failure("invalid", "That page element cannot be controlled by the Browser agent.");
    if (revalidated.disabled) return failure("invalid", "That page element is disabled.");
    validate?.(revalidated);
    stopForAbort(scope.signal);
    const deliveryRefusal = await this.#sendInputAndWait(contents, async () => {
      scope.inputSent = true;
      const finalTarget = await this.rendererOperation(
        contents,
        () => hoverAgentPageRef(contents, ref, x!, y!, scope.signal),
        { scope, phase: "page-hover" },
      );
      if (session.boundsGeneration !== boundsGeneration) {
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
      validate?.(finalTarget);
      contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    }, scope, ref);
    if (deliveryRefusal === "retargeted") return failure("not-found", "That page element changed during the click. Inspect the page again for current refs.");
    if (deliveryRefusal) return failure("invalid", deliveryRefusal === "file"
      ? "File inputs cannot be activated by the Browser agent."
      : deliveryRefusal === "disabled" ? "That page element became disabled during the click."
        : "The click could not be delivered because the page reported a target Inertia cannot inspect. Take a new snapshot and click a listed control.");
    this.host.record(session, "click", "Agent clicked a page element", { x, y });
    return this.#stateResult(session, { clicked: ref });
  }

  async type(
    session: Session,
    ref: string,
    text: string,
    replace: boolean,
    scope: AgentOperationScope,
    validate?: BrowserApprovalGuard,
  ): Promise<AgentBrowserResult> {
    const contents = this.host.active(session).view.webContents;
    if (blankTab(contents)) return failure("not-found", BLANK_TAB_NEXT_STEP);
    await this.#prepareAgentPage(contents, scope);
    const boundsGeneration = session.boundsGeneration;
    const located = await this.rendererOperation(
      contents,
      () => locateAgentPageRef(contents, ref),
      { scope, phase: "element-lookup" },
    );
    if (session.boundsGeneration !== boundsGeneration) return changedGeometry();
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
    stopForAbort(scope.signal);
    await this.rendererOperation(
      contents,
      () => showAgentPageCursor(contents, cursorX, cursorY, "Agent typing"),
      { scope, phase: "page-cursor" },
    );
    if (session.boundsGeneration !== boundsGeneration) return changedGeometry();
    const revalidated = await this.rendererOperation(
      contents,
      () => locateAgentPageRef(contents, ref),
      { scope, phase: "element-lookup" },
    );
    if (session.boundsGeneration !== boundsGeneration) return changedGeometry();
    x = revalidated.x;
    y = revalidated.y;
    if (!revalidated.found || x === undefined || y === undefined) {
      return failure("not-found", "That page element lost focus before typing. Inspect the page again for current refs.");
    }
    if (revalidated.blocked) return failure("invalid", "That page element cannot be controlled by the Browser agent.");
    if (revalidated.disabled) return failure("invalid", "That page element is disabled.");
    if (!revalidated.editable) return failure("invalid", "That page element does not accept text input.");
    validate?.(revalidated);
    stopForAbort(scope.signal);
    await this.#sendInputAndWait(contents, async () => {
      scope.inputSent = true;
      const finalTarget = await this.rendererOperation(
        contents,
        () => locateAgentPageRef(contents, ref, true, replace),
        { scope, phase: "element-lookup" },
      );
      if (session.boundsGeneration !== boundsGeneration) {
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
      const stillFocused = await this.rendererOperation(
        contents,
        () => agentPageRefHasFocus(contents, ref),
        { scope, phase: "element-lookup" },
      );
      if (!stillFocused) throw new AgentBrowserRefusal(failure(
        "not-found",
        "That page element lost focus before typing. Inspect the page again for current refs.",
      ));
      if (validate) validate(await this.rendererOperation(contents, () => locateAgentPageRef(contents, ref), { scope, phase: "element-lookup" }));
      await contents.insertText(text);
    }, scope);
    stopForAbort(scope.signal);
    this.host.record(session, "type", "Agent typed in a page element", { x, y });
    return this.#stateResult(session, { typed: ref, characters: text.length });
  }

  async press(session: Session, key: string, scope: AgentOperationScope, validate?: BrowserApprovalGuard): Promise<AgentBrowserResult> {
    stopForAbort(scope.signal);
    const contents = this.host.active(session).view.webContents;
    if (blankTab(contents)) return failure("not-found", BLANK_TAB_NEXT_STEP);
    await this.#prepareAgentPage(contents, scope);
    let activationBlocked: "disabled" | "file" | "nested" | "retargeted" | null = null;
    const deliveryRefusal = await this.#sendInputAndWait(contents, async () => {
      scope.inputSent = true;
      if (key === "Enter" || key === "Space") {
        activationBlocked = await deliverAgentPageActivation(
          contents,
          key,
          async (operation) => {
            const result = await this.rendererOperation(contents, operation, { scope, phase: "key-activation" });
            validate?.();
            return result;
          },
          scope.signal,
        );
        if (activationBlocked) return;
      } else {
        validate?.();
        contents.sendInputEvent({ type: "keyDown", keyCode: key });
        contents.sendInputEvent({ type: "keyUp", keyCode: key });
      }
    }, scope);
    const refusal = activationBlocked || deliveryRefusal;
    if (refusal) return failure("invalid", agentPageActivationFailureMessage(refusal));
    this.host.record(session, "press", `Agent pressed ${key}`);
    return this.#stateResult(session, { pressed: key });
  }

  async scroll(session: Session, deltaY: number, scope: AgentOperationScope, validate?: BrowserApprovalGuard): Promise<AgentBrowserResult> {
    stopForAbort(scope.signal);
    const contents = this.host.active(session).view.webContents;
    if (blankTab(contents)) return failure("not-found", BLANK_TAB_NEXT_STEP);
    await this.#prepareAgentPage(contents, scope);
    const bounds = session.bounds ?? PARKED_PREVIEW_BOUNDS;
    await this.#sendInputAndWait(contents, () => {
      validate?.();
      scope.inputSent = true;
      contents.sendInputEvent({
        type: "mouseWheel",
        x: Math.max(0, Math.floor(bounds.width / 2)),
        y: Math.max(0, Math.floor(bounds.height / 2)),
        deltaX: 0,
        deltaY,
      });
    }, scope);
    this.host.record(session, "scroll", `Agent scrolled ${deltaY > 0 ? "down" : "up"}`);
    return this.#stateResult(session, { scrolled: deltaY });
  }

  #stateResult(session: Session, detail?: Record<string, unknown>): AgentBrowserResult {
    const state = this.host.agentState(session);
    return successfulAgentBrowserResult(boundedAgentStateText(state, detail), state);
  }

  #loadNote(contents: PreviewContents, loaded: boolean): Record<string, unknown> | undefined {
    if (loaded) return undefined;
    return { note: contents.isLoading() ? STILL_LOADING_NOTE : NAVIGATION_REPLACED_NOTE };
  }

  #localTarget(url: string): string | null {
    try {
      const target = previewNavigationTarget(url);
      return target.kind === "embed" ? target.url.toString() : null;
    } catch {
      return null;
    }
  }

  #remoteAddressFailure(): AgentBrowserResult {
    return failure(
      "invalid",
      "Inertia Browser only opens local development addresses: http or https on localhost, 127.0.0.1 or [::1], with a port if needed. Remote sites are not available to this tool.",
    );
  }

  async #pollPage(
    session: Session,
    tab: PreviewTab,
    scope: AgentOperationScope,
  ): Promise<PageReading | null> {
    try {
      return await this.#readPage(session, tab, scope, false);
    } catch (error) {
      if (scope.signal.aborted || error instanceof AgentBrowserRefusal) throw error;
      return null;
    }
  }

  async #readPage(
    session: Session,
    tab: PreviewTab,
    scope: AgentOperationScope,
    capture: boolean,
  ): Promise<PageReading> {
    const contents = tab.view.webContents;
    await this.#prepareAgentPage(contents, scope);
    if (capture) this.host.captureLocked.add(contents);
    try {
      if (capture) {
        await this.rendererOperation(contents, () => setAgentPageFrozen(contents, true), { scope, phase: "page-freeze" });
      }
      const before = await this.rendererOperation(contents, () => agentPageEvidencePrivacy(contents, "semantic"), { scope, phase: "privacy-check" });
      if (before.withheld) {
        return { ok: false, result: failure("sensitive", withheldEvidenceMessage(before.withheld, "Page content is")) };
      }
      const gaps = agentPageBoundaryGaps(contents);
      const observed: AgentPageNotInspected[] = [
        ...(gaps.frames ? ["frames" as const] : []),
        ...(gaps.shadowRoots ? ["shadow-roots" as const] : []),
      ];
      const text = await this.rendererOperation(contents, () => semanticPageSnapshot(contents, observed), {
        scope,
        phase: "page-snapshot",
      });
      const after = await this.rendererOperation(contents, () => agentPageEvidencePrivacy(contents, "semantic"), { scope, phase: "privacy-check" });
      if (after.withheld) {
        return { ok: false, result: failure("sensitive", withheldEvidenceMessage(after.withheld, "Page content is")) };
      }
      if (snapshotIsErrorPage(text)) {
        return { ok: false, result: failure("unavailable", FAILED_LOAD_MESSAGE) };
      }
      stopForAbort(scope.signal);
      if (capture) this.host.record(session, "snapshot", "Agent inspected this page");
      return { ok: true, text, state: this.host.agentState(session) };
    } finally {
      if (capture) {
        try {
          await this.#resumeAgentPage(session, tab);
        } finally {
          this.host.captureLocked.delete(contents);
        }
      }
    }
  }

  async #agentLoad(
    contents: PreviewContents,
    url: string,
    scope: AgentOperationScope,
    validate?: BrowserApprovalGuard,
  ): Promise<boolean> {
    await this.#ensureSecurityDebugger(contents, scope);
    stopForAbort(scope.signal);
    validate?.();
    const waitMs = Math.max(1_000, scope.remaining() - NAVIGATION_REPORT_RESERVE_MS);
    const previousUrl = contents.getURL();
    scope.inputSent = true;
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        contents.removeListener("destroyed", onDestroyed);
        scope.signal.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = (): void => finish(() => {
        if (!contents.isDestroyed()) contents.stop();
        reject(new Error("browser-action-cancelled"));
      });
      const onDestroyed = (): void => finish(() => reject(
        new Error("The active Browser tab was closed during navigation."),
      ));
      const timer = setTimeout(() => finish(() => resolve(false)), waitMs);
      timer.unref();
      contents.once("destroyed", onDestroyed);
      scope.signal.addEventListener("abort", onAbort, { once: true });
      contents.loadURL(url).then(() => {
        if (!contents.isDestroyed()) settleAgentPageDebuggerBootstrap(contents);
        finish(() => resolve(true));
      }, (error: unknown) => {
        if (error instanceof Error && /\bERR_ABORTED\b/u.test(error.message)) {
          finish(() => {
            if (contents.isDestroyed() || contents.isLoading() || contents.getURL() !== previousUrl) {
              resolve(false);
            } else {
              reject(new AgentBrowserRefusal(failure("unavailable", CANCELLED_NAVIGATION_MESSAGE)));
            }
          });
          return;
        }
        if (!settled) this.host.recordOperationFailure?.({ phase: "page-load", category: "failed" });
        finish(() => reject(new AgentBrowserRefusal(
          failure("unavailable", navigationFailureMessage(error)),
        )));
      });
    });
  }

  async #ensureSecurityDebugger(
    contents: PreviewContents,
    scope?: AgentOperationScope,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.rendererOperation(
      contents,
      () => ensureAgentFileChooserBlock(contents),
      { scope, signal, phase: "security-setup", cancel: () => resetAgentFileChooserBlock(contents) },
    );
  }

  async #prepareAgentPage(
    contents: PreviewContents,
    scope: AgentOperationScope,
  ): Promise<void> {
    if (contents.isCrashed()) {
      throw new AgentBrowserRefusal(failure("unavailable", CRASHED_PAGE_MESSAGE));
    }
    await this.#ensureSecurityDebugger(contents, scope);
    await this.rendererOperation(
      contents,
      () => installAgentPagePrivacyGuard(contents),
      { scope, phase: "privacy-guard" },
    );
  }

  async #resumeAgentPage(session: Session, tab: PreviewTab): Promise<void> {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    await this.rendererOperation(
      contents,
      () => setAgentPageFrozen(contents, false),
      { phase: "page-resume" },
    );
    const bounds = session.bounds;
    if (
      contents.isDestroyed()
      || session.tabs.get(tab.id) !== tab
      || session.activeTabId !== tab.id
      || !session.displayed
      || !bounds
      || bounds.width <= 0
      || bounds.height <= 0
      || !tab.view.getVisible()
    ) return;
    tab.view.setVisible(false);
    tab.view.setVisible(true);
  }

  async #sendInputAndWait(
    contents: PreviewContents,
    dispatch: () => void | Promise<void>,
    scope: AgentOperationScope,
    expectedClickRef?: string,
  ): Promise<Awaited<ReturnType<typeof agentPageInputRefusal>>> {
    stopForAbort(scope.signal);
    const chooserGeneration = await this.rendererOperation(
      contents,
      () => beginAgentFileChooserBlock(contents),
      { scope, phase: "input-guard", lateSuccess: (generation) => { void releaseAgentFileChooserBlock(contents, generation).catch(() => undefined); } },
    );
    try {
      await this.rendererOperation(
        contents,
        () => setAgentPageInputGuard(contents, true, expectedClickRef),
        { scope, phase: "input-guard" },
      );
      beginAgentPageInputRefusalCapture(contents);
      await settleAgentPageInput(contents, dispatch, scope.signal);
      const isolated = await this.rendererOperation(contents, () => agentPageInputRefusal(contents), { scope, phase: "input-guard" });
      return capturedAgentPageInputRefusal(contents) ?? isolated;
    } finally {
      if (!contents.isDestroyed()) {
        await this.rendererOperation(
          contents,
          () => setAgentPageInputGuard(contents, false),
          { phase: "input-guard" },
        ).catch(() => undefined);
        void releaseAgentFileChooserBlock(contents, chooserGeneration).catch(() => undefined);
      }
      endAgentPageInputRefusalCapture(contents);
    }
  }
}
