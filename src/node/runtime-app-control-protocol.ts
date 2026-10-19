/**
 * Strict messages between the supervised runtime (which owns App under test
 * launches) and the Electron main process (which owns the native App control
 * worker). The runtime names a launch by its identity and an opaque window or
 * element token minted by the worker; main resolves everything else.
 * Every field is validated with exact keys and bounded sizes.
 */

export const APP_CONTROL_MAX_PAYLOAD_BYTES = 24 * 1024;
export const APP_CONTROL_MAX_PNG_BYTES = 256 * 1024;
export const APP_CONTROL_MAX_PENDING_REQUESTS = 16;
export const APP_CONTROL_RUNTIME_BACKSTOP_MS = 90_000;
export const APP_CONTROL_INSPECT_WATCHDOG_MS = 10_000;
export const APP_CONTROL_ACTION_WATCHDOG_MS = 20_000;
export const APP_CONTROL_KILL_CONFIRM_MS = 3_000;
export const APP_CONTROL_MAX_LISTED_WINDOWS = 16;
export const APP_CONTROL_MAX_ELEMENTS = 200;
export const APP_CONTROL_MAX_TEXT_CHARS = 12_000;
export const APP_CONTROL_MAX_NODE_VISITS = 4_096;
export const APP_CONTROL_MAX_DEPTH = 16;
export const APP_CONTROL_WALK_MS = 3_000;
export const APP_CONTROL_MAX_TITLE_CHARS = 1_024;
/** The worker cuts window titles to this before the runtime's 120-character sanitizer. */
export const APP_CONTROL_MAX_WORKER_TITLE_CHARS = 480;
export const APP_CONTROL_MAX_NAME_CHARS = 300;
export const APP_CONTROL_MAX_VALUE_CHARS = 500;
export const APP_CONTROL_MAX_ROLE_CHARS = 80;
export const APP_CONTROL_MAX_TYPE_CHARS = 4_000;
export const APP_CONTROL_MAX_ACTION_NAMES = 12;
export const APP_CONTROL_REQUEST_ID_REPLAY_LIMIT = 512;

export const APP_CONTROL_ACTIONS = [
  "press", "setValue", "typeText", "focus", "toggle", "select", "expand", "activate", "scrollIntoView",
] as const;
export type AppControlAction = (typeof APP_CONTROL_ACTIONS)[number];
/** Actions that may target the window itself or, for press, its focused control (`element: null`). */
const ELEMENTLESS_ACTIONS: ReadonlySet<AppControlAction> = new Set(["press", "activate"]);
const TEXT_ACTIONS: ReadonlySet<AppControlAction> = new Set(["setValue", "typeText"]);

export const APP_CONTROL_FAILURE_CODES = [
  "permission-denied",
  "helper-permission-denied",
  "accessibility-unavailable",
  "not-found",
  "denied",
  "native-failure",
  "timeout",
  "invalid",
  "unavailable",
  "unsupported",
  "elevated",
  "cancelled",
  "sensitive",
  "busy",
] as const;
export type AppControlFailureCode = (typeof APP_CONTROL_FAILURE_CODES)[number];

export const APP_CONTROL_FAILURE_REASONS = [
  "disabled", "not-editable", "action-unsupported", "stale", "changed", "window-gone", "launch-gone",
  "incomplete", "screen-recording", "wayland", "no-focus", "tree-too-large", "start-failed", "empty-tree",
] as const;
export type AppControlFailureReason = (typeof APP_CONTROL_FAILURE_REASONS)[number];

export interface AppControlIdentity {
  conversationId: string;
  /** Null only for background window listing and permission reads. */
  runId: string | null;
  turnId: string | null;
  launchId: string;
  /** The launch's root process id. */
  pid: number;
  /** Epoch milliseconds just before the runtime spawned the launch. */
  processStartedAt: number;
}

export interface AppControlExpectation {
  rootKey: string;
  role: string;
  name: string;
}

export type AppControlCommand =
  | { command: "windows" }
  | { command: "permissions" }
  | { command: "snapshot"; window: string }
  | { command: "screenshot"; window: string }
  | { command: "inspect"; window: string; element: string | null }
  | {
      command: "perform";
      window: string;
      element: string | null;
      action: AppControlAction;
      text: string | null;
      expect: AppControlExpectation | null;
    };
