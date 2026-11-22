import { MAX_PROVIDER_HOST_TOOL_IMAGE_BYTES, MAX_PROVIDER_HOST_TOOL_RESULT_BYTES } from "./provider-host-tools";

export const MAX_AGENT_BROWSER_TEXT_BYTES = MAX_PROVIDER_HOST_TOOL_RESULT_BYTES;
export const MAX_AGENT_BROWSER_IMAGE_BYTES = MAX_PROVIDER_HOST_TOOL_IMAGE_BYTES;
export const MAX_AGENT_BROWSER_IMAGE_EDGE = 1_568;
export const MAX_AGENT_BROWSER_TYPE_CHARS = 4_000;
export const MAX_AGENT_BROWSER_SELECT_CHARS = 200;
export const MAX_AGENT_BROWSER_URL_CHARS = 4_096;
export const MAX_AGENT_BROWSER_WAIT_TEXT_CHARS = 200;
export const MAX_AGENT_BROWSER_SCROLL_DELTA = 2_000;
export const MAX_AGENT_BROWSER_CLICK_COUNT = 3;
/**
 * A wait path: "/" segments, each literal or "*" for exactly one segment, with
 * no query, fragment, whitespace or control characters.
 */
export const AGENT_BROWSER_WAIT_PATH_PATTERN = "^(?:/(?:\\*|[^\\u0000-\\u0020?#*/]+))*/?$";
export const MIN_AGENT_BROWSER_VIEWPORT_WIDTH = 320;
export const MAX_AGENT_BROWSER_VIEWPORT_WIDTH = 2_560;
export const MIN_AGENT_BROWSER_VIEWPORT_HEIGHT = 240;
export const MAX_AGENT_BROWSER_VIEWPORT_HEIGHT = 2_560;
export const MIN_AGENT_BROWSER_WAIT_MS = 250;
export const MAX_AGENT_BROWSER_WAIT_MS = 30_000;
export const DEFAULT_AGENT_BROWSER_WAIT_MS = 10_000;
export const AGENT_BROWSER_QUEUE_WAIT_MS = 30_000;
export const AGENT_BROWSER_INSPECT_BUDGET_MS = 20_000;
export const AGENT_BROWSER_INPUT_BUDGET_MS = 40_000;
export const AGENT_BROWSER_NAVIGATION_BUDGET_MS = 45_000;
export const AGENT_BROWSER_RUNTIME_BACKSTOP_MS = AGENT_BROWSER_QUEUE_WAIT_MS
  + AGENT_BROWSER_NAVIGATION_BUDGET_MS
  + 15_000;

/** Trusted Inertia ownership captured before a provider host-tool call runs. */
export interface AgentBrowserRunIdentity {
  conversationId: string;
  runId: string;
  turnId: string;
}

export type AgentBrowserActionKind =
  | "navigate"
  | "click"
  | "type"
  | "press"
  | "scroll"
  | "snapshot"
  | "screenshot"
  | "resize"
  | "hover"
  | "select"
  | "drag"
  | "tab-open"
  | "tab-activate"
  | "tab-close";

export const AGENT_BROWSER_ACTION_KINDS = [
  "navigate", "click", "type", "press", "scroll", "snapshot", "screenshot",
  "resize", "hover", "select", "drag", "tab-open", "tab-activate", "tab-close",
] as const satisfies readonly AgentBrowserActionKind[];

export type AgentBrowserViewportPreset = "fit" | "desktop" | "tablet" | "mobile";
export type AgentBrowserColorScheme = "light" | "dark" | "system";

export const AGENT_BROWSER_VIEWPORT_PRESETS = ["fit", "desktop", "tablet", "mobile"] as const satisfies readonly AgentBrowserViewportPreset[];
export const AGENT_BROWSER_COLOR_SCHEMES = ["light", "dark", "system"] as const satisfies readonly AgentBrowserColorScheme[];
export const AGENT_BROWSER_VIEWPORT_SIZES: Readonly<Record<
  Exclude<AgentBrowserViewportPreset, "fit">,
  { width: number; height: number; mobile: boolean }
