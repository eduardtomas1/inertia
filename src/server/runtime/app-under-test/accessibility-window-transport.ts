import { randomUUID } from "node:crypto";

import {
  appControlFailure,
  type AppControlCommand,
  type AppControlElementInfo,
  type AppControlExpectation,
  type AppControlFailure,
  type AppControlRect,
  type AppControlResult,
  type AppControlValue,
} from "../../../node/runtime-app-control-protocol.js";
import { agentBrowserTextLength } from "../../../shared/agent-browser";
import { serializeAgentPageSnapshot } from "../../../shared/agent-page-scripts";
import {
  APP_INPUT_BUDGET_MS,
  APP_INSPECT_BUDGET_MS,
  MAX_APP_WINDOW_TITLE_CHARS,
  MAX_APP_WINDOWS,
  type AppUnderTestWindow,
  type AppUnderTestWindowAccessGate,
} from "../../../shared/app-under-test";
import { sanitizeBrowserEvidenceText } from "../../../shared/browser-evidence";
import {
  ACCESSIBILITY_MESSAGES,
  accessibilityFailure,
  clickAction,
  gateCategory,
  keyAction,
} from "./accessibility-window-support";
import type { RuntimeAppControlBroker } from "./app-control-broker-client";
import {
  delay,
  emptyPageMemory,
  MAX_APP_LOG_LINE_CHARS,
  redactSecrets,
  rememberSecret,
  sameTarget,
  snapshotContains,
  snapshotNextStep,
  SNAPSHOT_RESULT_BYTES,
  WAIT_BUDGET_EXTRA_MS,
  type PageMemory,
} from "./cdp-window-support";
import type {
  AccessibilityTransportFactory,
  AppUnderTestAccessibilityTransportContext,
  AppUnderTestDestructiveWindowCommand,
  AppUnderTestPendingDialog,
  AppUnderTestTransportStatus,
  AppUnderTestTurn,
  AppUnderTestWindowCommand,
  AppUnderTestWindowFailure,
  AppUnderTestWindowInspection,
  AppUnderTestWindowInspectionResult,
  AppUnderTestWindowPerformOptions,
  AppUnderTestWindowResult,
  AppUnderTestWindowTarget,
  AppUnderTestWindowTransport,
} from "./window-transport";

/**
 * The App window transport for action launches without a debugging pipe: the
 * operating system's accessibility API, reached through main's App control
 * broker. The runtime never loads the native binding. Windows of the launch's
 * owned process tree get Inertia-minted ids; refs bind to the worker's
 * element tokens per window and document sequence, which increments when the
 * window's root changes identity. Ref numbers keep counting up per window
 * across documents and only snapshots mint them, so a ref never names a
 * control of another document. One native command runs at a time per
 * launch. Window text is untrusted data: bounded, redacted, and never used as
 * an instruction or an approval label beyond the sanitized control role and name.
 */

export interface AccessibilityWindowTransportOptions {
  // Test seams; production callers omit them.
  pollMs?: number;
  waitPollMs?: number;
  queueWaitMs?: number;
  platform?: NodeJS.Platform;
}

interface NativeWindowState {
  readonly windowId: string;
  readonly windowNumber: number;
  readonly token: string;
  readonly openedAt: number;
  pid: number;
  title: string;
  bounds: AppControlRect | null;
  documentSequence: number;
  rootKey: string | null;
  refs: Map<string, string>;
  tokens: Map<string, string>;
  /** Increases for the window's lifetime, across documents. */
  nextRef: number;
  /** Values the agent typed into sensitive controls of this window. */
  memory: PageMemory;
  lastUsed: number;
}

const POLL_MS = 2_000;
const GATED_POLL_MS = 10_000;
const WAIT_POLL_MS = 500;
const QUEUE_WAIT_MS = 30_000;
const MAX_QUEUED = 16;
const MAX_REFS_PER_WINDOW = 4_096;

class Refused extends Error {
  constructor(readonly failure: AppUnderTestWindowFailure) {
    super(failure.message);
  }
}

function refused(code: AppUnderTestWindowFailure["code"], message: string, dispatched = false): Refused {
  return new Refused({ ok: false, code, message, dispatched });
}

