import type { WebContents } from "electron";

import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../shared/agent-browser.js";

const AGENT_BROWSER_WORLD_ID = 1001;
const MAX_SEMANTIC_ELEMENTS = 200;
const MAX_PAGE_TEXT_CHARS = 12_000;

export interface PreviewAgentTarget {
  found: boolean;
  disabled?: boolean;
  label?: string;
  x?: number;
  y?: number;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function viewport(value: unknown): Record<string, number> {
  if (!plainObject(value)) return {};
  const entries = ["width", "height", "scrollX", "scrollY"]
    .flatMap((key) => {
      const candidate = value[key];
      return typeof candidate === "number" && Number.isFinite(candidate)
        ? [[key, candidate] as const]
        : [];
    });
  return Object.fromEntries(entries);
}

function serializedSnapshot(
  value: Record<string, unknown>,
  text: string,
  elements: readonly unknown[],
  truncated: boolean,
): string {
  return JSON.stringify({
    title: boundedString(value.title, 300),
    url: boundedString(value.url, 4_096),
    viewport: viewport(value.viewport),
    text,
    elements,
    truncated,
  });
}

/** Keep semantic JSON intact at the exact downstream host-tool byte limit. */
export function serializeAgentPageSnapshot(value: unknown): string {
  if (!plainObject(value) || !Array.isArray(value.elements)) {
    throw new Error("The semantic browser snapshot was malformed.");
  }
  const sourceText = boundedString(value.text, MAX_PAGE_TEXT_CHARS);
  const sourceElements = value.elements;
  const byteLength = (candidate: string): number => Buffer.byteLength(candidate, "utf8");
  let text = sourceText;
  let elements = sourceElements;
  let truncated = value.truncated === true;
  let serialized = serializedSnapshot(value, text, elements, truncated);
  if (byteLength(serialized) <= MAX_AGENT_BROWSER_TEXT_BYTES) return serialized;

  truncated = true;
  text = text.slice(0, 4_000);
  let low = 0;
  let high = sourceElements.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = serializedSnapshot(
      value,
      text,
      sourceElements.slice(0, middle),
      true,
    );
    if (byteLength(candidate) <= MAX_AGENT_BROWSER_TEXT_BYTES) low = middle;
    else high = middle - 1;
  }
  elements = sourceElements.slice(0, low);
  serialized = serializedSnapshot(value, text, elements, truncated);
  if (byteLength(serialized) > MAX_AGENT_BROWSER_TEXT_BYTES) {
    throw new Error("The semantic browser snapshot exceeded its bounded result size.");
  }
  return serialized;
}

function target(value: unknown): PreviewAgentTarget {
  if (!plainObject(value) || value.found !== true) return { found: false };
  const x = typeof value.x === "number" && Number.isFinite(value.x)
    ? value.x
    : undefined;
  const y = typeof value.y === "number" && Number.isFinite(value.y)
    ? value.y
    : undefined;
  return {
    found: true,
    disabled: value.disabled === true,
    label: boundedString(value.label, 300),
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
  };
}

async function execute(contents: WebContents, code: string): Promise<unknown> {
  return await contents.executeJavaScriptInIsolatedWorld(
    AGENT_BROWSER_WORLD_ID,
    [{ code }],
    true,
  );
}