>> = {
  desktop: { width: 1_280, height: 800, mobile: false },
  tablet: { width: 768, height: 1_024, mobile: true },
  mobile: { width: 375, height: 812, mobile: true },
};

export interface AgentBrowserViewport {
  width: number;
  height: number;
  fit: boolean;
  mobile: boolean;
  colorScheme: AgentBrowserColorScheme;
}

export type AgentBrowserViewportRequest =
  | { preset: AgentBrowserViewportPreset }
  | { width: number; height: number };

export interface AgentBrowserImage {
  mimeType: "image/png";
  data: string;
  width: number;
  height: number;
}

export interface AgentBrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
}

export interface AgentBrowserActivity {
  action: AgentBrowserActionKind;
  label: string;
  tabId: string;
  at: string;
  x?: number;
  y?: number;
}

export interface AgentBrowserState {
  activeTabId: string;
  tabs: AgentBrowserTab[];
  activity: AgentBrowserActivity | null;
  controller?: "user";
  viewport?: AgentBrowserViewport;
}

export type AgentBrowserCommand =
  | { action: "snapshot" }
  | { action: "screenshot" }
  | { action: "logs" }
  | { action: "navigate"; url: string }
  | { action: "history"; direction: "back" | "forward" | "reload" }
  | { action: "click"; ref: string; dialog?: "accept"; clickCount?: 2 | 3; modifiers?: AgentBrowserModifier[] }
  | { action: "hover"; ref: string }
  | { action: "type"; ref: string; text: string; replace: boolean }
  | { action: "select"; ref: string; value: string }
  | { action: "drag"; ref: string; targetRef: string }
  | { action: "press"; key: AgentBrowserKey; dialog?: "accept"; modifiers?: AgentBrowserModifier[] }
  | { action: "scroll"; deltaX?: number; deltaY?: number }
  | { action: "scroll"; ref: string }
  | {
      action: "wait";
      text?: string;
      path?: string;
      ref?: string;
      state: "present" | "absent";
      timeoutMs: number;
    }
  | { action: "resize"; preset?: AgentBrowserViewportPreset; width?: number; height?: number; colorScheme?: AgentBrowserColorScheme }
  | { action: "tabs" }
  | { action: "tab-open"; url?: string }
  | { action: "tab-activate"; tabId: string }
  | { action: "tab-close"; tabId: string };

export type AgentBrowserKey =
  | "Enter"
  | "Tab"
  | "Escape"
  | "Backspace"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Space"
  | "Shift+Tab"
  | "Shift+Enter"
  | "Control+Enter"
  | "Meta+Enter";

export const AGENT_BROWSER_KEYS = [
  "Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space",
  "Shift+Tab", "Shift+Enter", "Control+Enter", "Meta+Enter",
] as const satisfies readonly AgentBrowserKey[];

/** Keys an agent may hold during a click or key press, in canonical order. */
export type AgentBrowserModifier = "Control" | "Alt" | "Shift" | "Meta";

export const AGENT_BROWSER_MODIFIERS = [
  "Control", "Alt", "Shift", "Meta",
] as const satisfies readonly AgentBrowserModifier[];

/**
 * Validates a list of held keys: each one known and listed once. Returns them
 * in canonical order, or null when the list is not acceptable.
 */
export function agentBrowserModifiers(value: unknown): AgentBrowserModifier[] | null {
  if (!Array.isArray(value) || value.length > AGENT_BROWSER_MODIFIERS.length) return null;
  if (!value.every((entry) => (AGENT_BROWSER_MODIFIERS as readonly unknown[]).includes(entry))) return null;
  if (new Set(value).size !== value.length) return null;
  return AGENT_BROWSER_MODIFIERS.filter((modifier) => value.includes(modifier));
}

/** The chord a key press sends: the key's own modifier merged with the held ones. */
export function agentBrowserKeyChord(
  key: AgentBrowserKey,
  modifiers: readonly AgentBrowserModifier[] = [],
): { key: string; modifiers: AgentBrowserModifier[]; label: string } {
  const [prefix, base] = key.split("+") as [string, string | undefined];
  const held = new Set<AgentBrowserModifier>(modifiers);
  if (base !== undefined) held.add(prefix as AgentBrowserModifier);
  const ordered = AGENT_BROWSER_MODIFIERS.filter((modifier) => held.has(modifier));
  const keyName = base ?? prefix;
  return { key: keyName, modifiers: ordered, label: [...ordered, keyName].join("+") };
}

