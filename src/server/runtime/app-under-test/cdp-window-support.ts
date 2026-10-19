import { MAX_APP_LOG_LINE_BYTES, MAX_APP_TOOL_RESULT_BYTES } from "../../../shared/app-under-test";
import type { PreviewAgentDialog, PreviewAgentDialogKind } from "../../../shared/preview-agent-dialogs";
import {
  createPreviewAgentPrivacyRuntime,
  PREVIEW_AGENT_NAME_WORD_SOURCE,
  PREVIEW_AGENT_SENSITIVE_NAME_SOURCE,
} from "../../../shared/preview-agent-sensitive-fields";
import type {
  AppUnderTestWindowFailure,
  AppUnderTestWindowFailureCode,
  AppUnderTestWindowTarget,
} from "./window-transport";

/** Types, bounds, fixed wording and pure helpers of the CDP window transport. */

export interface DialogRecord extends PreviewAgentDialog {
  truncated: boolean;
  documentSequence: number;
}

export interface PageMemory {
  passwordNodes: WeakSet<object>;
  passwordValues: Set<string>;
  /** Set by the privacy runtime when a value could not be remembered. */
  evidenceWithheld?: string;
}

export interface WindowState {
  readonly windowId: string;
  readonly windowNumber: number;
  readonly targetId: string;
  readonly openedAt: number;
  sessionId: string | null;
  ready: boolean;
  title: string;
  url: string;
  loading: boolean;
  mainFrameId: string | null;
  documentSequence: number;
  /** Isolated-world context of the current document, when known. */
  world: { contextId: number; documentSequence: number } | null;
  /** Values the agent typed into sensitive fields of this document. */
  memory: PageMemory;
  dialogs: DialogRecord[];
  dialogsOmitted: number;
  /** The open JavaScript dialog; cleared only once an answer is acknowledged or it closes. */
  openDialog: OpenDialog | null;
  /** Settles when the answers sent to this window's dialogs were acknowledged or failed. */
  answering: Promise<void> | null;
  crashed: boolean;
  /** A target-info refresh is in flight. */
  refreshing: boolean;
  lastUsed: number;
}

export interface OpenDialog {
  kind: PreviewAgentDialogKind;
  message: string;
  truncated: boolean;
}

export type CommandKind = "inspect" | "input" | "wait";

export interface Scope {
  readonly window: WindowState;
  readonly kind: CommandKind;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly documentSequence: number;
  dispatched: boolean;
  armedAccept: boolean;
  interrupted: boolean;
  /** Set with the input: a later navigation or close is the action's result. */
  outcome: Record<string, unknown> | null;
  navigationStarted: boolean;
  navigated: boolean;
  closed: boolean;
  /** The input answered a dialog that was already open; that answer reached the app. */
  dialogAnswered: boolean;
  /** The one `dialog: "accept"` of this input was spent on the open dialog. */
  acceptSpent: boolean;
}

export interface Located {
  found: boolean;
  blocked: boolean;
  disabled: boolean;
  editable: boolean;
  sensitive: boolean;
  role: string;
  label: string;
  x: number | null;
  y: number | null;
}

export interface PageRead {
  value: Record<string, unknown>;
  withheld: string | null;
  remembered: number;
  readyState: string;
}

export class Refusal extends Error {
  constructor(readonly failure: AppUnderTestWindowFailure) {
    super(failure.message);
  }
}

// The Browser's own privacy runtime, run on plain strings in the runtime.
const NODE_PRIVACY = createPreviewAgentPrivacyRuntime(PREVIEW_AGENT_SENSITIVE_NAME_SOURCE, PREVIEW_AGENT_NAME_WORD_SOURCE);

export function emptyPageMemory(): PageMemory {
  return { passwordNodes: new WeakSet(), passwordValues: new Set() };
}

/**
 * Remembers one secret value: at most 256 values of at most 4,096 characters
 * each. A value beyond either bound is never remembered and nothing already
 * remembered is evicted to make room; the memory is marked withheld instead.
 */
export function rememberSecret(memory: PageMemory, value: string): void {
  NODE_PRIVACY.remember(memory, value);
}

/**
 * Replaces remembered values with `[redacted]`: the Browser's matcher, which
 * finds a value of four or more characters anywhere, ignoring case (and its
 * JSON- and URL-encoded forms), and a shorter value only as a whole word.
 * `truncated` marks text cut at a bound, so a value's partial tail is cut
 * too. Unchanged when nothing is remembered.
 */
