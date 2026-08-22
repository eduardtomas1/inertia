export const MAX_AGENT_BROWSER_TEXT_CHARS = 64_000;
export const MAX_AGENT_BROWSER_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_AGENT_BROWSER_TYPE_CHARS = 4_000;

export type AgentBrowserActionKind =
  | "navigate"
  | "click"
  | "type"
  | "press"
  | "scroll"
  | "snapshot"
  | "screenshot"
  | "tab-open"
  | "tab-activate"
  | "tab-close";

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
}

export type AgentBrowserCommand =
  | { action: "snapshot" }
  | { action: "screenshot" }
  | { action: "navigate"; url: string }
  | { action: "click"; ref: string }
  | { action: "type"; ref: string; text: string; replace: boolean }
  | { action: "press"; key: AgentBrowserKey }
  | { action: "scroll"; deltaY: number }
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
  | "Space";

export type AgentBrowserResult =
  | {
      ok: true;
      text: string;
      state: AgentBrowserState;
      image?: {
        mimeType: "image/png";
        data: string;
      };
    }
  | {
      ok: false;
      code: "cancelled" | "invalid" | "not-found" | "too-large" | "unavailable";
      message: string;
    };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const SAFE_KEYS = new Set<AgentBrowserKey>([
  "Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space",
]);

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

function safeText(value: unknown, maximum: number, multiline = false): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0")
    && (multiline || !/[\r\n]/u.test(value));
}

function safeUrl(value: unknown): value is string {
  return safeText(value, 4_096, true);
}

function safeTabId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseAgentBrowserCommand(value: unknown): AgentBrowserCommand | null {
  if (!plainObject(value) || typeof value.action !== "string") return null;
  switch (value.action) {
    case "snapshot":
    case "screenshot":
    case "tabs":
      return exactKeys(value, ["action"])
        ? { action: value.action }
        : null;
    case "navigate":
      return exactKeys(value, ["action", "url"]) && safeUrl(value.url)
        ? { action: "navigate", url: value.url }
        : null;
    case "click":
      return exactKeys(value, ["action", "ref"])
        && typeof value.ref === "string"
        && SAFE_REF_PATTERN.test(value.ref)
        ? { action: "click", ref: value.ref }
        : null;
    case "type":
      return exactKeys(value, ["action", "ref", "text", "replace"])
        && typeof value.ref === "string"
        && SAFE_REF_PATTERN.test(value.ref)
        && typeof value.text === "string"
        && value.text.length <= MAX_AGENT_BROWSER_TYPE_CHARS
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
      return exactKeys(value, ["action", "key"])
        && typeof value.key === "string"
        && SAFE_KEYS.has(value.key as AgentBrowserKey)
        ? { action: "press", key: value.key as AgentBrowserKey }
        : null;
    case "scroll":
      return exactKeys(value, ["action", "deltaY"])
        && typeof value.deltaY === "number"
        && Number.isSafeInteger(value.deltaY)
        && value.deltaY >= -2_000
        && value.deltaY <= 2_000
        && value.deltaY !== 0
        ? { action: "scroll", deltaY: value.deltaY }
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
  const actions = new Set<AgentBrowserActionKind>([
    "navigate", "click", "type", "press", "scroll", "snapshot",
    "screenshot", "tab-open", "tab-activate", "tab-close",
  ]);
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

function safeState(value: unknown): value is AgentBrowserState {
  return plainObject(value)
    && exactKeys(value, ["activeTabId", "tabs", "activity"])
    && safeTabId(value.activeTabId)
    && Array.isArray(value.tabs)
    && value.tabs.length > 0
    && value.tabs.length <= 8
    && value.tabs.every(safeTab)
    && value.tabs.some((tab) => tab.id === value.activeTabId)
    && (value.activity === null || safeActivity(value.activity));
}

function decodedBase64Bytes(value: string): number | null {
  if (
    value.length === 0
    || value.length > Math.ceil(MAX_AGENT_BROWSER_SCREENSHOT_BYTES / 3) * 4
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

export function parseAgentBrowserResult(value: unknown): AgentBrowserResult | null {
  if (!plainObject(value) || typeof value.ok !== "boolean") return null;
  if (!value.ok) {
    return exactKeys(value, ["ok", "code", "message"])
      && (
        value.code === "cancelled"
        || value.code === "invalid"
        || value.code === "not-found"
        || value.code === "too-large"
        || value.code === "unavailable"
      )
      && safeText(value.message, 1_000, true)
      ? { ok: false, code: value.code, message: value.message }
      : null;
  }
  if (
    !exactKeys(value, ["ok", "text", "state"], ["image"])
    || typeof value.text !== "string"
    || value.text.length > MAX_AGENT_BROWSER_TEXT_CHARS
    || value.text.includes("\0")
    || !safeState(value.state)
  ) return null;
  if (value.image === undefined) {
    return { ok: true, text: value.text, state: value.state };
  }
  if (
    !plainObject(value.image)
    || !exactKeys(value.image, ["mimeType", "data"])
    || value.image.mimeType !== "image/png"
    || typeof value.image.data !== "string"
  ) return null;
  const bytes = decodedBase64Bytes(value.image.data);
  return bytes !== null && bytes <= MAX_AGENT_BROWSER_SCREENSHOT_BYTES
    ? {
        ok: true,
        text: value.text,
        state: value.state,
        image: { mimeType: "image/png", data: value.image.data },
      }
    : null;
}