const WAIT_PATH = new RegExp(AGENT_BROWSER_WAIT_PATH_PATTERN, "u");

function waitPathSegments(path: string): string[] {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.split("/").slice(1);
}

/**
 * Whether a page address has the given path. A "*" segment matches exactly
 * one non-empty segment; the query, fragment and origin are never compared,
 * and one trailing slash is ignored. Only a whole-path comparison is offered,
 * so a hidden path cannot be read back one character at a time.
 */
export function agentBrowserPathMatches(url: string, path: string): boolean {
  if (!WAIT_PATH.test(path)) return false;
  let actual: string;
  let expected: string;
  try {
    actual = new URL(url).pathname;
    expected = new URL(path, "http://localhost").pathname;
  } catch {
    return false;
  }
  const actualSegments = waitPathSegments(actual);
  const expectedSegments = waitPathSegments(expected);
  return actualSegments.length === expectedSegments.length
    && expectedSegments.every((segment, index) => segment === "*"
      ? actualSegments[index]!.length > 0
      : segment === actualSegments[index]);
}

export type AgentBrowserResult =
  | {
      ok: true;
      text: string;
      state: AgentBrowserState;
      image?: AgentBrowserImage;
    }
  | {
      ok: false;
      code: AgentBrowserFailureCode;
      message: string;
      reachedPage?: boolean;
    };

export const AGENT_BROWSER_FAILURE_CODES = [
  "cancelled",
  "interrupted",
  "invalid",
  "not-found",
  "sensitive",
  "timeout",
  "too-large",
  "unavailable",
] as const;

export type AgentBrowserFailureCode = (typeof AGENT_BROWSER_FAILURE_CODES)[number];

export const AGENT_BROWSER_TAB_ID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const UUID_PATTERN = new RegExp(AGENT_BROWSER_TAB_ID_PATTERN, "u");
const SAFE_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const SAFE_KEYS = new Set<AgentBrowserKey>(AGENT_BROWSER_KEYS);

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

export function agentBrowserTextLength(value: string): number {
  let length = value.length;
  for (let index = 0; index < value.length - 1; index += 1) {
    if (
      (value.charCodeAt(index) & 0xfc00) === 0xd800
      && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      length -= 1;
      index += 1;
    }
  }
  return length;
}

function safeText(value: unknown, maximum: number, multiline = false): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0")
    && (multiline || !/[\r\n]/u.test(value));
}

function safeCommandText(value: unknown, maximum: number, multiline = false): value is string {
  return typeof value === "string"
    && value.length > 0
    && agentBrowserTextLength(value) <= maximum
    && !value.includes("\0")
    && (multiline || !/[\r\n]/u.test(value));
}

function safeUrl(value: unknown): value is string {
  return safeCommandText(value, MAX_AGENT_BROWSER_URL_CHARS, true);
}

function safeDialog(value: unknown): boolean {
  return value === undefined || value === "accept" || value === "dismiss";
}

function safeRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_REF_PATTERN.test(value);
}

function safeScrollDelta(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0
    && Math.abs(value) <= MAX_AGENT_BROWSER_SCROLL_DELTA;
}

function safeClickCount(value: unknown): value is number {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value)
    && value >= 1 && value <= MAX_AGENT_BROWSER_CLICK_COUNT);
}

function heldModifiers(value: unknown): { modifiers?: AgentBrowserModifier[] } | null {
  if (value === undefined) return {};
  const modifiers = agentBrowserModifiers(value);
  if (!modifiers) return null;
  return modifiers.length > 0 ? { modifiers } : {};
}

export function safeAgentBrowserWaitPath(value: unknown): value is string {
  return safeCommandText(value, MAX_AGENT_BROWSER_WAIT_TEXT_CHARS) && WAIT_PATH.test(value);
}