export class AccessibilityWindowTransport implements AppUnderTestWindowTransport {
  private readonly byToken = new Map<string, NativeWindowState>();
  private readonly launchMemory: PageMemory = emptyPageMemory();
  private readonly closer = new AbortController();
  private readonly queue: Array<() => void> = [];
  private readonly platform: NodeJS.Platform;
  private readonly pollMs: number;
  private readonly waitPollMs: number;
  private readonly queueWaitMs: number;
  private nextWindowNumber = 1;
  private busy = false;
  private closed = false;
  private poller: NodeJS.Timeout | null = null;
  /** A background window read is in flight; it reschedules itself when it ends. */
  private polling = false;
  private gate: string | null = null;
  private gateKind: AppUnderTestWindowAccessGate | null = null;
  /** Apps of the launch's tree that Inertia never reads; the worker lists each once. */
  private protectedApps = 0;

  constructor(
    private readonly context: AppUnderTestAccessibilityTransportContext,
    private readonly broker: RuntimeAppControlBroker,
    options: AccessibilityWindowTransportOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.pollMs = options.pollMs ?? POLL_MS;
    this.waitPollMs = options.waitPollMs ?? WAIT_POLL_MS;
    this.queueWaitMs = options.queueWaitMs ?? QUEUE_WAIT_MS;
    if (this.watched()) this.schedulePoll(0);
  }

  windows(): readonly AppUnderTestWindow[] {
    const windows = this.ordered();
    const active = windows.reduce<NativeWindowState | null>(
      (best, window) => !best || window.lastUsed > best.lastUsed
        || (window.lastUsed === best.lastUsed && window.openedAt > best.openedAt) ? window : best,
      null,
    );
    return windows.map((window) => ({
      windowId: window.windowId,
      launchId: this.context.launchId,
      title: this.title(window),
      origin: null,
      active: window === active,
      loading: false,
    }));
  }

  pendingDialog(): AppUnderTestPendingDialog | null {
    return null;
  }

  status(): AppUnderTestTransportStatus {
    return { unavailable: this.gate, protectedApps: this.protectedApps, access: this.gateKind };
  }

  /**
   * Starts background window polling when the chat gained a live subscriber
   * or an active turn, and stops it when it has neither. A watched launch
   * reads its windows at once.
   */
  watchChanged(): void {
    if (this.closed) return;
    if (!this.watched()) {
      if (this.poller) clearTimeout(this.poller);
      this.poller = null;
      return;
    }
    if (!this.poller && !this.polling) this.schedulePoll(0);
  }

  redactLog(text: string, cut: boolean): string {
    return redactSecrets(this.launchMemory, text, MAX_APP_LOG_LINE_CHARS, cut);
  }

  /** Re-reads the window list; `turn` is the agent turn asking, absent for background polling. */
  async refreshWindows(signal: AbortSignal, turn?: AppUnderTestTurn): Promise<void> {
    await this.exclusive(signal, async () => { await this.readWindows(signal, turn); }).catch(() => undefined);
  }

