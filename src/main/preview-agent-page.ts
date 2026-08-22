import type { WebContents } from "electron";

import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../shared/agent-browser.js";
import { installPreviewAgentPrivacyGuard } from "../shared/preview-agent-privacy-guard.js";

// Electron's context-isolated preload world. This is the only world that owns
// credential identity; the untrusted page cannot read or mutate its state.
export const AGENT_BROWSER_WORLD_ID = 999;
const MAX_SEMANTIC_ELEMENTS = 200;
const MAX_SEMANTIC_SCAN_NODES = 4_000;
const MAX_PAGE_TEXT_CHARS = 12_000;
const MAX_BODY_TEXT_SOURCE_CHARS = 24_000;
const MAX_BODY_TEXT_NODES = 4_000;
const MAX_REMEMBERED_PASSWORD_VALUES = 32;

export interface PreviewAgentTarget {
  found: boolean;
  blocked?: boolean;
  disabled?: boolean;
  editable?: boolean;
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
  const rawText = typeof value.text === "string" ? value.text : "";
  const sourceText = boundedString(rawText, MAX_PAGE_TEXT_CHARS);
  const sourceElements = value.elements;
  const byteLength = (candidate: string): number => Buffer.byteLength(candidate, "utf8");
  let text = sourceText;
  let elements = sourceElements;
  let truncated = value.truncated === true || rawText.length > MAX_PAGE_TEXT_CHARS;
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
    blocked: value.blocked === true,
    disabled: value.disabled === true,
    editable: value.editable === true,
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

export async function waitForAgentPageHover(contents: WebContents): Promise<void> {
  await execute(contents, "new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
}

export async function semanticPageSnapshot(
  contents: WebContents,
): Promise<string> {
  const value = await execute(contents, `(() => {
    const owner = globalThis;
    const state = owner.__inertiaAgentBrowser ??= {
      refs: new Map(),
      nodes: new WeakMap(),
      passwordNodes: new WeakSet(),
      passwordValues: new Set(),
      next: 1,
    };
    state.refs.clear();
    const passwordNodes = state.passwordNodes ??= new WeakSet();
    const passwordValues = state.passwordValues ??= new Set();
    const normalizeText = (value) => String(value ?? "")
      .replace(/\\s+/gu, " ").trim();
    const normalize = (value, maximum = 300) => normalizeText(value)
      .slice(0, maximum);
    const elementRoot = document.documentElement || document.body;
    const elementIterator = elementRoot
      ? document.createNodeIterator(elementRoot, 1)
      : null;
    const scannedElementNodes = [];
    let elementScanTruncated = !elementIterator;
    while (elementIterator && scannedElementNodes.length < ${MAX_SEMANTIC_SCAN_NODES}) {
      const element = elementIterator.nextNode();
      if (!element) break;
      scannedElementNodes.push(element);
    }
    if (scannedElementNodes.length >= ${MAX_SEMANTIC_SCAN_NODES}
      && elementIterator?.nextNode()) elementScanTruncated = true;
    const scannedInputs = scannedElementNodes.filter((element) => element.tagName === "INPUT");
    const visible = (element, rect) => {
      const style = getComputedStyle(element);
      let ancestor = element.parentElement;
      while (ancestor) {
        if (Number(getComputedStyle(ancestor).opacity || "1") <= 0) return false;
        ancestor = ancestor.parentElement;
      }
      return rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < innerHeight && rect.left < innerWidth
        && style.visibility !== "hidden" && style.display !== "none"
        && Number(style.opacity || "1") > 0;
    };
    const ariaDisabled = (element) => {
      let current = element;
      while (current) {
        if (String(current.getAttribute?.("aria-disabled") || "").toLowerCase() === "true") {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    };
    const rememberPasswordValue = (value) => {
      const normalized = normalizeText(value);
      if (!normalized) return;
      passwordValues.delete(normalized);
      passwordValues.add(normalized);
      while (passwordValues.size > ${MAX_REMEMBERED_PASSWORD_VALUES}) {
        passwordValues.delete(passwordValues.values().next().value);
      }
    };
    for (const input of scannedInputs) {
      const value = normalizeText(input.value);
      if (String(input.type || "").toLowerCase() === "password"
        || (value && passwordValues.has(value))) {
        passwordNodes.add(input);
        rememberPasswordValue(value);
      }
    }
    const passwordField = (element) => element.tagName === "INPUT"
      && (
        String(element.type || "").toLowerCase() === "password"
        || passwordNodes.has(element)
      );
    const sensitiveText = Array.from(passwordValues);
    for (const input of scannedInputs) {
      if (!passwordField(input)) continue;
      const labels = input.labels;
      for (let index = 0; index < Math.min(labels?.length || 0, 16); index += 1) {
        sensitiveText.push(normalizeText(labels[index]?.innerText));
      }
      const value = normalizeText(input.value);
      rememberPasswordValue(value);
      sensitiveText.push(value);
    }
    state.sensitiveText = sensitiveText;
    const redact = (value, maximum) => {
      let text = normalizeText(value);
      for (const sensitive of sensitiveText) {
        if (!sensitive) continue;
        text = text.split(sensitive).join("[redacted]");
        text = text.split(encodeURIComponent(sensitive)).join("[redacted]");
      }
      return text.slice(0, maximum);
    };
    const routeUrl = (() => {
      try {
        const parsed = new URL(location.href);
        return parsed.origin;
      } catch {
        return "";
      }
    })();
    const roleFor = (element) => passwordField(element)
      ? "input"
      : redact(
          element.getAttribute("role")
          || ({ A: "link", BUTTON: "button", INPUT: "input", SELECT: "select", TEXTAREA: "textbox", SUMMARY: "button" })[element.tagName]
          || element.tagName.toLowerCase(),
          50,
        );
    const nameFor = (element) => passwordField(element)
      ? "Password field"
      : redact(
          element.getAttribute("aria-label")
          || element.getAttribute("title")
          || element.getAttribute("placeholder")
          || (element.labels && element.labels[0]?.innerText)
          || element.innerText
          || element.value,
          300,
        );
    const semanticTags = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"]);
    const hasAttribute = (element, name) => element.hasAttribute?.(name) === true
      || (typeof element.getAttribute === "function" && element.getAttribute(name) !== null);
    const semanticCandidate = (element) => semanticTags.has(element.tagName)
      || (element.tagName === "A" && hasAttribute(element, "href"))
      || hasAttribute(element, "role")
      || hasAttribute(element, "contenteditable")
      || hasAttribute(element, "tabindex");
    const elements = [];
    for (const element of scannedElementNodes) {
      if (!semanticCandidate(element)) continue;
      if (elements.length >= ${MAX_SEMANTIC_ELEMENTS}) {
        elementScanTruncated = true;
        break;
      }
      if (element.tagName === "INPUT"
        && String(element.type || "").toLowerCase() === "file") continue;
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
        disabled: Boolean(
          element.matches?.(":disabled")
          || element.disabled
          || ariaDisabled(element)
        ),
        checked: typeof element.checked === "boolean" ? element.checked : undefined,
        value: typeof element.value === "string"
          ? passwordField(element) ? "[redacted]" : redact(element.value, 500)
          : undefined,
        rect: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height),
        },
      });
    }
    const textStructureVisibility = new WeakMap();
    const textStructureVisible = (element) => {
      const chain = [];
      let current = element;
      while (current && !textStructureVisibility.has(current)) {
        chain.push(current);
        current = current.parentElement;
      }
      let allowed = current ? textStructureVisibility.get(current) !== false : true;
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const candidate = chain[index];
        const style = getComputedStyle(candidate);
        allowed = allowed
          && !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(candidate.tagName)
          && candidate.hidden !== true
          && style.display !== "none"
          && Number(style.opacity || "1") > 0;
        textStructureVisibility.set(candidate, allowed);
      }
      return allowed;
    };
    const textVisible = (element) => textStructureVisible(element)
      && getComputedStyle(element).visibility !== "hidden";
    const textChunks = [];
    let sourceCharacters = 0;
    let visitedNodes = 0;
    let bodyTruncated = false;
    const body = document.body;
    let node = body?.firstChild || null;
    while (node) {
      visitedNodes += 1;
      if (visitedNodes > ${MAX_BODY_TEXT_NODES}) { bodyTruncated = true; break; }
      if (node?.nodeType === 3) {
        if (!node.parentElement || textVisible(node.parentElement)) {
          const value = String(node.nodeValue || "");
          const remaining = ${MAX_BODY_TEXT_SOURCE_CHARS} - sourceCharacters;
          if (value.length > remaining) {
            textChunks.push(value.slice(0, Math.max(0, remaining)));
            bodyTruncated = true;
            break;
          }
          textChunks.push(value);
          sourceCharacters += value.length;
        }
      } else if (node.nodeType === 1 && textStructureVisible(node) && node.firstChild) {
        node = node.firstChild;
        continue;
      }
      while (node && node !== body && !node.nextSibling) node = node.parentNode;
      node = node && node !== body ? node.nextSibling : null;
    }
    const normalizedBodyText = normalizeText(textChunks.join(" "));
    if (normalizedBodyText.length > ${MAX_PAGE_TEXT_CHARS}) bodyTruncated = true;
    const bodyText = normalizedBodyText.slice(0, ${MAX_PAGE_TEXT_CHARS});
    return {
      title: redact(document.title, 300),
      url: redact(routeUrl, 4096),
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      text: redact(bodyText, ${MAX_PAGE_TEXT_CHARS}),
      elements,
      truncated: elementScanTruncated
        || elements.length >= ${MAX_SEMANTIC_ELEMENTS}
        || bodyTruncated,
    };
  })()`);
  return serializeAgentPageSnapshot(value);
}

export async function installAgentPagePrivacyGuard(contents: WebContents): Promise<void> {
  await execute(contents, `(${installPreviewAgentPrivacyGuard.toString()})()`);
}

export async function agentPageHasSensitiveEvidence(contents: WebContents): Promise<boolean> {
  const value = await execute(contents, `(() => {
    const state = globalThis.__inertiaAgentBrowser;
    if (state?.privacyGuardInstalled !== true) {
      throw new Error("The Browser privacy guard is unavailable.");
    }
    const normalize = (value) => String(value ?? "").replace(/\\s+/gu, " ").trim();
    const root = document.documentElement || document.body;
    const iterator = root && typeof document.createNodeIterator === "function"
      ? document.createNodeIterator(root, 1)
      : null;
    let scanned = 0;
    while (iterator && scanned < ${MAX_SEMANTIC_SCAN_NODES}) {
      const input = iterator.nextNode();
      if (!input) break;
      scanned += 1;
      if (input.tagName !== "INPUT") continue;
      const value = normalize(input.value);
      if (String(input.type || "").toLowerCase() !== "password"
        && !state.passwordNodes.has(input)) continue;
      state.passwordNodes.add(input);
      if (value) {
        state.passwordValues.delete(value);
        state.passwordValues.add(value);
        while (state.passwordValues.size > ${MAX_REMEMBERED_PASSWORD_VALUES}) {
          state.passwordValues.delete(state.passwordValues.values().next().value);
        }
      }
    }
    if (!iterator || (scanned >= ${MAX_SEMANTIC_SCAN_NODES} && iterator.nextNode())) {
      state.nestedContentObserved = true;
    }
    return state.passwordValues.size > 0 || state.nestedContentObserved === true;
  })()`);
  return value === true;
}

export async function setAgentPageInputGuard(
  contents: WebContents,
  active: boolean,
): Promise<void> {
  const updated = await execute(contents, `(() => {
    const state = globalThis.__inertiaAgentBrowser;
    if (state?.privacyGuardInstalled !== true) return false;
    state.agentInputActive = ${active ? "true" : "false"};
    return true;
  })()`);
  if (updated !== true) throw new Error("The Browser privacy guard is unavailable.");
}

export async function locateAgentPageRef(
  contents: WebContents,
  ref: string,
  focus = false,
  replace = false,
): Promise<PreviewAgentTarget> {
  const value = await execute(contents, `(() => {
    const state = globalThis.__inertiaAgentBrowser;
    const element = state?.refs?.get(${JSON.stringify(ref)});
    if (!element || !element.isConnected) return { found: false };
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0
      || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth
      || style.visibility === "hidden" || style.display === "none"
      || Number(style.opacity || "1") <= 0) return { found: false };
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return { found: false };
    const x = left + (right - left) / 2;
    const y = top + (bottom - top) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) {
      return { found: false };
    }
    let ancestor = element.parentElement;
    while (ancestor) {
      if (Number(getComputedStyle(ancestor).opacity || "1") <= 0) {
        return { found: false };
      }
      ancestor = ancestor.parentElement;
    }
    const actionableRoles = new Set([
      "button", "checkbox", "combobox", "link", "menuitem", "menuitemcheckbox",
      "menuitemradio", "option", "radio", "searchbox", "slider", "spinbutton",
      "switch", "tab", "textbox", "treeitem",
    ]);
    const actionable = (candidate) => candidate.matches?.(
      "a[href],button,input,textarea,select,summary,[contenteditable]:not([contenteditable='false']),[tabindex]",
    ) || actionableRoles.has(String(candidate.getAttribute?.("role") || "").toLowerCase());
    let hitOwner = hit;
    while (hitOwner && hitOwner !== element) {
      if (actionable(hitOwner)) return { found: false };
      hitOwner = hitOwner.parentElement;
    }
    const passwordNodes = state.passwordNodes ??= new WeakSet();
    const passwordValues = state.passwordValues ??= new Set();
    const normalizeText = (value) => String(value ?? "")
      .replace(/\\s+/gu, " ").trim();
    const scanRoot = document.documentElement || document.body;
    const scanIterator = scanRoot && typeof document.createNodeIterator === "function"
      ? document.createNodeIterator(scanRoot, 1)
      : null;
    if (!scanIterator) return { found: false };
    const scannedInputs = [];
    let scannedNodes = 0;
    while (scanIterator && scannedNodes < ${MAX_SEMANTIC_SCAN_NODES}) {
      const candidate = scanIterator.nextNode();
      if (!candidate) break;
      scannedNodes += 1;
      if (candidate.tagName === "INPUT") scannedInputs.push(candidate);
    }
    if (scanIterator
      && scannedNodes >= ${MAX_SEMANTIC_SCAN_NODES}
      && scanIterator.nextNode()) return { found: false };
    const rememberPasswordValue = (value) => {
      const normalized = normalizeText(value);
      if (!normalized) return;
      passwordValues.delete(normalized);
      passwordValues.add(normalized);
      while (passwordValues.size > ${MAX_REMEMBERED_PASSWORD_VALUES}) {
        passwordValues.delete(passwordValues.values().next().value);
      }
    };
    for (const input of scannedInputs) {
      const value = normalizeText(input.value);
      if (String(input.type || "").toLowerCase() === "password"
        || (value && passwordValues.has(value))) {
        passwordNodes.add(input);
        rememberPasswordValue(value);
      }
    }
    const password = element.tagName === "INPUT" && (
      String(element.type || "").toLowerCase() === "password"
      || passwordNodes.has(element)
    );
    const inputType = element.tagName === "INPUT"
      ? String(element.type || "text").toLowerCase()
      : "";
    const blocked = inputType === "file";
    const editable = !element.readOnly && (
      element.tagName === "TEXTAREA"
      || element.isContentEditable
      || (element.tagName === "INPUT"
        && ["text", "search", "email", "url", "tel", "password", "number"].includes(inputType))
    );
    const disabled = Boolean(
      element.matches?.(":disabled")
      || element.disabled
      || (() => {
        let current = element;
        while (current) {
          if (String(current.getAttribute?.("aria-disabled") || "").toLowerCase() === "true") {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      })()
    );
    if (${focus ? "true" : "false"} && editable && !disabled) {
      element.focus({ preventScroll: false });
      if (${replace ? "true" : "false"}) {
        if (typeof element.select === "function") element.select();
        else if (element.isContentEditable) {
          const selection = getSelection();
          selection?.selectAllChildren(element);
        }
      }
      const active = document.activeElement;
      if (active !== element && (!active || !element.contains(active))) {
        return { found: false };
      }
    }
    const sensitiveText = Array.from(passwordValues);
    for (const input of scannedInputs) {
      if (!passwordNodes.has(input)) continue;
      const labels = input.labels;
      for (let index = 0; index < Math.min(labels?.length || 0, 16); index += 1) {
        sensitiveText.push(normalizeText(labels[index]?.innerText));
      }
      const value = normalizeText(input.value);
      rememberPasswordValue(value);
      sensitiveText.push(value);
    }
    state.sensitiveText = sensitiveText;
    const redact = (value) => {
      let text = normalizeText(value);
      for (const sensitive of sensitiveText) {
        if (!sensitive) continue;
        text = text.split(sensitive).join("[redacted]");
        text = text.split(encodeURIComponent(sensitive)).join("[redacted]");
      }
      return text.slice(0, 300);
    };
    return {
      found: true,
      blocked,
      disabled,
      editable,
      label: passwordValues.size > 0
        ? "page element"
        : redact(
          password
          ? "Password field"
          : element.getAttribute("aria-label")
            || element.innerText
            || element.value
          || "element"
        ),
      x,
      y,
    };
  })()`);
  return target(value);
}

export async function agentPageRefHasFocus(
  contents: WebContents,
  ref: string,
): Promise<boolean> {
  const value = await execute(contents, `(() => {
    const element = globalThis.__inertiaAgentBrowser?.refs?.get(${JSON.stringify(ref)});
    if (!element || !element.isConnected) return false;
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active === element || Boolean(element.contains?.(active));
  })()`);
  return value === true;
}

export async function agentPageActivationBlocked(contents: WebContents): Promise<boolean> {
  const value = await execute(contents, `(() => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active?.tagName === "INPUT"
      && String(active.type || "").toLowerCase() === "file";
  })()`);
  return value === true;
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
