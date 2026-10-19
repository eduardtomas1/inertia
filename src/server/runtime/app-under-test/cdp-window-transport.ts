import { randomUUID } from "node:crypto";

import { agentBrowserTextLength } from "../../../shared/agent-browser";
import {
  agentPageSnapshotHasSensitiveVisualEvidence,
  serializeAgentPageSnapshot,
} from "../../../shared/agent-page-scripts";
import {
  APP_INPUT_BUDGET_MS,
  APP_INSPECT_BUDGET_MS,
  MAX_APP_EVIDENCE_THUMBNAIL_BYTES,
  MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT,
  MAX_APP_EVIDENCE_THUMBNAIL_WIDTH,
  MAX_APP_WINDOW_TITLE_CHARS,
  MAX_APP_WINDOWS,
  type AppUnderTestWindow,
} from "../../../shared/app-under-test";
import { sanitizeBrowserEvidenceText } from "../../../shared/browser-evidence";
import { CdpPipeClient, CdpPipeError, cdpFailureCode, type CdpEvent } from "./cdp-pipe-client";
import { AppWindowDialogs } from "./cdp-window-dialogs";
import {
  activationMessage,
  appWindowOrigin,
  blankUrl,
  consoleLine,
  delay,
  emptyPageMemory,
  finiteNumber,
  INTERNAL_URL,
  KEYS,
  MAX_EVALUATION_CHARS,
  MAX_LOG_TEXT_CHARS,
  MAX_APP_LOG_LINE_CHARS,
  MAX_REPORTED_SECRETS,
  MAX_QUEUED_COMMANDS,
  MAX_SCREENSHOT_ATTEMPTS,
  MAX_TARGET_TEXT_CHARS,
  MAX_WAITING_TARGETS,
  MESSAGES,
  MODIFIER_BITS,
  NAVIGATION_GRACE_MS,
  NAVIGATION_SETTLE_MS,
  PHASE_TIMEOUT_MS,
  pngDimensions,
  QUEUE_WAIT_MS,
  record,
  redactSecrets,
  withoutRedactedValues,
  redactSnapshotValue,
  Refusal,
  refusal,
  rememberSecret,
  sameTarget,
  snapshotContains,
  snapshotNextStep,
  SNAPSHOT_RESULT_BYTES,
  text,
  WAIT_BUDGET_EXTRA_MS,
  WAIT_POLL_MS,
  withheldMessage,
  type CommandKind,
  type Located,
  type PageMemory,
  type PageRead,
  type Scope,
  type WindowState,
} from "./cdp-window-support";
import {
  APP_FOCUSED_DESCRIBE_EXPRESSION,
  APP_ISOLATED_WORLD_NAME,
  APP_NEXT_FRAME_EXPRESSION,
  APP_PRESS_BEGIN_EXPRESSION,
  APP_PRESS_CONTINUE_EXPRESSION,
  APP_READY_STATE_EXPRESSION,
  APP_SNAPSHOT_EXPRESSION,
  APP_VIEWPORT_EXPRESSION,
  APP_WAIT_READ_EXPRESSION,
  appDescribeExpression,
  appLocateExpression,
  appRefHasFocusExpression,
  appRefOutsideViewportExpression,
  appRememberTypedExpression,
  appScrollRefExpression,
} from "./snapshot-script";
import type {
  AppUnderTestCdpTransportContext,
  AppUnderTestDestructiveWindowCommand,
  AppUnderTestPendingDialog,
  AppUnderTestWindowCommand,
  AppUnderTestWindowFailure,
  AppUnderTestWindowInspection,
  AppUnderTestWindowInspectionResult,
  AppUnderTestWindowPerformOptions,
  AppUnderTestWindowResult,
  AppUnderTestWindowTarget,
  AppUnderTestWindowTransport,
  CdpTransportFactory,
} from "./window-transport";

export { appWindowOrigin } from "./cdp-window-support";

/**
 * The App window transport for Electron launches: one CDP client over the
 * debugging pipe, one session per page target ("window"), and one isolated
 * world per main-frame document in which the Browser's own snapshot and ref
 * scripts run. Every value read from the app is untrusted data: it is bounded,
 * redacted and never used as an instruction, a log line of Inertia's own, or
 * an approval label beyond the sanitized control role and name.
 */

export interface CdpWindowTransportOptions {
  // Test seams; production callers omit them.
  waitPollMs?: number;
  queueWaitMs?: number;
  navigationGraceMs?: number;
  navigationSettleMs?: number;
  phaseTimeoutMs?: number;
  inspectBudgetMs?: number;
  inputBudgetMs?: number;
}

export class CdpWindowTransport implements AppUnderTestWindowTransport {
  private readonly client: CdpPipeClient;
  private readonly dialogs: AppWindowDialogs;
  private readonly windowsByTarget = new Map<string, WindowState>();
  private readonly windowsBySession = new Map<string, WindowState>();
  private readonly waitingTargets = new Map<string, { type: string; url: string }>();
  private readonly readyWaiters = new Set<() => void>();
  private readonly queue: Array<() => void> = [];
  private readonly waitPollMs: number;
  private readonly queueWaitMs: number;
  private readonly navigationGraceMs: number;
  private readonly navigationSettleMs: number;
  private readonly phaseTimeoutMs: number;
  private readonly inspectBudgetMs: number;
  private readonly inputBudgetMs: number;
  private nextWindowNumber = 1;
  /** Attachments run one at a time so they stay within the pending-request bound. */
  private attaching: Promise<void> = Promise.resolve();
  private busy = false;
  private active: { scope: Scope; abort(reason: "interrupted" | "closed" | "dialog"): void } | null = null;
  private closed = false;
  /**
   * Every secret value this launch's windows revealed, for the launch's log
   * lines and window titles. Unlike a window's memory it outlives navigation.
   */
  private readonly launchMemory: PageMemory = emptyPageMemory();