  async waitForWindow(signal: AbortSignal, timeoutMs: number, turn?: AppUnderTestTurn): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (this.byToken.size > 0) return true;
      if (this.closed || signal.aborted || this.gate !== null) return false;
      await this.refreshWindows(signal, turn);
      if (this.byToken.size > 0) return true;
      if (this.gate !== null || Date.now() + this.waitPollMs >= deadline) return this.byToken.size > 0;
      await delay(this.waitPollMs, signal);
    }
  }

  async inspect(
    command: AppUnderTestDestructiveWindowCommand,
    signal: AbortSignal,
    turn?: AppUnderTestTurn,
  ): Promise<AppUnderTestWindowInspectionResult> {
    const result = await this.run(command.windowId, APP_INSPECT_BUDGET_MS, signal, async (window, scoped) => {
      const { inspection } = await this.inspectIn(window, command, scoped, turn);
      return { inspection };
    });
    return result.ok ? { ok: true, inspection: result.value.inspection as AppUnderTestWindowInspection } : result;
  }

  async perform(command: AppUnderTestWindowCommand, options: AppUnderTestWindowPerformOptions): Promise<AppUnderTestWindowResult> {
    const { signal, turn } = options;
    switch (command.action) {
      case "snapshot":
        return await this.run(command.windowId, APP_INSPECT_BUDGET_MS, signal, (window, scoped) => this.snapshot(window, scoped, turn));
      case "screenshot":
        return await this.run(command.windowId, APP_INSPECT_BUDGET_MS, signal, (window, scoped) => this.screenshot(window, scoped, turn));
      case "wait":
        return await this.run(command.windowId, command.timeoutMs + WAIT_BUDGET_EXTRA_MS, signal, (window, scoped) => this.wait(window, command, scoped, turn));
      default:
        return await this.run(command.windowId, APP_INPUT_BUDGET_MS, signal, (window, scoped) => this.act(window, command, options, scoped));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.poller) clearTimeout(this.poller);
    this.poller = null;
    this.closer.abort();
    for (const waiter of this.queue.splice(0)) waiter();
    if (this.byToken.size > 0) {
      this.byToken.clear();
      this.context.windowsChanged();
    }
  }

  // Command runner ----------------------------------------------------------------

  private async run(
    windowId: string,
    budgetMs: number,
    signal: AbortSignal,
    operation: (window: NativeWindowState, scoped: AbortSignal) => Promise<Record<string, unknown>>,
  ): Promise<AppUnderTestWindowResult> {
    if (this.closed) return { ok: false, code: "unavailable", message: ACCESSIBILITY_MESSAGES.unavailable, dispatched: false };
    if (signal.aborted) return { ok: false, code: "cancelled", message: "The App action was cancelled.", dispatched: false };
    if (!this.windowById(windowId)) return { ok: false, code: "not-found", message: ACCESSIBILITY_MESSAGES.gone, dispatched: false };
    const deadline = AbortSignal.timeout(budgetMs);
    const scoped = AbortSignal.any([signal, deadline, this.closer.signal]);
    try {
      const value = await this.exclusive(scoped, async () => {
        const window = this.windowById(windowId);
        if (!window) throw refused("not-found", ACCESSIBILITY_MESSAGES.gone);
        window.lastUsed = Date.now();
        return await operation(window, scoped);
      });
      return { ok: true, value };
    } catch (error) {
      if (error instanceof Refused) {
        if (error.failure.code === "cancelled" && !signal.aborted && this.closed) {
          return { ok: false, code: "unavailable", message: ACCESSIBILITY_MESSAGES.unavailable, dispatched: error.failure.dispatched };
        }
        if (error.failure.code === "cancelled" && deadline.aborted && !signal.aborted) {
          return {
            ok: false,
            code: "timeout",
            message: error.failure.dispatched ? ACCESSIBILITY_MESSAGES.timeoutAfter : ACCESSIBILITY_MESSAGES.timeoutBefore,
            dispatched: error.failure.dispatched,
          };
        }
        return error.failure;
      }
      return { ok: false, code: "unavailable", message: ACCESSIBILITY_MESSAGES.nativeFailure, dispatched: false };
    }
  }

  /** One native command at a time per launch; a later one waits at most 30 seconds. */
  private async exclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (!await this.acquire(signal)) {
      throw signal.aborted
        ? refused("cancelled", "The App action was cancelled.")
        : refused("timeout", ACCESSIBILITY_MESSAGES.busy);
    }
    try {
      if (this.closed) throw refused("unavailable", ACCESSIBILITY_MESSAGES.unavailable);
      return await operation();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.busy = false;
    }
  }

  private async acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (!this.busy) {
      this.busy = true;
      return true;
    }
    if (this.queue.length >= MAX_QUEUED) return false;
    return await new Promise<boolean>((resolve) => {
      const grant = (): void => finish(!this.closed);
      const finish = (granted: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const index = this.queue.indexOf(grant);
        if (index >= 0) this.queue.splice(index, 1);
        // A grant that arrives as the waiter gives up passes the turn on.
        if (!granted && index < 0 && !this.closed) {
          const next = this.queue.shift();
          if (next) next();
          else this.busy = false;
        }
        resolve(granted);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), this.queueWaitMs);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  private async request(command: AppControlCommand, signal: AbortSignal, turn?: AppUnderTestTurn): Promise<AppControlResult> {
    return await this.broker.perform({
      conversationId: this.context.conversationId,
      runId: turn?.runId ?? null,
      turnId: turn?.turnId ?? null,
      launchId: this.context.launchId,
      pid: this.context.pid,
      processStartedAt: this.context.processStartedAt,
    }, command, signal);
  }

  /** Sends one command and returns its value, or throws the mapped refusal. */
  private async ask<K extends AppControlValue["kind"]>(
    command: AppControlCommand,
    kind: K,
    signal: AbortSignal,
    turn?: AppUnderTestTurn,
  ): Promise<Extract<AppControlValue, { kind: K }>> {
    const result = await this.request(command, signal, turn);
    if (!result.ok) {
      this.setGate(result);
      throw new Refused(accessibilityFailure(result, this.platform));
    }
    if (result.value.kind !== kind) throw new Refused(accessibilityFailure(appControlFailure("native-failure"), this.platform));
    return result.value as Extract<AppControlValue, { kind: K }>;
  }

  private watched(): boolean {
    return this.context.watched?.() ?? true;
  }

  /** Records a gate (or its end) and tells the launch manager, which republishes the launch. */
  private setGate(failure: AppControlFailure | null): void {
    const kind = failure ? gateCategory(failure) : null;
    if (failure && kind === null) return;
    const message = failure ? accessibilityFailure(failure, this.platform).message : null;
    if (kind === this.gateKind && message === this.gate) return;
    this.gate = message;
    this.gateKind = kind;
    this.context.windowsChanged();
  }

  // Window registry -----------------------------------------------------------------

  private schedulePoll(ms: number): void {
    if (this.closed) return;
    this.poller = setTimeout(() => {
      this.poller = null;
      void this.poll();
    }, ms);
    this.poller.unref();
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    this.polling = true;
    try {
      // A background read never waits behind an agent command.
      if (!this.busy && this.watched()) await this.refreshWindows(this.closer.signal);
    } finally {
      this.polling = false;
    }
    // Nobody is looking and no turn runs: stop until watchChanged() starts it again.
    if (this.watched()) this.schedulePoll(this.gate === null ? this.pollMs : GATED_POLL_MS);
  }

  private async readWindows(signal: AbortSignal, turn?: AppUnderTestTurn): Promise<void> {
    const result = await this.request({ command: "windows" }, signal, turn);
    if (this.closed) return;
    if (!result.ok) {
      this.setGate(result);
      return;
    }
    if (result.value.kind !== "windows") return;
    this.setGate(null);
    const protectedApps = result.value.windows.filter((window) => window.denied).length;
    let changed = protectedApps !== this.protectedApps;
    this.protectedApps = protectedApps;
    const listed = result.value.windows.filter((window) => !window.denied && window.token !== null);
    for (const token of this.byToken.keys()) {
      if (!listed.some((entry) => entry.token === token)) {
        this.byToken.delete(token);
        changed = true;
      }
    }
    for (const entry of listed) {
      const existing = this.byToken.get(entry.token!);
      if (existing) {
        if (existing.title !== entry.title || JSON.stringify(existing.bounds) !== JSON.stringify(entry.bounds)) changed = true;
        existing.title = entry.title;
        existing.bounds = entry.bounds;
        existing.pid = entry.pid;
        continue;
      }
      if (this.byToken.size >= MAX_APP_WINDOWS) continue;
      this.byToken.set(entry.token!, {
        windowId: randomUUID(),
        windowNumber: this.nextWindowNumber++,
        token: entry.token!,
        openedAt: Date.now(),
        pid: entry.pid,
        title: entry.title,
        bounds: entry.bounds,
        documentSequence: 1,
        rootKey: null,
        refs: new Map(),
        tokens: new Map(),
        nextRef: 1,
        memory: emptyPageMemory(),
        lastUsed: 0,
      });
      changed = true;
    }
    if (changed) this.context.windowsChanged();
  }

  private ordered(): NativeWindowState[] {
    return [...this.byToken.values()].sort((left, right) => left.windowNumber - right.windowNumber);
  }

  private windowById(windowId: string): NativeWindowState | null {
    for (const window of this.byToken.values()) if (window.windowId === windowId) return window;
    return null;
  }

  /** A changed root identity is a new document: its refs go with it, and numbering carries on. */
  private observeRoot(window: NativeWindowState, rootKey: string | null): boolean {
    if (rootKey === null || rootKey === window.rootKey) return false;
    const replaced = window.rootKey !== null;
    if (replaced) {
      window.documentSequence += 1;
      window.refs.clear();
      window.tokens.clear();
    }
    window.rootKey = rootKey;
    return replaced;
  }

  private refFor(window: NativeWindowState, token: string): string {
    const known = window.tokens.get(token);
    if (known) return known;
    if (window.refs.size >= MAX_REFS_PER_WINDOW) {
      window.refs.clear();
      window.tokens.clear();
    }
    const ref = `e${window.nextRef++}`;
    window.refs.set(ref, token);
    window.tokens.set(token, ref);
    return ref;
  }

  private forget(window: NativeWindowState): void {
    if (this.byToken.get(window.token) === window) {
      this.byToken.delete(window.token);
      this.context.windowsChanged();
    }
  }

  // Reads ---------------------------------------------------------------------------------

  private redactText(window: NativeWindowState, value: string, maximum: number): string {
    return redactSecrets(this.launchMemory, redactSecrets(window.memory, value, maximum), maximum);
  }

  private title(window: NativeWindowState): string {
    return sanitizeBrowserEvidenceText(
      this.redactText(window, window.title, MAX_APP_WINDOW_TITLE_CHARS * 4),
      "App window",
      MAX_APP_WINDOW_TITLE_CHARS,
    ).text;
  }

  /** Reads the window; only a snapshot (`mint`) hands out refs, a wait poll never does. */
  private async read(
    window: NativeWindowState,
    signal: AbortSignal,
    turn: AppUnderTestTurn | undefined,
    mint: boolean,
  ): Promise<Record<string, unknown>> {
    let value: Extract<AppControlValue, { kind: "snapshot" }>;
    try {
      value = await this.ask({ command: "snapshot", window: window.token }, "snapshot", signal, turn);
    } catch (error) {
      if (error instanceof Refused && error.failure.message === ACCESSIBILITY_MESSAGES.gone) this.forget(window);
      throw error;
    }
    this.observeRoot(window, value.rootKey);
    window.title = value.title;
    window.bounds = value.bounds;
    const redact = (text: string, maximum: number): string => this.redactText(window, text, maximum);
    const elements = value.elements.map((element) => ({
      ...(mint ? { ref: this.refFor(window, element.token) } : {}),
      role: element.role,
      name: redact(element.name, 300),
      ...(element.value === null ? {} : { value: element.sensitive ? "[redacted]" : redact(element.value, 500) }),
      enabled: element.enabled,
      ...(element.focused ? { focused: true } : {}),
      ...(element.checked === null ? {} : { checked: element.checked }),
      ...(element.expanded === null ? {} : { expanded: element.expanded }),
      editable: element.editable,
      ...(element.rect ? { rect: element.rect } : {}),
      ...(element.offscreen ? { offscreen: true } : {}),
    }));
    return {
      title: this.title(window),
      url: "",
      viewport: value.bounds ? { width: value.bounds.width, height: value.bounds.height } : {},
      text: redact(value.text, 12_000),
      elements,
      omittedTextChars: value.omittedTextChars,
      omittedElements: value.omittedElements,
      readLimitReached: value.readLimitReached,
      unlabelled: value.unlabelled,
      sensitiveFilled: value.sensitiveFilled,
    };
  }

  private async snapshot(window: NativeWindowState, signal: AbortSignal, turn?: AppUnderTestTurn): Promise<Record<string, unknown>> {
    const page = await this.read(window, signal, turn, true);
    const serialized = serializeAgentPageSnapshot(page, page.unlabelled === true ? { notInspected: ["unlabelled-regions"] } : {}, {
      maxBytes: SNAPSHOT_RESULT_BYTES,
      nextStep: snapshotNextStep,
    });
    const result = JSON.parse(serialized) as Record<string, unknown>;
    delete result.url;
    return result;
  }

  private async wait(
    window: NativeWindowState,
    command: Extract<AppUnderTestWindowCommand, { action: "wait" }>,
    signal: AbortSignal,
    turn?: AppUnderTestTurn,
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const needle = command.text?.replace(/\s+/gu, " ").toLowerCase();
    for (;;) {
      const page = await this.read(window, signal, turn, false);
      const matched = command.state === "loaded" || needle === undefined
        ? true
        : snapshotContains(page, needle) === (command.state === "visible");
      if (matched) return { matched: true, waitedMs: Date.now() - startedAt };
      if (Date.now() - startedAt + this.waitPollMs >= command.timeoutMs) {
        return {
          matched: false,
          waitedMs: Date.now() - startedAt,
          nextStep: "The condition was not reached in time. Take a new inertia_app_snapshot to see what the window shows now.",
        };
      }
      await delay(this.waitPollMs, signal);
      if (signal.aborted) throw refused("cancelled", "The App action was cancelled.");
    }
  }

  private async screenshot(window: NativeWindowState, signal: AbortSignal, turn?: AppUnderTestTurn): Promise<Record<string, unknown>> {
    // A secret typed into any window of the launch withholds every window's screenshots.
    if (this.launchMemory.passwordValues.size > 0 || this.launchMemory.evidenceWithheld
      || window.memory.passwordValues.size > 0 || window.memory.evidenceWithheld) {
      throw refused("sensitive", ACCESSIBILITY_MESSAGES.sensitiveField);
    }
    const shot = await this.ask({ command: "screenshot", window: window.token }, "screenshot", signal, turn);
    const evidenceId = this.context.evidence({ kind: "screenshot", png: shot.png, width: shot.width, height: shot.height });
    if (!evidenceId) throw refused("unavailable", "Inertia could not keep the screenshot as local evidence.");
    return {
      captured: true,
      evidenceId,
      width: Math.round(window.bounds?.width ?? shot.width),
      height: Math.round(window.bounds?.height ?? shot.height),
      mayIncludeOverlappingWindows: shot.mayIncludeOverlappingWindows,
    };
  }

  // Inspection and input ---------------------------------------------------------------------

  private target(window: NativeWindowState, element: AppControlElementInfo | null): AppUnderTestWindowTarget {
    if (!element) return { role: "document", label: "No focused control", sensitive: false };
    return {
      role: element.role.slice(0, 50),
      label: element.sensitive ? "Sensitive field" : this.redactText(window, element.name, 300),
      sensitive: element.sensitive,
    };
  }

  /** Reads the command's control without changing the app; refs from an older document are stale. */
  private async inspectIn(
    window: NativeWindowState,
    command: AppUnderTestDestructiveWindowCommand,
    signal: AbortSignal,
    turn?: AppUnderTestTurn,
  ): Promise<{ inspection: AppUnderTestWindowInspection; element: AppControlElementInfo | null }> {
    let token: string | null = null;
    if (command.action === "press") {
      if (keyAction(command.key) === null) throw refused("invalid", ACCESSIBILITY_MESSAGES.key);
    } else if (command.action === "scroll" && !("ref" in command)) {
      throw refused("invalid", ACCESSIBILITY_MESSAGES.scrollPixels);
    } else {
      token = window.refs.get(command.ref) ?? null;
      if (token === null) throw refused("not-found", ACCESSIBILITY_MESSAGES.stale);
    }
    const sequence = window.documentSequence;
    let inspected: Extract<AppControlValue, { kind: "inspect" }>;
    try {
      inspected = await this.ask({ command: "inspect", window: window.token, element: token }, "inspect", signal, turn);
    } catch (error) {
      if (error instanceof Refused && error.failure.message === ACCESSIBILITY_MESSAGES.gone) this.forget(window);
      throw error;
    }
    this.observeRoot(window, inspected.rootKey);
    if (window.documentSequence !== sequence) throw refused("not-found", ACCESSIBILITY_MESSAGES.stale);
    const element = inspected.element;
    if (element && command.action === "type") {
      if (!element.enabled) throw refused("invalid", ACCESSIBILITY_MESSAGES.disabled);
      if (!element.editable) throw refused("invalid", ACCESSIBILITY_MESSAGES.notEditable);
    } else if (element && command.action === "click" && !element.enabled) {
      throw refused("invalid", ACCESSIBILITY_MESSAGES.disabled);
    }
    return {
      inspection: {
        windowId: window.windowId,
        windowNumber: window.windowNumber,
        documentSequence: window.documentSequence,
        target: command.action === "scroll" && !("ref" in command) ? null : this.target(window, element),
        dialog: null,
      },
      element,
    };
  }

  private async act(
    window: NativeWindowState,
    command: AppUnderTestWindowCommand,
    options: AppUnderTestWindowPerformOptions,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (command.action !== "click" && command.action !== "type" && command.action !== "press" && command.action !== "scroll") {
      throw refused("invalid", ACCESSIBILITY_MESSAGES.refused);
    }
    if (options.dialogOnly) throw refused("not-found", ACCESSIBILITY_MESSAGES.changed);
    const { expected, turn } = options;
    const { inspection, element } = await this.inspectIn(window, command, signal, turn);
    if (expected && (expected.documentSequence !== inspection.documentSequence || expected.dialog !== null
      || !sameTarget(expected.target, inspection.target))) {
      throw refused("not-found", ACCESSIBILITY_MESSAGES.changed);
    }
    if (command.action === "press" && !element) throw refused("invalid", ACCESSIBILITY_MESSAGES.noFocus);
    const expect: AppControlExpectation | null = expected && element && window.rootKey
      ? { rootKey: window.rootKey, role: element.role, name: element.name }
      : null;
    let action: Extract<AppControlCommand, { command: "perform" }>["action"];
    let text: string | null = null;
    let outcome: Record<string, unknown>;
    switch (command.action) {
      case "click":
        action = clickAction(element!);
        outcome = { clicked: command.ref };
        break;
      case "type":
        // A secret is remembered before anything is sent, so an app that
        // echoes it at once (logs, title, a label) is already redacted.
        if (element!.sensitive) this.remember(window, command.text);
        action = command.replace ? "setValue" : "typeText";
        text = command.text;
        outcome = { typed: command.ref, characters: agentBrowserTextLength(command.text) };
        break;
      case "press":
        action = "press";
        outcome = { pressed: command.key };
        break;
      case "scroll":
        action = "scrollIntoView";
        outcome = { scrolled: (command as { ref: string }).ref };
        break;
    }
    const elementToken = command.action === "press" ? element!.token : window.refs.get((command as { ref: string }).ref)!;
    const performed = await this.ask({
      command: "perform", window: window.token, element: elementToken, action, text, expect,
    }, "perform", signal, turn);
    if (performed.windowClosed) {
      this.forget(window);
      return { ...outcome, windowClosed: true, nextStep: "The window closed after the action. Call inertia_app_windows for current windows." };
    }
    const replaced = this.observeRoot(window, performed.rootKey);
    return {
      ...outcome,
      title: this.title(window),
      origin: null,
      loading: false,
      ...(replaced ? { navigated: true, nextStep: ACCESSIBILITY_MESSAGES.contentChanged } : {}),
    };
  }

  private remember(window: NativeWindowState, value: string): void {
    rememberSecret(window.memory, value);
    rememberSecret(this.launchMemory, value);
  }
}

export function createAccessibilityTransportFactory(
  broker: RuntimeAppControlBroker,
  options: AccessibilityWindowTransportOptions = {},
): AccessibilityTransportFactory {
  return Object.freeze({
    create(context: AppUnderTestAccessibilityTransportContext): AppUnderTestWindowTransport {
      return new AccessibilityWindowTransport(context, broker, options);
    },
  });
}

/** Re-exported for tests that build failures without a broker. */
export type { AppControlFailure };