export type AppControlCommandName = AppControlCommand["command"];

export interface AppControlRect { x: number; y: number; width: number; height: number }

export interface AppControlWindowInfo {
  /** Null for a denied window: it is listed but can never be addressed. */
  token: string | null;
  pid: number;
  title: string;
  active: boolean;
  denied: boolean;
  bounds: AppControlRect | null;
}

export interface AppControlElementInfo {
  token: string;
  role: string;
  name: string;
  /** `[redacted]` for a sensitive control; null when the control has no value. */
  value: string | null;
  enabled: boolean;
  focused: boolean;
  checked: "on" | "off" | "mixed" | null;
  expanded: boolean | null;
  editable: boolean;
  sensitive: boolean;
  offscreen: boolean;
  /** Relative to the window's top-left corner. */
  rect: AppControlRect | null;
  actions: string[];
}

export type AppControlValue =
  /** `omitted` counts windows left out to fit the payload bound (the newest first). */
  | { kind: "windows"; windows: AppControlWindowInfo[]; omitted: number }
  | {
      kind: "permissions";
      accessibility: "granted" | "required" | "unverified";
      screenRecording: "granted" | "required" | "unverified";
      screenshots: "available" | "unavailable";
    }
  | {
      kind: "snapshot";
      rootKey: string;
      title: string;
      bounds: AppControlRect | null;
      text: string;
      elements: AppControlElementInfo[];
      omittedTextChars: number;
      omittedElements: number;
      readLimitReached: boolean;
      unlabelled: boolean;
      /** A password or credential-named field currently holds a value. */
      sensitiveFilled: boolean;
    }
  | { kind: "inspect"; rootKey: string; element: AppControlElementInfo | null }
  | { kind: "perform"; rootKey: string | null; windowClosed: boolean }
  | { kind: "screenshot"; width: number; height: number; png: Uint8Array; mayIncludeOverlappingWindows: boolean };

export interface AppControlFailure {
  ok: false;
  code: AppControlFailureCode;
  reason: AppControlFailureReason | null;
  /** True when an action may already have reached the app. */
  dispatched: boolean;
}

export type AppControlResult = { ok: true; value: AppControlValue } | AppControlFailure;

export type RuntimeAppControlEvent =
  | { type: "runtime.app-control-request"; requestId: string; identity: AppControlIdentity; command: AppControlCommand | null }
  | { type: "runtime.app-control-cancel"; requestId: string; identity: AppControlIdentity };