export async function semanticPageSnapshot(
  contents: WebContents,
): Promise<string> {
  const value = await execute(contents, `(() => {
    const owner = globalThis;
    const state = owner.__inertiaAgentBrowser ??= {
      refs: new Map(),
      nodes: new WeakMap(),
      next: 1,
    };
    state.refs.clear();
    const normalize = (value, maximum = 300) => String(value ?? "")
      .replace(/\\s+/gu, " ").trim().slice(0, maximum);
    const visible = (element, rect) => {
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < innerHeight && rect.left < innerWidth
        && style.visibility !== "hidden" && style.display !== "none"
        && Number(style.opacity || "1") > 0;
    };
    const roleFor = (element) => normalize(
      element.getAttribute("role")
      || ({ A: "link", BUTTON: "button", INPUT: "input", SELECT: "select", TEXTAREA: "textbox", SUMMARY: "button" })[element.tagName]
      || element.tagName.toLowerCase(),
      50,
    );
    const nameFor = (element) => normalize(
      element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.getAttribute("placeholder")
      || (element.labels && element.labels[0]?.innerText)
      || element.innerText
      || element.value,
    );
    const selector = [
      "a[href]", "button", "input", "textarea", "select", "summary",
      "[role]", "[contenteditable='true']", "[tabindex]",
    ].join(",");
    const elements = [];
    for (const element of document.querySelectorAll(selector)) {
      if (elements.length >= ${MAX_SEMANTIC_ELEMENTS}) break;
      const rect = element.getBoundingClientRect();
      if (!visible(element, rect)) continue;
      let ref = state.nodes.get(element);
      if (!ref) {
        ref = "e" + state.next++;
        state.nodes.set(element, ref);
      }
      state.refs.set(ref, element);
      elements.push({
        ref,
        role: roleFor(element),
        name: nameFor(element),
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        checked: typeof element.checked === "boolean" ? element.checked : undefined,
        value: typeof element.value === "string" ? normalize(element.value, 500) : undefined,
        rect: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height),
        },
      });
    }
    return {
      title: normalize(document.title, 300),
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      text: normalize(document.body?.innerText, ${MAX_PAGE_TEXT_CHARS}),
      elements,
      truncated: elements.length >= ${MAX_SEMANTIC_ELEMENTS},
    };
  })()`);
  return serializeAgentPageSnapshot(value);
}

export async function locateAgentPageRef(
  contents: WebContents,
  ref: string,
  focus = false,
  replace = false,
): Promise<PreviewAgentTarget> {
  const value = await execute(contents, `(() => {
    const element = globalThis.__inertiaAgentBrowser?.refs?.get(${JSON.stringify(ref)});
    if (!element || !element.isConnected) return { found: false };
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0
      || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth
      || style.visibility === "hidden" || style.display === "none"
      || Number(style.opacity || "1") <= 0) return { found: false };
    if (${focus ? "true" : "false"}) {
      element.focus({ preventScroll: false });
      if (${replace ? "true" : "false"}) {
        if (typeof element.select === "function") element.select();
        else if (element.isContentEditable) {
          const selection = getSelection();
          selection?.selectAllChildren(element);
        }
      }
    }
    return {
      found: true,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      label: String(element.getAttribute("aria-label") || element.innerText || element.value || "element")
        .replace(/\\s+/gu, " ").trim().slice(0, 300),
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
  })()`);
  return target(value);
}

export async function showAgentPageCursor(
  contents: WebContents,
  x: number,
  y: number,
  label: string,
): Promise<void> {
  await execute(contents, `(() => {
    const id = "__inertia_agent_cursor";
    let cursor = document.getElementById(id);
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = id;
      Object.assign(cursor.style, {
        position: "fixed", pointerEvents: "none", zIndex: "2147483647",
        display: "flex", alignItems: "center", gap: "7px",
        transform: "translate(-8px, -8px)", transition: "left 160ms ease, top 160ms ease",
        font: "600 12px/1.2 -apple-system, BlinkMacSystemFont, sans-serif",
        color: "white", filter: "drop-shadow(0 3px 8px rgba(0,0,0,.5))",
      });
      const dot = document.createElement("span");
      Object.assign(dot.style, {
        width: "16px", height: "16px", borderRadius: "999px",
        background: "#7567ff", border: "2px solid rgba(255,255,255,.95)",
        boxSizing: "border-box", boxShadow: "0 0 0 4px rgba(117,103,255,.22)",
        flex: "0 0 auto",
      });
      const copy = document.createElement("span");
      copy.dataset.inertiaAgentCursorLabel = "true";
      Object.assign(copy.style, {
        padding: "5px 8px", borderRadius: "8px",
        background: "rgba(30,28,42,.92)", border: "1px solid rgba(255,255,255,.14)",
        maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      });
      cursor.append(dot, copy);
      document.documentElement.append(cursor);
    }
    cursor.style.left = ${JSON.stringify(`${Math.round(x)}px`)};
    cursor.style.top = ${JSON.stringify(`${Math.round(y)}px`)};
    const copy = cursor.querySelector("[data-inertia-agent-cursor-label]");
    if (copy) copy.textContent = ${JSON.stringify(label.slice(0, 300))};
    cursor.animate(
      [{ opacity: .35, transform: "translate(-8px,-8px) scale(.82)" }, { opacity: 1, transform: "translate(-8px,-8px) scale(1)" }],
      { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  })()`);
}