function safeTabId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function safeViewportWidth(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= MIN_AGENT_BROWSER_VIEWPORT_WIDTH && value <= MAX_AGENT_BROWSER_VIEWPORT_WIDTH;
}

function safeViewportHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= MIN_AGENT_BROWSER_VIEWPORT_HEIGHT && value <= MAX_AGENT_BROWSER_VIEWPORT_HEIGHT;
}

function safePreset(value: unknown): value is AgentBrowserViewportPreset {
  return (AGENT_BROWSER_VIEWPORT_PRESETS as readonly string[]).includes(value as string);
}

function safeColorScheme(value: unknown): value is AgentBrowserColorScheme {
  return (AGENT_BROWSER_COLOR_SCHEMES as readonly string[]).includes(value as string);
}

export function parseAgentBrowserViewportRequest(value: unknown): AgentBrowserViewportRequest | null {
  if (!plainObject(value)) return null;
  if (exactKeys(value, ["preset"])) return safePreset(value.preset) ? { preset: value.preset } : null;
  return exactKeys(value, ["width", "height"])
    && safeViewportWidth(value.width)
    && safeViewportHeight(value.height)
    ? { width: value.width, height: value.height }
    : null;
}

function parseResizeCommand(value: Record<string, unknown>): AgentBrowserCommand | null {
  if (!exactKeys(value, ["action"], ["preset", "width", "height", "colorScheme"])) return null;
  const sized = Object.hasOwn(value, "width") || Object.hasOwn(value, "height");
  if (Object.hasOwn(value, "preset")) {
    if (sized || !safePreset(value.preset)) return null;
  } else if (sized) {
    if (!safeViewportWidth(value.width) || !safeViewportHeight(value.height)) return null;
  } else if (!Object.hasOwn(value, "colorScheme")) {
    return null;
  }
  if (Object.hasOwn(value, "colorScheme") && !safeColorScheme(value.colorScheme)) return null;
  return {
    action: "resize",
    ...(safePreset(value.preset) ? { preset: value.preset } : {}),
    ...(sized ? { width: value.width as number, height: value.height as number } : {}),
    ...(safeColorScheme(value.colorScheme) ? { colorScheme: value.colorScheme } : {}),
  };
}