export interface RuntimeAppControlResult {
  type: "runtime.app-control-result";
  requestId: string;
  result: AppControlResult;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Window, element and root tokens are 128-bit hex digests minted by the worker. */
export const APP_CONTROL_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
const ACTION_NAME = /^[a-z][a-z0-9_]{0,31}$/u;
const READ_ONLY_COMMANDS: ReadonlySet<AppControlCommandName> = new Set(["windows", "permissions"]);
const MAX_COORDINATE = 1_000_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function token(value: unknown): value is string {
  return typeof value === "string" && APP_CONTROL_TOKEN_PATTERN.test(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function codePoints(value: string): number {
  let total = 0;
  for (const _character of value) total += 1;
  return total;
}

/** UTF-8 size of a JSON value; binary image bytes are bounded separately. */
export function appControlPayloadBytes(value: unknown): number {
  const text = JSON.stringify(value, (key, candidate: unknown) => (
    key === "png" && candidate instanceof Uint8Array ? candidate.byteLength : candidate
  ));
  return Buffer.byteLength(text ?? "", "utf8");
}

export function parseAppControlIdentity(value: unknown): AppControlIdentity | null {
  if (!plainObject(value) || !exactKeys(value, ["conversationId", "runId", "turnId", "launchId", "pid", "processStartedAt"])) return null;
  const { conversationId, runId, turnId, launchId, pid, processStartedAt } = value;
  if (!uuid(conversationId) || !uuid(launchId)) return null;
  if ((runId === null) !== (turnId === null)) return null;
  if (runId !== null && (!uuid(runId) || !uuid(turnId))) return null;
  if (!count(pid, 0x7fff_ffff) || pid <= 1) return null;
  if (!count(processStartedAt) || processStartedAt <= 0) return null;
  return { conversationId, runId: runId as string | null, turnId: turnId as string | null, launchId, pid, processStartedAt };
}

function parseExpectation(value: unknown): AppControlExpectation | null | undefined {
  if (value === null) return null;
  if (!plainObject(value) || !exactKeys(value, ["rootKey", "role", "name"])) return undefined;
  if (!token(value.rootKey) || !boundedString(value.role, APP_CONTROL_MAX_ROLE_CHARS)
    || !boundedString(value.name, APP_CONTROL_MAX_NAME_CHARS)) return undefined;
  return { rootKey: value.rootKey, role: value.role, name: value.name };
}

/** Parses one command; null when anything is unexpected. */
export function parseAppControlCommand(value: unknown): AppControlCommand | null {
  if (!plainObject(value) || typeof value.command !== "string") return null;
  if (appControlPayloadBytes(value) > APP_CONTROL_MAX_PAYLOAD_BYTES) return null;
  switch (value.command) {
    case "windows":
    case "permissions":
      return exactKeys(value, ["command"]) ? { command: value.command } : null;
    case "snapshot":
    case "screenshot":
      return exactKeys(value, ["command", "window"]) && token(value.window)
        ? { command: value.command, window: value.window }
        : null;
    case "inspect":
      return exactKeys(value, ["command", "window", "element"]) && token(value.window)
        && (value.element === null || token(value.element))
        ? { command: "inspect", window: value.window, element: value.element as string | null }
        : null;
    case "perform": {
      if (!exactKeys(value, ["command", "window", "element", "action", "text", "expect"]) || !token(value.window)) return null;
      const action = APP_CONTROL_ACTIONS.find((candidate) => candidate === value.action);
      if (!action) return null;
      if (value.element === null ? !ELEMENTLESS_ACTIONS.has(action) : !token(value.element)) return null;
      if (TEXT_ACTIONS.has(action)) {
        if (typeof value.text !== "string" || value.text.includes("\u0000")
          || codePoints(value.text) > APP_CONTROL_MAX_TYPE_CHARS) return null;
      } else if (value.text !== null) return null;
      const expect = parseExpectation(value.expect);
      if (expect === undefined) return null;
      return {
        command: "perform",
        window: value.window,
        element: value.element as string | null,
        action,
        text: value.text as string | null,
        expect,
      };
    }
    default:
      return null;
  }
}

export function parseRuntimeAppControlEvent(value: unknown): RuntimeAppControlEvent | null {
  if (!plainObject(value) || (value.type !== "runtime.app-control-request" && value.type !== "runtime.app-control-cancel")
    || !uuid(value.requestId)) return null;
  const identity = parseAppControlIdentity(value.identity);
  if (!identity) return null;
  if (value.type === "runtime.app-control-cancel") {
    return exactKeys(value, ["type", "requestId", "identity"])
      ? { type: "runtime.app-control-cancel", requestId: value.requestId, identity }
      : null;
  }
  if (!exactKeys(value, ["type", "requestId", "identity", "command"])) return null;
  let command = parseAppControlCommand(value.command);
  // Background reads carry no turn; anything else must name the exact turn.
  if (command && identity.runId === null && !READ_ONLY_COMMANDS.has(command.command)) command = null;
  return { type: "runtime.app-control-request", requestId: value.requestId, identity, command };
}

function parseRect(value: unknown): AppControlRect | null | undefined {
  if (value === null) return null;
  if (!plainObject(value) || !exactKeys(value, ["x", "y", "width", "height"])) return undefined;
  const { x, y, width, height } = value;
  const finite = (candidate: unknown, minimum: number): candidate is number => typeof candidate === "number"
    && Number.isFinite(candidate) && candidate >= minimum && candidate <= MAX_COORDINATE;
  return finite(x, -MAX_COORDINATE) && finite(y, -MAX_COORDINATE) && finite(width, 0) && finite(height, 0)
    ? { x, y, width, height }
    : undefined;
}

function parseWindow(value: unknown): AppControlWindowInfo | null {
  if (!plainObject(value) || !exactKeys(value, ["token", "pid", "title", "active", "denied", "bounds"])) return null;
  const bounds = parseRect(value.bounds);
  if (bounds === undefined || typeof value.denied !== "boolean" || typeof value.active !== "boolean"
    || !count(value.pid, 0x7fff_ffff) || !boundedString(value.title, APP_CONTROL_MAX_TITLE_CHARS)) return null;
  // A denied window is listed without a token, so it can never be addressed.
  if (value.denied ? value.token !== null : !token(value.token)) return null;
  return {
    token: value.token as string | null,
    pid: value.pid,
    title: value.title,
    active: value.active,
    denied: value.denied,
    bounds,
  };
}

const ELEMENT_KEYS = [
  "token", "role", "name", "value", "enabled", "focused", "checked", "expanded", "editable", "sensitive",
  "offscreen", "rect", "actions",
] as const;

function parseElement(value: unknown): AppControlElementInfo | null {
  if (!plainObject(value) || !exactKeys(value, ELEMENT_KEYS)) return null;
  const rect = parseRect(value.rect);
  const booleans = ["enabled", "focused", "editable", "sensitive", "offscreen"] as const;
  if (rect === undefined || !token(value.token) || !boundedString(value.role, APP_CONTROL_MAX_ROLE_CHARS)
    || !boundedString(value.name, APP_CONTROL_MAX_NAME_CHARS)
    || !(value.value === null || boundedString(value.value, APP_CONTROL_MAX_VALUE_CHARS))
    || booleans.some((key) => typeof value[key] !== "boolean")
    || !(value.checked === null || value.checked === "on" || value.checked === "off" || value.checked === "mixed")
    || !(value.expanded === null || typeof value.expanded === "boolean")
    || !Array.isArray(value.actions) || value.actions.length > APP_CONTROL_MAX_ACTION_NAMES
    || !value.actions.every((name) => typeof name === "string" && ACTION_NAME.test(name))) return null;
  // A sensitive control never carries its value across the boundary.
  if (value.sensitive === true && value.value !== null && value.value !== "[redacted]") return null;
  return {
    token: value.token,
    role: value.role,
    name: value.name,
    value: value.value as string | null,
    enabled: value.enabled as boolean,
    focused: value.focused as boolean,
    checked: value.checked as AppControlElementInfo["checked"],
    expanded: value.expanded as boolean | null,
    editable: value.editable as boolean,
    sensitive: value.sensitive as boolean,
    offscreen: value.offscreen as boolean,
    rect,
    actions: [...value.actions as string[]],
  };
}

function isPng(value: Uint8Array): boolean {
  return value.byteLength > 24 && PNG_SIGNATURE.every((byte, index) => value[index] === byte);
}

function parseValue(value: unknown): AppControlValue | null {
  if (!plainObject(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "windows": {
      if (!exactKeys(value, ["kind", "windows", "omitted"]) || !Array.isArray(value.windows)
        || value.windows.length > APP_CONTROL_MAX_LISTED_WINDOWS || !count(value.omitted, 1_024)) return null;
      const windows = value.windows.map(parseWindow);
      return windows.every((window) => window !== null)
        ? { kind: "windows", windows: windows as AppControlWindowInfo[], omitted: value.omitted }
        : null;
    }
    case "permissions": {
      const states = ["granted", "required", "unverified"];
      return exactKeys(value, ["kind", "accessibility", "screenRecording", "screenshots"])
        && states.includes(value.accessibility as string) && states.includes(value.screenRecording as string)
        && (value.screenshots === "available" || value.screenshots === "unavailable")
        ? value as AppControlValue
        : null;
    }
    case "snapshot": {
      if (!exactKeys(value, [
        "kind", "rootKey", "title", "bounds", "text", "elements", "omittedTextChars", "omittedElements",
        "readLimitReached", "unlabelled", "sensitiveFilled",
      ])) return null;
      const bounds = parseRect(value.bounds);
      if (bounds === undefined || !token(value.rootKey) || !boundedString(value.title, APP_CONTROL_MAX_TITLE_CHARS)
        || !boundedString(value.text, APP_CONTROL_MAX_TEXT_CHARS) || !Array.isArray(value.elements)
        || value.elements.length > APP_CONTROL_MAX_ELEMENTS || !count(value.omittedTextChars)
        || !count(value.omittedElements) || typeof value.readLimitReached !== "boolean"
        || typeof value.unlabelled !== "boolean" || typeof value.sensitiveFilled !== "boolean") return null;
      const elements = value.elements.map(parseElement);
      if (!elements.every((element) => element !== null)) return null;
      return {
        kind: "snapshot",
        rootKey: value.rootKey,
        title: value.title,
        bounds,
        text: value.text,
        elements: elements as AppControlElementInfo[],
        omittedTextChars: value.omittedTextChars,
        omittedElements: value.omittedElements,
        readLimitReached: value.readLimitReached,
        unlabelled: value.unlabelled,
        sensitiveFilled: value.sensitiveFilled,
      };
    }
    case "inspect": {
      if (!exactKeys(value, ["kind", "rootKey", "element"]) || !token(value.rootKey)) return null;
      const element = value.element === null ? null : parseElement(value.element);
      return value.element !== null && element === null ? null : { kind: "inspect", rootKey: value.rootKey, element };
    }
    case "perform":
      return exactKeys(value, ["kind", "rootKey", "windowClosed"]) && (value.rootKey === null || token(value.rootKey))
        && typeof value.windowClosed === "boolean"
        ? { kind: "perform", rootKey: value.rootKey as string | null, windowClosed: value.windowClosed }
        : null;
    case "screenshot": {
      if (!exactKeys(value, ["kind", "width", "height", "png", "mayIncludeOverlappingWindows"])
        || !count(value.width, 16_384) || !count(value.height, 16_384) || value.width === 0 || value.height === 0
        || !(value.png instanceof Uint8Array) || value.png.byteLength > APP_CONTROL_MAX_PNG_BYTES || !isPng(value.png)
        || typeof value.mayIncludeOverlappingWindows !== "boolean") return null;
      return {
        kind: "screenshot",
        width: value.width,
        height: value.height,
        png: new Uint8Array(value.png),
        mayIncludeOverlappingWindows: value.mayIncludeOverlappingWindows,
      };
    }
    default:
      return null;
  }
}

/** The value kind each command answers with. */
export const APP_CONTROL_RESULT_KIND: Readonly<Record<AppControlCommandName, AppControlValue["kind"]>> = Object.freeze({
  windows: "windows",
  permissions: "permissions",
  snapshot: "snapshot",
  screenshot: "screenshot",
  inspect: "inspect",
  perform: "perform",
});

/** Validates a result, optionally requiring the value kind of the command it answers. */
export function parseAppControlResult(value: unknown, command?: AppControlCommandName): AppControlResult | null {
  if (!plainObject(value) || appControlPayloadBytes(value) > APP_CONTROL_MAX_PAYLOAD_BYTES) return null;
  if (value.ok === false) {
    if (!exactKeys(value, ["ok", "code", "reason", "dispatched"]) || typeof value.dispatched !== "boolean") return null;
    const code = APP_CONTROL_FAILURE_CODES.find((candidate) => candidate === value.code);
    const reason = value.reason === null ? null : APP_CONTROL_FAILURE_REASONS.find((candidate) => candidate === value.reason);
    if (!code || reason === undefined) return null;
    return { ok: false, code, reason, dispatched: value.dispatched };
  }
  if (value.ok !== true || !exactKeys(value, ["ok", "value"])) return null;
  const parsed = parseValue(value.value);
  if (!parsed || (command !== undefined && parsed.kind !== APP_CONTROL_RESULT_KIND[command])) return null;
  return { ok: true, value: parsed };
}

export function parseRuntimeAppControlResult(value: unknown): RuntimeAppControlResult | null {
  if (!plainObject(value) || value.type !== "runtime.app-control-result"
    || !exactKeys(value, ["type", "requestId", "result"]) || !uuid(value.requestId)) return null;
  const result = parseAppControlResult(value.result);
  return result ? { type: "runtime.app-control-result", requestId: value.requestId, result } : null;
}

export function appControlFailure(
  code: AppControlFailureCode,
  reason: AppControlFailureReason | null = null,
  dispatched = false,
): AppControlFailure {
  return { ok: false, code, reason, dispatched };
}

export function sameAppControlIdentity(left: AppControlIdentity, right: AppControlIdentity): boolean {
  return left.conversationId === right.conversationId
    && left.runId === right.runId
    && left.turnId === right.turnId
    && left.launchId === right.launchId
    && left.pid === right.pid
    && left.processStartedAt === right.processStartedAt;
}