  constructor(private readonly context: AppUnderTestCdpTransportContext, options: CdpWindowTransportOptions = {}) {
    this.waitPollMs = options.waitPollMs ?? WAIT_POLL_MS;
    this.queueWaitMs = options.queueWaitMs ?? QUEUE_WAIT_MS;
    this.navigationGraceMs = options.navigationGraceMs ?? NAVIGATION_GRACE_MS;
    this.navigationSettleMs = options.navigationSettleMs ?? NAVIGATION_SETTLE_MS;
    this.phaseTimeoutMs = options.phaseTimeoutMs ?? PHASE_TIMEOUT_MS;
    this.inspectBudgetMs = options.inspectBudgetMs ?? APP_INSPECT_BUDGET_MS;
    this.inputBudgetMs = options.inputBudgetMs ?? APP_INPUT_BUDGET_MS;
    this.client = new CdpPipeClient(context.input, context.output);
    this.dialogs = new AppWindowDialogs({
      client: this.client,
      closed: () => this.closed,
      phaseTimeoutMs: this.phaseTimeoutMs,
      remaining: (scope) => this.remaining(scope),
      evaluate: async (scope, expression) => await this.evaluate(scope, expression),
      redactText: (window, value, maximum) => this.redactText(window, value, maximum),
    });
    this.client.onEvent((event) => this.onEvent(event));
    this.client.onClose(() => this.shutdown());
    this.client.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
  }

  windows(): readonly AppUnderTestWindow[] {
    const ready = this.readyWindows();
    const active = ready.reduce<WindowState | null>(
      (best, window) => !best || window.lastUsed > best.lastUsed
        || (window.lastUsed === best.lastUsed && window.openedAt > best.openedAt) ? window : best,
      null,
    );
    return ready.map((window) => ({
      windowId: window.windowId,
      launchId: this.context.launchId,
      title: this.title(window),
      origin: appWindowOrigin(window.url),
      active: window === active,
      loading: window.loading,
    }));
  }

  pendingDialog(): AppUnderTestPendingDialog | null {
    const window = this.readyWindows().find((candidate) => candidate.openDialog !== null);
    return window?.openDialog
      ? { windowId: window.windowId, windowNumber: window.windowNumber, documentSequence: window.documentSequence, kind: window.openDialog.kind }
      : null;
  }

  redactLog(text: string, cut: boolean): string {
    return redactSecrets(this.launchMemory, text, MAX_APP_LOG_LINE_CHARS, cut);
  }