export function redactSecrets(memory: PageMemory, value: string, maximum: number, truncated = false): string {
  return memory.passwordValues.size === 0 ? value : NODE_PRIVACY.redact(memory, value, maximum, truncated);
}
export const QUEUE_WAIT_MS = 30_000;
export const WAIT_POLL_MS = 250;
export const NAVIGATION_GRACE_MS = 250;
export const NAVIGATION_SETTLE_MS = 20_000;
export const PHASE_TIMEOUT_MS = 15_000;
export const WAIT_BUDGET_EXTRA_MS = 5_000;
export const MAX_EVALUATION_CHARS = 1024 * 1024;
export const MAX_QUEUED_COMMANDS = 16;
export const MAX_WAITING_TARGETS = 64;
export const MAX_TARGET_TEXT_CHARS = 4_096;
export const MAX_LOG_TEXT_CHARS = 4_096;
/** A committed log line holds at most this many bytes, so never more characters. */
export const MAX_APP_LOG_LINE_CHARS = MAX_APP_LOG_LINE_BYTES;
/** Values the isolated world may hand the runtime in one read. */
export const MAX_REPORTED_SECRETS = 256;
export const MAX_DIALOG_REPORT_BYTES = 8 * 1024;
export const MAX_SCREENSHOT_ATTEMPTS = 5;
/** Room left for the fields the host tool adds (windowId, launchId, note). */
export const SNAPSHOT_RESULT_BYTES = MAX_APP_TOOL_RESULT_BYTES - 1_024;
export const INTERNAL_URL = /^(?:devtools|chrome|chrome-extension|chrome-untrusted|chrome-search|edge|view-source):/iu;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const REACH_STEP = "Scroll with inertia_app_scroll, by ref or by pixels, and take a new inertia_app_snapshot to read more, or use inertia_app_wait_for with text to look for specific content.";

/** A read-only command never answers a dialog; it names the dialog's kind, never its text. */
export function dialogPendingMessage(windowNumber: number, kind: PreviewAgentDialogKind): string {
  return `App window ${windowNumber} is showing a ${kind} dialog, so nothing was read. Answer it with the next click, type or press using dialog: accept or dismiss.`;
}

export const MESSAGES = Object.freeze({
  gone: "That window is gone. Call inertia_app_windows for current windows.",
  blank: "This window is blank. Wait for the app to load a page with inertia_app_wait_for, then take a new inertia_app_snapshot.",
  stale: "That control is stale. Take a new inertia_app_snapshot for current refs.",
  outside: "That control is outside the visible part of the window. Scroll it into view with inertia_app_scroll and its ref, then try again.",
  changed: "The window changed after the approval was requested, so nothing was sent. Take a new inertia_app_snapshot, then try again.",
  interrupted: "The window navigated or closed during the action; take a new inertia_app_snapshot before continuing.",
  busy: "Another App action is still running for this launch, so nothing was sent. Try again when it finishes.",
  blocked: "That control cannot be used by the agent: it is a file chooser or an embedded frame.",
  disabled: "That control is disabled.",
  notEditable: "That control does not accept text input.",
  lostFocus: "That control lost focus before typing. Take a new inertia_app_snapshot for current refs.",
  crashed: "This window's renderer crashed. Restart the app with inertia_app_stop and inertia_app_launch.",
  closed: "The app's debugging connection closed. Call inertia_app_status to see whether it is still running.",
});

export const KEYS: Readonly<Record<string, { key: string; code: string; keyCode: number; text?: string }>> = Object.freeze({
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
});
export const MODIFIER_BITS = Object.freeze({ Shift: 8, Control: 2, Meta: 4 } as const);

