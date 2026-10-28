import { MAX_PROVIDER_HOST_TOOL_IMAGE_BYTES, MAX_PROVIDER_HOST_TOOL_RESULT_BYTES } from "./provider-host-tools";

export const MAX_AGENT_BROWSER_TEXT_BYTES = MAX_PROVIDER_HOST_TOOL_RESULT_BYTES;
export const MAX_AGENT_BROWSER_IMAGE_BYTES = MAX_PROVIDER_HOST_TOOL_IMAGE_BYTES;
export const MAX_AGENT_BROWSER_IMAGE_EDGE = 1_568;
export const MAX_AGENT_BROWSER_TYPE_CHARS = 4_000;
export const MAX_AGENT_BROWSER_SELECT_CHARS = 200;
export const MAX_AGENT_BROWSER_URL_CHARS = 4_096;
export const MAX_AGENT_BROWSER_WAIT_TEXT_CHARS = 200;
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
  | "tab-open"
  | "tab-activate"
  | "tab-close";

export const AGENT_BROWSER_ACTION_KINDS = [
  "navigate", "click", "type", "press", "scroll", "snapshot", "screenshot",
  "resize", "hover", "select", "tab-open", "tab-activate", "tab-close",
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
  | { action: "click"; ref: string; dialog?: "accept" }
  | { action: "hover"; ref: string }
  | { action: "type"; ref: string; text: string; replace: boolean }
  | { action: "select"; ref: string; value: string }
  | { action: "press"; key: AgentBrowserKey; dialog?: "accept" }
  | { action: "scroll"; deltaY: number }
  | { action: "scroll"; ref: string }
  | { action: "wait"; text?: string; state: "present" | "absent"; timeoutMs: number }
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
    case "click":
      return exactKeys(value, ["action", "ref"], ["dialog"])
        && typeof value.ref === "string"
        && SAFE_REF_PATTERN.test(value.ref)
        && safeDialog(value.dialog)
        ? { action: "click", ref: value.ref, ...(value.dialog === "accept" ? { dialog: "accept" as const } : {}) }
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
    case "press":
      return exactKeys(value, ["action", "key"], ["dialog"])
        && typeof value.key === "string"
        && SAFE_KEYS.has(value.key as AgentBrowserKey)
        && safeDialog(value.dialog)
        ? {
            action: "press",
            key: value.key as AgentBrowserKey,
            ...(value.dialog === "accept" ? { dialog: "accept" as const } : {}),
          }
        : null;
    case "scroll":
      if (exactKeys(value, ["action", "ref"])) {
        return typeof value.ref === "string" && SAFE_REF_PATTERN.test(value.ref)
          ? { action: "scroll", ref: value.ref }
          : null;
      }
      return exactKeys(value, ["action", "deltaY"])
        && typeof value.deltaY === "number"
        && Number.isSafeInteger(value.deltaY)
        && value.deltaY >= -2_000
        && value.deltaY <= 2_000
        && value.deltaY !== 0
        ? { action: "scroll", deltaY: value.deltaY }
        : null;
    case "wait":
      return exactKeys(value, ["action", "state", "timeoutMs"], ["text"])
        && (value.state === "present" || value.state === "absent")
        && typeof value.timeoutMs === "number"
        && Number.isSafeInteger(value.timeoutMs)
        && value.timeoutMs >= MIN_AGENT_BROWSER_WAIT_MS
        && value.timeoutMs <= MAX_AGENT_BROWSER_WAIT_MS
        && (value.text === undefined
          || (safeCommandText(value.text, MAX_AGENT_BROWSER_WAIT_TEXT_CHARS) && value.text.trim().length > 0))
        ? {
            action: "wait",
            ...(typeof value.text === "string" ? { text: value.text } : {}),
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