  async waitForWindow(signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    if (this.readyWindows().length > 0) return true;
    if (this.closed || signal.aborted) return false;
    return await new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.readyWaiters.delete(onReady);
        resolve(value);
      };
      const onReady = (): void => finish(!this.closed && this.readyWindows().length > 0);
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      this.readyWaiters.add(onReady);
    });
  }

  async inspect(
    command: AppUnderTestDestructiveWindowCommand,
    signal: AbortSignal,
  ): Promise<AppUnderTestWindowInspectionResult> {
    const result = await this.run(command.windowId, "inspect", this.inspectBudgetMs, signal, async (scope) => {
      const inspection = await this.inspectIn(scope, command);
      return { inspection };
    });
    return result.ok ? { ok: true, inspection: result.value.inspection as AppUnderTestWindowInspection } : result;
  }

  async perform(
    command: AppUnderTestWindowCommand,
    options: AppUnderTestWindowPerformOptions,
  ): Promise<AppUnderTestWindowResult> {
    const { signal, expected } = options;
    switch (command.action) {
      case "snapshot":
        return await this.run(command.windowId, "inspect", this.inspectBudgetMs, signal, (scope) => this.snapshot(scope));
      case "screenshot":
        return await this.run(command.windowId, "inspect", this.inspectBudgetMs, signal, (scope) => this.screenshot(scope));
      case "wait":
        return await this.run(
          command.windowId, "wait", command.timeoutMs + WAIT_BUDGET_EXTRA_MS, signal,
          (scope) => this.wait(scope, command),
        );
      default:
        return await this.run(command.windowId, "input", this.inputBudgetMs, signal, async (scope) => {
          const open = scope.window.openDialog;
          if (expected && (expected.documentSequence !== scope.window.documentSequence
            || expected.dialog !== (open?.kind ?? null))) {
            throw refusal("not-found", MESSAGES.changed);
          }
          const accept = "dialog" in command && command.dialog === "accept";
          if (options.dialogOnly) {
            if (!open) throw refusal("not-found", MESSAGES.changed);
            await this.dialogs.answerOpen(scope, open, accept);
            return {
              answeredDialog: { kind: open.kind, answer: accept ? "accept" : "dismiss" },
              sent: false,
              nextStep: `Inertia answered the app's dialog but did not send the ${command.action}. Take a new inertia_app_snapshot, then try the ${command.action} again.`,
              ...await this.dialogs.detail(scope),
            };
          }
          // An input answers a dialog the app already shows, as its dialog
          // argument says (dismiss by default), before anything else is sent.
          if (open) await this.dialogs.answerOpen(scope, open, accept);
          switch (command.action) {
            case "click":
              return await this.click(scope, command, expected?.target);
            case "type":
              return await this.type(scope, command, expected?.target);
            case "press":
              return await this.press(scope, command, expected?.target);
            case "scroll":
              return await this.scroll(scope, command, expected?.target);
          }
        });
    }
  }

  close(): void {
    if (this.closed) return;
    this.client.close();
    this.shutdown();
  }

  // Command runner -----------------------------------------------------------

  private async run(
    windowId: string,
    kind: CommandKind,
    budgetMs: number,
    signal: AbortSignal,
    operation: (scope: Scope) => Promise<Record<string, unknown>>,
  ): Promise<{ ok: true; value: Record<string, unknown> } | AppUnderTestWindowFailure> {
    if (this.closed) return { ok: false, code: "unavailable", message: MESSAGES.closed, dispatched: false };
    if (signal.aborted) return { ok: false, code: "cancelled", message: "The App action was cancelled.", dispatched: false };
    if (!this.windowById(windowId)) return { ok: false, code: "not-found", message: MESSAGES.gone, dispatched: false };
    if (!await this.acquire(signal)) {
      return signal.aborted
        ? { ok: false, code: "cancelled", message: "The App action was cancelled.", dispatched: false }
        : { ok: false, code: "timeout", message: MESSAGES.busy, dispatched: false };
    }
    const window = this.windowById(windowId);
    if (!window || this.closed) {
      this.release();
      return { ok: false, code: "not-found", message: MESSAGES.gone, dispatched: false };
    }
    const controller = new AbortController();
    let reason: "deadline" | "cancelled" | "interrupted" | "closed" | "dialog" | null = null;
    const abort = (why: NonNullable<typeof reason>): void => {
      reason ??= why;
      controller.abort();
    };
    const onAbort = (): void => abort("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => abort("deadline"), budgetMs);
    timer.unref();
    const scope: Scope = {
      window,
      kind,
      signal: controller.signal,
      deadline: Date.now() + budgetMs,
      documentSequence: window.documentSequence,
      dispatched: false,
      armedAccept: false,
      interrupted: false,
      outcome: null,
      navigationStarted: false,
      navigated: false,
      closed: false,
      dialogAnswered: false,
      acceptSpent: false,
    };
    this.active = { scope, abort: (why) => abort(why) };
    window.lastUsed = Date.now();
    try {
      if (window.crashed) throw refusal("unavailable", MESSAGES.crashed);
      // A read-only command never answers a dialog, and cannot read a window
      // whose renderer a dialog blocks.
      if (kind !== "input" && window.openDialog) throw this.dialogs.refusal(window, window.openDialog);
      const value = await operation(scope);
      return {
        ok: true,
        value: scope.dispatched && scope.navigated
          ? { ...value, navigated: true, nextStep: "The window loaded a new page after the action. Take a new inertia_app_snapshot." }
          : value,
      };
    } catch (error) {
      return this.failure(error, scope, reason);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      scope.armedAccept = false;
      this.active = null;
      this.release();
    }
  }

  private failure(
    error: unknown,
    scope: Scope,
    reason: "deadline" | "cancelled" | "interrupted" | "closed" | "dialog" | null,
  ): { ok: true; value: Record<string, unknown> } | AppUnderTestWindowFailure {
    if (scope.outcome && (scope.navigated || scope.closed)) {
      // The input reached the app and the app answered it by navigating or
      // closing the window: that is the action's result, not a failure.
      return {
        ok: true,
        value: {
          ...scope.outcome,
          ...(scope.closed ? { windowClosed: true } : { navigated: true }),
          nextStep: scope.closed
            ? "The window closed after the action. Call inertia_app_windows for current windows."
            : "The window loaded a new page after the action. Take a new inertia_app_snapshot.",
        },
      };
    }
    const dispatched = scope.dispatched || scope.dialogAnswered;
    // Why the command was stopped outranks what the interrupted step threw.
    if (reason === "interrupted" || scope.interrupted) {
      return { ok: false, code: "not-found", message: MESSAGES.interrupted, dispatched };
    }
    if (reason === "cancelled") return { ok: false, code: "cancelled", message: "The App action was cancelled.", dispatched };
    if (reason === "dialog" && scope.window.openDialog) {
      const failure = this.dialogs.refusal(scope.window, scope.window.openDialog).failure;
      return { ...failure, dispatched };
    }
    if (reason === "deadline") {
      return {
        ok: false,
        code: "timeout",
        message: dispatched
          ? "The App action timed out after its input was sent. Take a new inertia_app_snapshot before repeating it."
          : "The App action timed out before anything was sent. Try again, or check inertia_app_logs.",
        dispatched,
      };
    }
    if (scope.window.crashed) return { ok: false, code: "unavailable", message: MESSAGES.crashed, dispatched };
    if (reason === "closed" || this.closed) return { ok: false, code: "unavailable", message: MESSAGES.closed, dispatched };
    if (error instanceof Refusal) return { ...error.failure, dispatched: error.failure.dispatched || dispatched };
    if (error instanceof CdpPipeError) {
      const code = cdpFailureCode(error.code);
      return {
        ok: false,
        code,
        message: code === "too-large"
          ? "The window sent more data than Inertia accepts. Take a new inertia_app_snapshot of a smaller view."
          : code === "timeout"
            ? "The window did not answer in time. Take a new inertia_app_snapshot, or check inertia_app_logs."
            : "The window could not be reached. Take a new inertia_app_snapshot, or call inertia_app_windows.",
        dispatched,
      };
    }
    return {
      ok: false,
      code: "unavailable",
      message: "The App action failed safely. Take a new inertia_app_snapshot, then try again.",
      dispatched,
    };
  }

  private async acquire(signal: AbortSignal): Promise<boolean> {
    if (!this.busy) {
      this.busy = true;
      return true;
    }
    if (this.queue.length >= MAX_QUEUED_COMMANDS) return false;
    return await new Promise<boolean>((resolve) => {
      const grant = (): void => finish(true);
      const finish = (granted: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const index = this.queue.indexOf(grant);
        if (index >= 0) this.queue.splice(index, 1);
        resolve(granted);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), this.queueWaitMs);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.busy = false;
  }

  /** Marks the moment input may reach the app; everything before it is refusable. */
  private dispatch(scope: Scope, outcome: Record<string, unknown>, armAccept = false): void {
    if (scope.signal.aborted) throw refusal("cancelled", "The App action was cancelled.");
    scope.armedAccept = armAccept;
    scope.dispatched = true;
    scope.outcome = outcome;
  }

  private remaining(scope: Scope): number {
    return Math.max(1, Math.min(this.phaseTimeoutMs, scope.deadline - Date.now()));
  }

  private async send(scope: Scope, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const { window } = scope;
    if (window.sessionId === null) throw refusal("not-found", MESSAGES.gone);
    return await this.client.send(method, params, {
      sessionId: window.sessionId,
      timeoutMs: this.remaining(scope),
      signal: scope.signal,
    });
  }

  private async world(scope: Scope): Promise<number> {
    const { window } = scope;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (window.world && window.world.documentSequence === window.documentSequence) return window.world.contextId;
      if (window.mainFrameId === null) throw refusal("not-found", MESSAGES.gone);
      const sequence = window.documentSequence;
      // One world per name and document: Chromium returns the same context
      // for a repeated request, and a new one after a navigation.
      const created = await this.send(scope, "Page.createIsolatedWorld", {
        frameId: window.mainFrameId,
        worldName: APP_ISOLATED_WORLD_NAME,
        grantUniveralAccess: false,
      });
      const contextId = finiteNumber(created.executionContextId);
      if (contextId === null) throw new CdpPipeError("protocol", "No isolated world.");
      if (window.documentSequence === sequence) {
        window.world = { contextId, documentSequence: sequence };
        return contextId;
      }
    }
    throw refusal("not-found", MESSAGES.interrupted);
  }

  /** Evaluates one of Inertia's expressions in the isolated world; never page-supplied code. */
  private async evaluate(scope: Scope, expression: string, awaitPromise = false): Promise<unknown> {
    const contextId = await this.world(scope);
    const response = await this.send(scope, "Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise,
      silent: true,
      ...(awaitPromise ? {} : { timeout: this.remaining(scope) }),
    });
    if (response.exceptionDetails !== undefined) {
      throw new CdpPipeError("remote", "The isolated world could not evaluate Inertia's script.");
    }
    const value = record(response.result)?.value;
    if (typeof value !== "string") throw new CdpPipeError("protocol", "The isolated world returned no value.");
    if (value.length > MAX_EVALUATION_CHARS) throw new CdpPipeError("too-large", "The isolated world returned too much.");
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new CdpPipeError("protocol", "The isolated world returned malformed data.");
    }
  }

  // Reads ---------------------------------------------------------------------

  private requirePage(scope: Scope): void {
    if (blankUrl(scope.window.url)) throw refusal("not-found", MESSAGES.blank);
  }

  private async readPage(scope: Scope, expression = APP_SNAPSHOT_EXPRESSION): Promise<PageRead> {
    const raw = record(await this.evaluate(scope, expression));
    const value = record(raw?.value);
    if (!raw || !value || !Array.isArray(value.elements)) {
      throw new CdpPipeError("protocol", "The snapshot was malformed.");
    }
    // Secret values the scan found reach runtime memory only. `remember` is
    // read here and never copied into anything a result is built from.
    const current = scope.window.documentSequence === scope.documentSequence;
    for (const secret of Array.isArray(raw.remember) ? raw.remember.slice(0, MAX_REPORTED_SECRETS) : []) {
      if (typeof secret !== "string") continue;
      if (current) this.remember(scope.window, secret);
      else rememberSecret(this.launchMemory, secret);
    }
    return {
      value: redactSnapshotValue(scope.window.memory, value),
      withheld: typeof raw.withheld === "string"
        ? raw.withheld.slice(0, 40)
        : scope.window.memory.evidenceWithheld ?? null,
      remembered: finiteNumber(raw.remembered) ?? 0,
      readyState: text(raw.readyState, 20),
    };
  }

  private async snapshot(scope: Scope): Promise<Record<string, unknown>> {
    const { window } = scope;
    if (blankUrl(window.url)) return { blank: true, nextStep: MESSAGES.blank, ...await this.dialogs.detail(scope) };
    const page = await this.readPage(scope);
    if (page.withheld) throw refusal("sensitive", withheldMessage(page.withheld, "Snapshots are"));
    if (window.documentSequence !== scope.documentSequence) throw refusal("not-found", MESSAGES.interrupted);
    page.value.url = appWindowOrigin(window.url) ?? "";
    const dialogs = await this.dialogs.detail(scope);
    const serialized = serializeAgentPageSnapshot(page.value, {
      ...(window.loading ? { loading: true } : {}),
      ...dialogs,
    }, { maxBytes: SNAPSHOT_RESULT_BYTES, nextStep: snapshotNextStep });
    return JSON.parse(serialized) as Record<string, unknown>;
  }

  private async wait(
    scope: Scope,
    command: Extract<AppUnderTestWindowCommand, { action: "wait" }>,
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const needle = command.text?.replace(/\s+/gu, " ").toLowerCase();
    const report = (matched: boolean, nextStep?: string): Record<string, unknown> => ({
      matched,
      waitedMs: Date.now() - startedAt,
      ...(nextStep ? { nextStep } : {}),
    });
    for (;;) {
      if (scope.signal.aborted) throw refusal("cancelled", "The App action was cancelled.");
      const { window } = scope;
      if (!this.windowsByTarget.has(window.targetId)) throw refusal("not-found", MESSAGES.gone);
      let matched = false;
      if (!blankUrl(window.url)) {
        try {
          if (command.state === "loaded") {
            matched = !window.loading && await this.evaluate(scope, APP_READY_STATE_EXPRESSION) === "complete";
          } else if (needle !== undefined) {
            const page = await this.readPage(scope, APP_WAIT_READ_EXPRESSION);
            if (page.withheld) throw refusal("sensitive", withheldMessage(page.withheld, "Waiting on text is"));
            matched = snapshotContains(page.value, needle) === (command.state === "visible");
          }
        } catch (error) {
          // A poll interrupted by the window loading a new page is retried.
          const retry = !scope.signal.aborted && (
            (error instanceof CdpPipeError && (error.code === "remote" || error.code === "protocol"))
            || (error instanceof Refusal && error.failure.message === MESSAGES.interrupted)
          );
          if (!retry) throw error;
        }
      }
      if (matched) return report(true);
      if (Date.now() - startedAt + this.waitPollMs >= command.timeoutMs) {
        return report(false, blankUrl(window.url)
          ? MESSAGES.blank
          : "The condition was not reached in time. Take a new inertia_app_snapshot to see what the window shows now.");
      }
      await delay(this.waitPollMs, scope.signal);
    }
  }

  private async screenshot(scope: Scope): Promise<Record<string, unknown>> {
    this.requirePage(scope);
    const check = async (): Promise<void> => {
      const page = await this.readPage(scope);
      if (page.withheld) throw refusal("sensitive", withheldMessage(page.withheld, "Screenshots are"));
      if (page.remembered > 0 || scope.window.memory.passwordValues.size > 0) {
        throw refusal("sensitive", "Screenshots are unavailable while this window holds a secret value. Load a new page in the app or restart it to start a new document.");
      }
      if (agentPageSnapshotHasSensitiveVisualEvidence(withoutRedactedValues(page.value))) {
        throw refusal("sensitive", "Screenshots are unavailable because the window shows a secret, or is too large for Inertia to check for one.");
      }
    };
    await check();
    const metrics = record((await this.send(scope, "Page.getLayoutMetrics")).cssVisualViewport);
    const width = Math.floor(finiteNumber(metrics?.clientWidth) ?? 0);
    const height = Math.floor(finiteNumber(metrics?.clientHeight) ?? 0);
    if (width <= 0 || height <= 0 || width > 16_384 || height > 16_384) {
      throw refusal("unavailable", "This window has nothing drawable to capture.");
    }
    // Chromium renders the reduced thumbnail itself (clip.scale), so the
    // full-size bitmap never reaches the runtime.
    let scale = Math.min(1, MAX_APP_EVIDENCE_THUMBNAIL_WIDTH / width, MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT / height);
    let thumbnail: { png: Uint8Array; width: number; height: number } | null = null;
    for (let attempt = 0; attempt < MAX_SCREENSHOT_ATTEMPTS && thumbnail === null; attempt += 1) {
      const shot = await this.send(scope, "Page.captureScreenshot", {
        format: "png",
        clip: { x: finiteNumber(metrics?.pageX) ?? 0, y: finiteNumber(metrics?.pageY) ?? 0, width, height, scale },
        captureBeyondViewport: false,
        fromSurface: true,
      });
      const data = typeof shot.data === "string" ? shot.data : "";
      const png = Buffer.from(data, "base64");
      const size = pngDimensions(png);
      if (!size) throw refusal("unavailable", "The window returned an unreadable screenshot.");
      if (size.width > MAX_APP_EVIDENCE_THUMBNAIL_WIDTH || size.height > MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT) {
        scale *= Math.min(MAX_APP_EVIDENCE_THUMBNAIL_WIDTH / size.width, MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT / size.height) * 0.98;
      } else if (png.byteLength > MAX_APP_EVIDENCE_THUMBNAIL_BYTES) {
        scale *= 0.72;
      } else {
        thumbnail = { png: new Uint8Array(png), ...size };
      }
    }
    if (!thumbnail) throw refusal("too-large", "The window could not be reduced to a local thumbnail.");
    await check();
    const evidenceId = this.context.evidence({ kind: "screenshot", ...thumbnail });
    if (!evidenceId) throw refusal("unavailable", "Inertia could not keep the screenshot as local evidence.");
    return { captured: true, evidenceId, width, height };
  }

  // Inspection and input --------------------------------------------------------

  private async locate(scope: Scope, ref: string, focus = false, replace = false): Promise<Located> {
    const value = record(await this.evaluate(scope, appLocateExpression(ref, focus, replace)));
    if (!value || value.found !== true) {
      return { found: false, blocked: false, disabled: false, editable: false, sensitive: false, role: "", label: "", x: null, y: null };
    }
    return {
      found: true,
      blocked: value.blocked === true,
      disabled: value.disabled === true,
      editable: value.editable === true,
      sensitive: value.sensitive === true,
      role: text(value.role, 50),
      label: this.redactText(scope.window, text(value.label, 300), 300),
      x: finiteNumber(value.x),
      y: finiteNumber(value.y),
    };
  }

  private async describe(scope: Scope, ref: string): Promise<AppUnderTestWindowTarget> {
    const value = record(await this.evaluate(scope, appDescribeExpression(ref)));
    if (!value || value.found !== true) throw refusal("not-found", MESSAGES.stale);
    return {
      role: text(value.role, 50),
      label: this.redactText(scope.window, text(value.label, 300), 300),
      sensitive: value.sensitive === true,
    };
  }

  private async focusedTarget(scope: Scope): Promise<AppUnderTestWindowTarget> {
    const value = record(await this.evaluate(scope, APP_FOCUSED_DESCRIBE_EXPRESSION));
    if (!value || value.found !== true) return { role: "document", label: "No focused control", sensitive: false };
    return {
      role: text(value.role, 50),
      label: this.redactText(scope.window, text(value.label, 300), 300),
      sensitive: value.sensitive === true,
    };
  }

  private async outsideViewport(scope: Scope, ref: string): Promise<boolean> {
    return await this.evaluate(scope, appRefOutsideViewportExpression(ref)) === true;
  }

  /** Locates a ref in view and enforces what any click or type requires. */
  private async locateControl(scope: Scope, ref: string, editable: boolean): Promise<Located & { x: number; y: number }> {
    const located = await this.locate(scope, ref);
    if (!located.found || located.x === null || located.y === null) throw refusal("not-found", MESSAGES.stale);
    if (located.blocked) throw refusal("invalid", MESSAGES.blocked);
    if (located.disabled) throw refusal("invalid", MESSAGES.disabled);
    if (editable && !located.editable) throw refusal("invalid", MESSAGES.notEditable);
    return located as Located & { x: number; y: number };
  }

  private async inspectIn(
    scope: Scope,
    command: AppUnderTestDestructiveWindowCommand,
  ): Promise<AppUnderTestWindowInspection> {
    const { window } = scope;
    let target: AppUnderTestWindowTarget | null = null;
    if (command.action === "click" || command.action === "type") {
      this.requirePage(scope);
      if (await this.outsideViewport(scope, command.ref)) throw refusal("not-found", MESSAGES.outside);
      const located = await this.locateControl(scope, command.ref, command.action === "type");
      target = { role: located.role, label: located.label, sensitive: located.sensitive };
    } else if (command.action === "scroll" && "ref" in command) {
      this.requirePage(scope);
      target = await this.describe(scope, command.ref);
    } else if (command.action === "press") {
      // A key goes to the focused control, so the approval names that one.
      this.requirePage(scope);
      target = await this.focusedTarget(scope);
    }
    if (window.documentSequence !== scope.documentSequence) throw refusal("not-found", MESSAGES.interrupted);
    return {
      windowId: window.windowId,
      windowNumber: window.windowNumber,
      documentSequence: window.documentSequence,
      target,
      dialog: window.openDialog?.kind ?? null,
    };
  }

  private expect(expected: AppUnderTestWindowTarget | null | undefined, actual: AppUnderTestWindowTarget): void {
    if (expected !== undefined && !sameTarget(expected, actual)) throw refusal("not-found", MESSAGES.changed);
  }

  /** Scrolls an off-screen ref into view, unless an approval bound the current view. */
  private async bringIntoView(scope: Scope, ref: string, approved: boolean): Promise<void> {
    if (!await this.outsideViewport(scope, ref)) return;
    if (approved) throw refusal("not-found", MESSAGES.changed);
    const scrolled = record(await this.evaluate(scope, appScrollRefExpression(ref)));
    if (scrolled?.found !== true) throw refusal("not-found", MESSAGES.stale);
    await this.nextFrame(scope);
  }

  private async nextFrame(scope: Scope): Promise<void> {
    await this.evaluate(scope, APP_NEXT_FRAME_EXPRESSION, true);
  }

  private async click(
    scope: Scope,
    command: Extract<AppUnderTestWindowCommand, { action: "click" }>,
    expected: AppUnderTestWindowTarget | null | undefined,
  ): Promise<Record<string, unknown>> {
    this.requirePage(scope);
    await this.bringIntoView(scope, command.ref, expected !== undefined);
    let located = await this.locateControl(scope, command.ref, false);
    this.expect(expected, located);
    for (let attempt = 0; ; attempt += 1) {
      await this.send(scope, "Input.dispatchMouseEvent", { type: "mouseMoved", x: located.x, y: located.y, button: "none", buttons: 0 });
      await this.nextFrame(scope);
      const hovered = await this.locateControl(scope, command.ref, false);
      this.expect(expected, hovered);
      if (Math.round(hovered.x) === Math.round(located.x) && Math.round(hovered.y) === Math.round(located.y)) break;
      if (attempt >= 2) throw refusal("not-found", MESSAGES.stale);
      located = hovered;
    }
    const point = { x: located.x, y: located.y, button: "left", clickCount: 1 };
    this.dispatch(scope, { clicked: command.ref }, command.dialog === "accept" && !scope.acceptSpent);
    let released = false;
    try {
      await this.send(scope, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, buttons: 1 });
      await this.send(scope, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, buttons: 0 });
      released = true;
    } finally {
      // A cancel or deadline between press and release must not leave the
      // app's button held down.
      if (!released) this.releaseMouse(scope.window, point);
    }
    await this.settle(scope);
    scope.armedAccept = false;
    return { clicked: command.ref, ...this.windowState(scope.window), ...await this.dialogs.detail(scope) };
  }

  private async type(
    scope: Scope,
    command: Extract<AppUnderTestWindowCommand, { action: "type" }>,
    expected: AppUnderTestWindowTarget | null | undefined,
  ): Promise<Record<string, unknown>> {
    this.requirePage(scope);
    await this.bringIntoView(scope, command.ref, expected !== undefined);
    const located = await this.locateControl(scope, command.ref, true);
    this.expect(expected, located);
    // A secret is remembered before anything is sent, so an app that echoes
    // it at once (console, title) is already redacted.
    if (located.sensitive) this.remember(scope.window, command.text);
    // Focus (and select everything to replace it) from the isolated world.
    const focused = await this.locate(scope, command.ref, true, command.replace);
    if (!focused.found) throw refusal("not-found", MESSAGES.lostFocus);
    this.expect(expected, focused);
    if (await this.evaluate(scope, appRefHasFocusExpression(command.ref)) !== true) {
      throw refusal("not-found", MESSAGES.lostFocus);
    }
    const characters = agentBrowserTextLength(command.text);
    this.dispatch(scope, { typed: command.ref, characters });
    await this.send(scope, "Input.insertText", { text: command.text });
    // Text typed into a password or credential-named field is remembered for
    // this document in the isolated world too, and redacted from later
    // snapshots, titles, dialogs and console lines.
    if (await this.evaluate(scope, appRememberTypedExpression(command.ref, command.text)) === true) {
      this.remember(scope.window, command.text);
    }
    await this.settle(scope);
    return {
      typed: command.ref,
      characters,
      ...this.windowState(scope.window),
      ...await this.dialogs.detail(scope),
    };
  }

  private async press(
    scope: Scope,
    command: Extract<AppUnderTestWindowCommand, { action: "press" }>,
    expected: AppUnderTestWindowTarget | null | undefined,
  ): Promise<Record<string, unknown>> {
    this.requirePage(scope);
    if (expected !== undefined) this.expect(expected, await this.focusedTarget(scope));
    const [prefix, name] = command.key.includes("+") ? command.key.split("+") as [string, string] : [null, command.key];
    const key = KEYS[name];
    if (!key) throw refusal("invalid", "That key is not one Inertia can press.");
    const modifiers = prefix === null ? 0 : MODIFIER_BITS[prefix as keyof typeof MODIFIER_BITS] ?? 0;
    const shortcut = prefix === "Control" || prefix === "Meta";
    const event = {
      key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers,
    };
    const activation = name === "Enter" || name === "Space";
    if (activation) {
      const blocked = await this.evaluate(scope, APP_PRESS_BEGIN_EXPRESSION);
      if (typeof blocked === "string") throw refusal("invalid", activationMessage(blocked));
    }
    this.dispatch(scope, { pressed: command.key }, command.dialog === "accept" && !scope.acceptSpent);
    await this.send(scope, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
    if (activation) {
      await this.nextFrame(scope);
      const refused = await this.evaluate(scope, APP_PRESS_CONTINUE_EXPRESSION);
      if (typeof refused === "string") {
        await this.send(scope, "Input.dispatchKeyEvent", { type: "keyUp", ...event });
        throw refusal(refused === "retargeted" ? "not-found" : "invalid", activationMessage(refused), true);
      }
      if (!shortcut && key.text) {
        await this.send(scope, "Input.dispatchKeyEvent", { type: "char", ...event, text: key.text, unmodifiedText: key.text });
      }
    }
    await this.send(scope, "Input.dispatchKeyEvent", { type: "keyUp", ...event });
    await this.settle(scope);
    scope.armedAccept = false;
    return { pressed: command.key, ...this.windowState(scope.window), ...await this.dialogs.detail(scope) };
  }

  private async scroll(
    scope: Scope,
    command: Extract<AppUnderTestWindowCommand, { action: "scroll" }>,
    expected: AppUnderTestWindowTarget | null | undefined,
  ): Promise<Record<string, unknown>> {
    this.requirePage(scope);
    if ("ref" in command) {
      this.expect(expected, await this.describe(scope, command.ref));
      this.dispatch(scope, { scrolled: command.ref });
      const scrolled = record(await this.evaluate(scope, appScrollRefExpression(command.ref)));
      if (scrolled?.found !== true) throw refusal("not-found", MESSAGES.stale, true);
      await this.nextFrame(scope);
      return { scrolled: command.ref, viewport: await this.viewport(scope) };
    }
    const before = await this.viewport(scope);
    const x = Math.max(0, Math.floor((before.width ?? 0) / 2));
    const y = Math.max(0, Math.floor((before.height ?? 0) / 2));
    this.dispatch(scope, { scrolled: command.deltaY });
    await this.send(scope, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: command.deltaY });
    // Wheel scrolling can animate; report the viewport once it stops moving.
    let viewport = await this.viewport(scope);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await this.nextFrame(scope);
      const next = await this.viewport(scope);
      const settled = next.scrollY === viewport.scrollY && next.scrollX === viewport.scrollX;
      viewport = next;
      if (settled && attempt > 0) break;
    }
    return { scrolled: command.deltaY, viewport };
  }

  private async viewport(scope: Scope): Promise<Record<string, number>> {
    const value = record(await this.evaluate(scope, APP_VIEWPORT_EXPRESSION)) ?? {};
    return Object.fromEntries(["width", "height", "scrollX", "scrollY"].flatMap((key) => {
      const candidate = finiteNumber(value[key]);
      return candidate === null ? [] : [[key, candidate]];
    }));
  }

  /** After input: a short grace for a navigation to start, then its bounded load. */
  private async settle(scope: Scope): Promise<void> {
    await delay(this.navigationGraceMs, scope.signal);
    const until = Math.min(scope.deadline - 1_000, Date.now() + this.navigationSettleMs);
    while (scope.navigationStarted && scope.window.loading && !scope.closed
      && Date.now() < until && !scope.signal.aborted) {
      await delay(50, scope.signal);
    }
  }

  private windowState(window: WindowState): Record<string, unknown> {
    return { title: this.title(window), origin: appWindowOrigin(window.url), loading: window.loading };
  }

  /** Best effort, without the command's signal: a cancelled click still lets go. */
  private releaseMouse(window: WindowState, point: Record<string, unknown>): void {
    if (this.closed || window.sessionId === null) return;
    this.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, buttons: 0 }, {
      sessionId: window.sessionId,
      timeoutMs: 2_000,
    }).catch(() => undefined);
  }

  // Redaction ---------------------------------------------------------------------

  /** Remembers a secret for this document and for the launch's logs and titles. */
  private remember(window: WindowState, value: string): void {
    rememberSecret(window.memory, value);
    rememberSecret(this.launchMemory, value);
  }

  private redactText(window: WindowState, value: string, maximum: number): string {
    return redactSecrets(this.launchMemory, redactSecrets(window.memory, value, maximum), maximum);
  }

  /** Log lines also pass the launch's redaction (redactLog) when they are committed. */
  private redactLine(window: WindowState, value: string): string {
    return redactSecrets(window.memory, value, MAX_LOG_TEXT_CHARS);
  }

  private title(window: WindowState): string {
    // Chromium reports the address as the title until the page sets one.
    const raw = window.title === window.url ? "" : window.title;
    return sanitizeBrowserEvidenceText(
      this.redactText(window, raw, MAX_APP_WINDOW_TITLE_CHARS * 4),
      "App window",
      MAX_APP_WINDOW_TITLE_CHARS,
    ).text;
  }

  // Window registry and events -------------------------------------------------------

  private readyWindows(): WindowState[] {
    return [...this.windowsByTarget.values()]
      .filter((window) => window.ready)
      .sort((left, right) => left.windowNumber - right.windowNumber);
  }

  private windowById(windowId: string): WindowState | null {
    for (const window of this.windowsByTarget.values()) {
      if (window.windowId === windowId && window.ready) return window;
    }
    return null;
  }

  private changed(): void {
    if (this.closed) return;
    for (const waiter of this.readyWaiters) waiter();
    this.context.windowsChanged();
  }

  private onEvent(event: CdpEvent): void {
    if (this.closed) return;
    if (event.sessionId !== undefined) {
      const window = this.windowsBySession.get(event.sessionId);
      if (window) this.onSessionEvent(window, event);
      return;
    }
    const info = record(event.params.targetInfo);
    switch (event.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
        if (info) this.onTargetInfo(info);
        break;
      case "Target.targetDestroyed":
        this.removeTarget(text(event.params.targetId, 256));
        break;
      case "Target.detachedFromTarget": {
        const window = this.windowsBySession.get(text(event.params.sessionId, 256));
        if (window) this.removeTarget(window.targetId);
        break;
      }
      case "Target.targetCrashed": {
        const window = this.windowsByTarget.get(text(event.params.targetId, 256));
        if (window) this.onCrash(window);
        break;
      }
    }
  }

  private onTargetInfo(info: Record<string, unknown>): void {
    const targetId = text(info.targetId, 256);
    const type = text(info.type, 64);
    const url = text(info.url, MAX_TARGET_TEXT_CHARS);
    if (!targetId) return;
    const existing = this.windowsByTarget.get(targetId);
    if ((existing || this.waitingTargets.has(targetId)) && (type !== "page" || INTERNAL_URL.test(url))) {
      // A window that becomes DevTools or another internal page is no longer the app's.
      this.removeTarget(targetId);
      if (existing?.sessionId) {
        this.client.send("Target.detachFromTarget", { sessionId: existing.sessionId }).catch(() => undefined);
      }
      return;
    }
    if (existing) {
      const title = text(info.title, MAX_TARGET_TEXT_CHARS);
      if (title !== existing.title || url !== existing.url) {
        existing.title = title;
        existing.url = url;
        if (existing.ready) this.changed();
      }
      return;
    }
    if (type !== "page" || INTERNAL_URL.test(url)) return;
    if (this.windowsByTarget.size >= MAX_APP_WINDOWS) {
      if (this.waitingTargets.size < MAX_WAITING_TARGETS) this.waitingTargets.set(targetId, { type, url });
      return;
    }
    this.waitingTargets.delete(targetId);
    this.attach(targetId, text(info.title, MAX_TARGET_TEXT_CHARS), url);
  }

  private attach(targetId: string, title: string, url: string): void {
    const window: WindowState = {
      windowId: randomUUID(),
      windowNumber: this.nextWindowNumber++,
      targetId,
      openedAt: Date.now(),
      sessionId: null,
      ready: false,
      title,
      url,
      loading: true,
      mainFrameId: null,
      documentSequence: 1,
      world: null,
      memory: emptyPageMemory(),
      dialogs: [],
      dialogsOmitted: 0,
      openDialog: null,
      answering: null,
      crashed: false,
      refreshing: false,
      lastUsed: 0,
    };
    this.windowsByTarget.set(targetId, window);
    this.attaching = this.attaching.then(() => this.connect(window));
  }

  private async connect(window: WindowState): Promise<void> {
    const { targetId } = window;
    if (this.closed || this.windowsByTarget.get(targetId) !== window) return;
    try {
      const attached = await this.client.send("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = text(attached.sessionId, 256);
      if (!sessionId || this.windowsByTarget.get(targetId) !== window) throw new Error("detached");
      window.sessionId = sessionId;
      this.windowsBySession.set(sessionId, window);
      const options = { sessionId };
      await Promise.all([
        this.client.send("Page.enable", {}, options),
        this.client.send("Runtime.enable", {}, options),
        this.client.send("Log.enable", {}, options),
      ]);
      const tree = record(record((await this.client.send("Page.getFrameTree", {}, options)).frameTree)?.frame);
      if (this.windowsByTarget.get(targetId) !== window || !tree) throw new Error("detached");
      window.mainFrameId ??= text(tree.id, 256) || null;
      if (typeof tree.url === "string") window.url = tree.url.slice(0, MAX_TARGET_TEXT_CHARS);
      window.ready = window.mainFrameId !== null;
      if (window.ready) this.changed();
    } catch {
      if (this.windowsByTarget.get(targetId) === window) this.removeTarget(targetId);
    }
  }

  private removeTarget(targetId: string): void {
    this.waitingTargets.delete(targetId);
    const window = this.windowsByTarget.get(targetId);
    if (!window) return;
    this.windowsByTarget.delete(targetId);
    if (window.sessionId !== null) this.windowsBySession.delete(window.sessionId);
    const active = this.active;
    if (active?.scope.window === window) {
      active.scope.closed = true;
      if (!active.scope.dispatched) active.scope.interrupted = true;
      active.abort("interrupted");
    }
    const [next] = this.waitingTargets;
    if (next) {
      this.waitingTargets.delete(next[0]);
      this.attach(next[0], "", next[1].url);
    }
    if (window.ready) this.changed();
  }

  private onCrash(window: WindowState): void {
    if (window.crashed) return;
    window.crashed = true;
    this.context.log("crash", `App window ${window.windowNumber} crashed.`);
    const active = this.active;
    if (active?.scope.window === window) active.abort("closed");
  }

  private onSessionEvent(window: WindowState, event: CdpEvent): void {
    const { params } = event;
    switch (event.method) {
      case "Page.frameNavigated": {
        const frame = record(params.frame);
        if (!frame || (frame.parentId !== undefined && frame.parentId !== null)) return;
        window.mainFrameId = text(frame.id, 256) || window.mainFrameId;
        window.url = text(frame.url, MAX_TARGET_TEXT_CHARS);
        this.onNewDocument(window);
        if (window.ready) this.changed();
        return;
      }
      case "Page.frameStartedNavigating":
        if (text(params.frameId, 256) === window.mainFrameId) this.onNavigationStarted(window);
        return;
      case "Page.frameStartedLoading":
      case "Page.frameStoppedLoading": {
        if (text(params.frameId, 256) !== window.mainFrameId) return;
        const loading = event.method === "Page.frameStartedLoading";
        if (loading) this.onNavigationStarted(window);
        if (loading !== window.loading) {
          window.loading = loading;
          if (window.ready) this.changed();
        }
        return;
      }
      case "Page.domContentEventFired":
      case "Page.loadEventFired":
      case "Page.navigatedWithinDocument":
        this.refreshTargetInfo(window);
        return;
      case "Page.javascriptDialogOpening":
        this.dialogs.onDialog(window, params, this.active?.scope.window === window ? this.active : null);
        return;
      case "Page.javascriptDialogClosed":
        window.openDialog = null;
        return;
      case "Runtime.executionContextDestroyed":
        if (window.world && finiteNumber(params.executionContextId) === window.world.contextId) window.world = null;
        return;
      case "Runtime.executionContextsCleared":
        window.world = null;
        return;
      case "Runtime.consoleAPICalled":
        this.onConsole(window, params);
        return;
      case "Runtime.exceptionThrown": {
        const details = record(params.exceptionDetails);
        const description = text(record(details?.exception)?.description, MAX_LOG_TEXT_CHARS)
          || text(details?.text, MAX_LOG_TEXT_CHARS) || "Uncaught exception";
        this.context.log("exception", this.redactLine(window, description));
        return;
      }
      case "Log.entryAdded": {
        const entry = record(params.entry);
        const level = text(entry?.level, 16);
        const message = text(entry?.text, MAX_LOG_TEXT_CHARS);
        if (!message || level === "verbose") return;
        this.context.log("console", this.redactLine(window, `${level || "info"}: ${message}`));
        return;
      }
      case "Inspector.targetCrashed":
        this.onCrash(window);
        return;
    }
  }

  /** Chromium does not report every document title change; ask after loads. */
  private refreshTargetInfo(window: WindowState): void {
    if (window.refreshing) return;
    window.refreshing = true;
    this.client.send("Target.getTargetInfo", { targetId: window.targetId })
      .then((result) => {
        const info = record(result.targetInfo);
        if (info && this.windowsByTarget.get(window.targetId) === window) this.onTargetInfo(info);
      })
      .catch(() => undefined)
      .finally(() => { window.refreshing = false; });
  }

  private onNavigationStarted(window: WindowState): void {
    const scope = this.active?.scope;
    if (scope?.window === window && scope.dispatched) scope.navigationStarted = true;
  }

  /** A main-frame navigation replaced the document: refs, world and memory go with it. */
  private onNewDocument(window: WindowState): void {
    window.documentSequence += 1;
    window.world = null;
    window.memory = emptyPageMemory();
    window.openDialog = null;
    window.crashed = false;
    const active = this.active;
    if (active?.scope.window === window) {
      if (active.scope.kind === "wait") return;
      active.scope.navigated = true;
      active.scope.navigationStarted = true;
      if (!active.scope.dispatched) {
        active.scope.interrupted = true;
        active.abort("interrupted");
      }
    }
  }

  private onConsole(window: WindowState, params: Record<string, unknown>): void {
    if (window.world && finiteNumber(params.executionContextId) === window.world.contextId) return;
    this.context.log("console", this.redactLine(window, consoleLine(params)));
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.active?.abort("closed");
    this.windowsByTarget.clear();
    this.windowsBySession.clear();
    this.waitingTargets.clear();
    for (const waiter of this.readyWaiters) waiter();
    this.readyWaiters.clear();
    for (const waiter of this.queue.splice(0)) waiter();
    this.context.windowsChanged();
  }
}

export function createCdpTransportFactory(options: CdpWindowTransportOptions = {}): CdpTransportFactory {
  return Object.freeze({
    create(context: AppUnderTestCdpTransportContext): AppUnderTestWindowTransport {
      return new CdpWindowTransport(context, options);
    },
  });
}