export function refusal(code: AppUnderTestWindowFailureCode, message: string, dispatched = false): Refusal {
  return new Refusal({ ok: false, code, message, dispatched });
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function text(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Origin only: scheme, host and port. Paths, queries and credentials never leave. */
export function appWindowOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (["about:", "data:", "blob:", "javascript:"].includes(parsed.protocol)) return null;
  const origin = parsed.origin !== "null"
    ? parsed.origin
    : parsed.protocol === "file:"
      ? "file://"
      : parsed.host ? `${parsed.protocol}//${parsed.host}` : null;
  return origin && origin.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(origin) ? origin : null;
}

export function blankUrl(url: string): boolean {
  return url === "" || url === "about:blank" || url.startsWith("about:blank#") || url.startsWith("about:blank?");
}

export function pngDimensions(png: Uint8Array): { width: number; height: number } | null {
  if (png.byteLength < 24 || !PNG_SIGNATURE.every((byte, index) => png[index] === byte)) return null;
  if (String.fromCharCode(png[12]!, png[13]!, png[14]!, png[15]!) !== "IHDR") return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function snapshotNextStep(readLimitReached: boolean): string {
  return readLimitReached
    ? `This window is larger than one snapshot reads, so more text and controls exist than are listed. ${REACH_STEP}`
    : `Part of this window was left out of the snapshot. ${REACH_STEP}`;
}

export function snapshotContains(value: Record<string, unknown>, needle: string): boolean {
  const matches = (candidate: unknown): boolean => typeof candidate === "string"
    && candidate.replace(/\s+/gu, " ").toLowerCase().includes(needle);
  if (matches(value.text)) return true;
  return Array.isArray(value.elements) && value.elements.some((element) => {
    const candidate = record(element);
    return candidate !== null && (matches(candidate.name) || matches(candidate.value));
  });
}

export function withheldMessage(reason: string, subject: string): string {
  return reason === "redaction-limit"
    ? `${subject} unavailable because this window holds more secret values than Inertia can hide. Load a new page in the app or restart it to start a new document.`
    : `${subject} unavailable because Inertia cannot check this window for secrets. Load a new page in the app or restart it to start a new document.`;
}

export function activationMessage(value: string): string {
  if (value === "file") return "File inputs cannot be activated by the agent.";
  if (value === "disabled") return "The focused control is disabled.";
  if (value === "retargeted") return "The focused control changed during the key press. Take a new inertia_app_snapshot for current refs.";
  return "Enter and Space are unavailable while focus is inside an embedded frame or a closed shadow root, because Inertia cannot see the control they would activate. Click a control from the latest snapshot first.";
}

export function sameTarget(left: AppUnderTestWindowTarget | null, right: AppUnderTestWindowTarget | null): boolean {
  if (left === null || right === null) return left === right;
  return left.role === right.role && left.label === right.label && left.sensitive === right.sensitive;
}

/** One console call as a bounded log line; arguments are app data, never instructions. */
export function consoleLine(params: Record<string, unknown>): string {
  const type = text(params.type, 32) || "log";
  const args = Array.isArray(params.args) ? params.args.slice(0, 32) : [];
  let line = "";
  for (const argument of args) {
    const entry = record(argument);
    if (!entry) continue;
    const value = entry.value;
    let piece: string;
    if (typeof value === "string") piece = value;
    else if (value !== undefined) {
      try {
        piece = JSON.stringify(value) ?? "";
      } catch {
        piece = "";
      }
    } else {
      piece = text(entry.unserializableValue, 64) || text(entry.description, MAX_LOG_TEXT_CHARS) || `[${text(entry.type, 32)}]`;
    }
    line += `${line ? " " : ""}${piece.slice(0, MAX_LOG_TEXT_CHARS)}`;
    if (line.length >= MAX_LOG_TEXT_CHARS) break;
  }
  line = line.slice(0, MAX_LOG_TEXT_CHARS);
  return type === "log" || type === "info" ? line : `${type}: ${line}`;
}

/** Applies a document's remembered secret values to every text field of a snapshot value. */
export function redactSnapshotValue(memory: PageMemory, value: Record<string, unknown>): Record<string, unknown> {
  if (memory.passwordValues.size === 0) return value;
  const redact = (candidate: unknown, maximum: number): unknown => (
    typeof candidate === "string" ? NODE_PRIVACY.redact(memory, candidate, maximum) : candidate
  );
  return {
    ...value,
    title: redact(value.title, 300),
    text: redact(value.text, 12_000),
    elements: Array.isArray(value.elements)
      ? value.elements.map((element) => {
        const entry = record(element);
        if (!entry) return element;
        return {
          ...entry,
          ...(entry.name === undefined ? {} : { name: redact(entry.name, 300) }),
          ...(entry.value === undefined || entry.value === "[redacted]" ? {} : { value: redact(entry.value, 500) }),
        };
      })
      : value.elements,
  };
}

/** Keeps whole dialog entries within the Browser's 8 KiB report bound. */
export function boundedDialogReport(
  dialogs: readonly PreviewAgentDialog[],
  omitted: number,
  withheld: boolean,
): Record<string, unknown> {
  const reported: PreviewAgentDialog[] = [];
  for (const entry of dialogs) {
    if (Buffer.byteLength(JSON.stringify([...reported, entry]), "utf8") > MAX_DIALOG_REPORT_BYTES) break;
    reported.push(entry);
  }
  const left = omitted + dialogs.length - reported.length;
  return {
    dialogs: reported,
    ...(left > 0 ? { dialogsOmitted: left } : {}),
    ...(withheld ? { dialogsWithheld: true } : {}),
  };
}

/**
 * For the screenshot check only. A sensitive field reports Inertia's own
 * placeholder "[redacted]" even when it is empty; any field that holds a
 * value has already been remembered by the scan, and a remembered value
 * withholds the screenshot before this check runs.
 */
export function withoutRedactedValues(value: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(value.elements)) return value;
  return {
    ...value,
    elements: value.elements.map((element) => {
      const entry = record(element);
      if (entry?.value !== "[redacted]") return element;
      const { value: _hidden, ...rest } = entry;
      return rest;
    }),
  };
}