export function parseAgentBrowserCommand(value: unknown): AgentBrowserCommand | null {
  if (!plainObject(value) || typeof value.action !== "string") return null;
  switch (value.action) {
    case "snapshot":
    case "screenshot":
    case "logs":
    case "tabs":
      return exactKeys(value, ["action"])
        ? { action: value.action }
        : null;
    case "resize":
      return parseResizeCommand(value);
    case "hover":
      return exactKeys(value, ["action", "ref"])
        && typeof value.ref === "string"
        && SAFE_REF_PATTERN.test(value.ref)
        ? { action: "hover", ref: value.ref }
        : null;
    case "select":
      return exactKeys(value, ["action", "ref", "value"])
        && typeof value.ref === "string"
        && SAFE_REF_PATTERN.test(value.ref)
        && safeCommandText(value.value, MAX_AGENT_BROWSER_SELECT_CHARS)
        ? { action: "select", ref: value.ref, value: value.value }
        : null;
    case "navigate":
      return exactKeys(value, ["action", "url"]) && safeUrl(value.url)
        ? { action: "navigate", url: value.url }
        : null;
    case "history":
      return exactKeys(value, ["action", "direction"])
        && (value.direction === "back" || value.direction === "forward" || value.direction === "reload")
        ? { action: "history", direction: value.direction }
        : null;
    case "click": {
      const held = heldModifiers(value.modifiers);
      return exactKeys(value, ["action", "ref"], ["dialog", "clickCount", "modifiers"])
        && safeRef(value.ref)
        && safeDialog(value.dialog)
        && safeClickCount(value.clickCount)
        && held
        ? {
            action: "click",
            ref: value.ref,
            ...(value.dialog === "accept" ? { dialog: "accept" as const } : {}),
            ...(value.clickCount === 2 || value.clickCount === 3 ? { clickCount: value.clickCount } : {}),
            ...held,
          }
        : null;
    }
    case "drag":
      return exactKeys(value, ["action", "ref", "targetRef"])
        && safeRef(value.ref)
        && safeRef(value.targetRef)
        && value.ref !== value.targetRef
        ? { action: "drag", ref: value.ref, targetRef: value.targetRef }
        : null;
    case "type":
      return exactKeys(value, ["action", "ref", "text", "replace"])
        && typeof value.ref === "string"
        && SAFE_REF_PATTERN.test(value.ref)
        && typeof value.text === "string"
        && agentBrowserTextLength(value.text) <= MAX_AGENT_BROWSER_TYPE_CHARS
        && !value.text.includes("\0")
        && typeof value.replace === "boolean"
        ? {
            action: "type",
            ref: value.ref,
            text: value.text,
            replace: value.replace,
          }
        : null;
    case "press": {
      const held = heldModifiers(value.modifiers);
      return exactKeys(value, ["action", "key"], ["dialog", "modifiers"])
        && typeof value.key === "string"
        && SAFE_KEYS.has(value.key as AgentBrowserKey)
        && safeDialog(value.dialog)
        && held
        ? {
            action: "press",
            key: value.key as AgentBrowserKey,
            ...(value.dialog === "accept" ? { dialog: "accept" as const } : {}),
            ...held,
          }
        : null;
    }
    case "scroll":
      if (exactKeys(value, ["action", "ref"])) {
        return safeRef(value.ref)
          ? { action: "scroll", ref: value.ref }
          : null;
      }
      return exactKeys(value, ["action"], ["deltaX", "deltaY"])
        && (value.deltaX !== undefined || value.deltaY !== undefined)
        && (value.deltaX === undefined || safeScrollDelta(value.deltaX))
        && (value.deltaY === undefined || safeScrollDelta(value.deltaY))
        ? {
            action: "scroll",
            ...(value.deltaX === undefined ? {} : { deltaX: value.deltaX as number }),
            ...(value.deltaY === undefined ? {} : { deltaY: value.deltaY as number }),
          }
        : null;
    case "wait":
      return exactKeys(value, ["action", "state", "timeoutMs"], ["text", "path", "ref"])
        && (value.state === "present" || value.state === "absent")
        && typeof value.timeoutMs === "number"
        && Number.isSafeInteger(value.timeoutMs)
        && value.timeoutMs >= MIN_AGENT_BROWSER_WAIT_MS
        && value.timeoutMs <= MAX_AGENT_BROWSER_WAIT_MS
        && (value.text === undefined
          || (safeCommandText(value.text, MAX_AGENT_BROWSER_WAIT_TEXT_CHARS) && value.text.trim().length > 0))
        && (value.path === undefined || safeAgentBrowserWaitPath(value.path))
        && (value.ref === undefined || safeRef(value.ref))
        ? {
            action: "wait",
            ...(typeof value.text === "string" ? { text: value.text } : {}),
            ...(typeof value.path === "string" ? { path: value.path } : {}),
            ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
            state: value.state,
            timeoutMs: value.timeoutMs,
          }
        : null;
    case "tab-open":
      return exactKeys(value, ["action"], ["url"])
        && (value.url === undefined || safeUrl(value.url))
        ? {
            action: "tab-open",
            ...(typeof value.url === "string" ? { url: value.url } : {}),
          }
        : null;
    case "tab-activate":
    case "tab-close":
      return exactKeys(value, ["action", "tabId"])
        && safeTabId(value.tabId)
        ? { action: value.action, tabId: value.tabId }
        : null;
    default:
      return null;
  }
}

function safeIsoDate(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && !Number.isNaN(Date.parse(value));
}

function safeTab(value: unknown): value is AgentBrowserTab {
  return plainObject(value)
    && exactKeys(value, ["id", "title", "url", "loading"])
    && safeTabId(value.id)
    && typeof value.title === "string"
    && value.title.length <= 300
    && typeof value.url === "string"
    && value.url.length <= 4_096
    && typeof value.loading === "boolean";
}

function safeActivity(value: unknown): value is AgentBrowserActivity {
  if (value === null) return false;
  if (!plainObject(value) || !exactKeys(
    value,
    ["action", "label", "tabId", "at"],
    ["x", "y"],
  )) return false;
  const actions = new Set<AgentBrowserActionKind>(AGENT_BROWSER_ACTION_KINDS);
  return typeof value.action === "string"
    && actions.has(value.action as AgentBrowserActionKind)
    && typeof value.label === "string"
    && value.label.length > 0
    && value.label.length <= 300
    && safeTabId(value.tabId)
    && safeIsoDate(value.at)
    && (value.x === undefined || (
      typeof value.x === "number" && Number.isFinite(value.x)
    ))
    && (value.y === undefined || (
      typeof value.y === "number" && Number.isFinite(value.y)
    ));
}

export function parseAgentBrowserViewport(value: unknown): AgentBrowserViewport | null {
  return plainObject(value)
    && exactKeys(value, ["width", "height", "fit", "mobile", "colorScheme"])
    && typeof value.width === "number" && Number.isSafeInteger(value.width) && value.width > 0
    && typeof value.height === "number" && Number.isSafeInteger(value.height) && value.height > 0
    && typeof value.fit === "boolean"
    && typeof value.mobile === "boolean"
    && safeColorScheme(value.colorScheme)
    ? {
        width: value.width,
        height: value.height,
        fit: value.fit,
        mobile: value.mobile,
        colorScheme: value.colorScheme,
      }
    : null;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

function safeImage(value: unknown): value is AgentBrowserImage {
  if (!plainObject(value) || !exactKeys(value, ["mimeType", "data", "width", "height"])) return false;
  if (value.mimeType !== "image/png" || typeof value.data !== "string") return false;
  if (value.data.length === 0 || value.data.length % 4 !== 0 || !BASE64_PATTERN.test(value.data)) return false;
  if (Math.floor((value.data.length * 3) / 4) > MAX_AGENT_BROWSER_IMAGE_BYTES) return false;
  const edge = (entry: unknown): boolean => typeof entry === "number"
    && Number.isSafeInteger(entry) && entry > 0 && entry <= MAX_AGENT_BROWSER_IMAGE_EDGE;
  return edge(value.width) && edge(value.height);
}

function safeState(value: unknown): value is AgentBrowserState {
  return plainObject(value)
    && exactKeys(value, ["activeTabId", "tabs", "activity"], ["controller", "viewport"])
    && (value.controller === undefined || value.controller === "user")
    && (value.viewport === undefined || parseAgentBrowserViewport(value.viewport) !== null)
    && safeTabId(value.activeTabId)
    && Array.isArray(value.tabs)
    && value.tabs.length > 0
    && value.tabs.length <= 8
    && value.tabs.every(safeTab)
    && value.tabs.some((tab) => tab.id === value.activeTabId)
    && (value.activity === null || safeActivity(value.activity));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseAgentBrowserResult(value: unknown): AgentBrowserResult | null {
  if (!plainObject(value) || typeof value.ok !== "boolean") return null;
  if (!value.ok) {
    return exactKeys(value, ["ok", "code", "message"], ["reachedPage"])
      && typeof value.code === "string"
      && (AGENT_BROWSER_FAILURE_CODES as readonly string[]).includes(value.code)
      && safeText(value.message, 1_000, true)
      && (value.reachedPage === undefined || typeof value.reachedPage === "boolean")
      ? {
          ok: false,
          code: value.code as AgentBrowserFailureCode,
          message: value.message,
          ...(typeof value.reachedPage === "boolean" ? { reachedPage: value.reachedPage } : {}),
        }
      : null;
  }
  if (
    !exactKeys(value, ["ok", "text", "state"], ["image"])
    || typeof value.text !== "string"
    || utf8Bytes(value.text) > MAX_AGENT_BROWSER_TEXT_BYTES
    || value.text.includes("\0")
    || !safeState(value.state)
    || (value.image !== undefined && !safeImage(value.image))
  ) return null;
  return {
    ok: true,
    text: value.text,
    state: value.state,
    ...(value.image === undefined ? {} : { image: value.image as AgentBrowserImage }),
  };
}
