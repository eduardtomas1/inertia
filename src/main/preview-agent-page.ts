import type { WebContents } from "electron";

import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../shared/agent-browser.js";
import {
  browserEvidenceFieldNameIsSensitiveCredential,
  browserEvidenceTextContainsSensitiveCredential,
  MAX_BROWSER_EVIDENCE_TEXT_CHARS,
} from "../shared/browser-evidence.js";
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
const MAX_PAGE_VALUE_SOURCE_CHARS = 4_096;
const MAX_LABEL_TEXT_SOURCE_CHARS = 1_200;
const MAX_LABEL_TEXT_NODES = 128;

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
    const normalizeText = (value, maximum = ${MAX_PAGE_VALUE_SOURCE_CHARS}) => String(value ?? "")
      .slice(0, maximum)
      .replace(/\\s+/gu, " ").trim();
    const boundedLowerAttribute = (element, name, maximum) => {
      const value = element.getAttribute?.(name);
      return typeof value === "string" && value.length <= maximum
        ? normalizeText(value, maximum).toLowerCase()
        : "";
    };
    const boundedInputType = (element, fallback = "") => {
      if (element.tagName !== "INPUT") return "";
      const value = typeof element.type === "string" ? element.type : fallback;
      return value.length <= 20 ? normalizeText(value, 20).toLowerCase() : "";
    };
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
    const elementStyles = new WeakMap();
    const effectiveOpacity = new WeakMap();
    const effectiveAriaHidden = new WeakMap();
    const effectiveAriaDisabled = new WeakMap();
    const styleFor = (element) => {
      let style = elementStyles.get(element);
      if (!style) {
        style = getComputedStyle(element);
        elementStyles.set(element, style);
      }
      return style;
    };
    const cacheEffectiveState = (element) => {
      const chain = [];
      let current = element;
      while (current && !effectiveOpacity.has(current)
        && chain.length < ${MAX_SEMANTIC_SCAN_NODES}) {
        chain.push(current);
        current = current.parentElement;
      }
      let opacityAllowed = current ? effectiveOpacity.get(current) !== false : true;
      let ariaHidden = current ? effectiveAriaHidden.get(current) === true : false;
      let ariaBlocked = current ? effectiveAriaDisabled.get(current) === true : false;
      if (current && !effectiveOpacity.has(current)) {
        opacityAllowed = false;
        ariaHidden = true;
        ariaBlocked = true;
        elementScanTruncated = true;
      }
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const candidate = chain[index];
        const style = styleFor(candidate);
        opacityAllowed = opacityAllowed && Number(style.opacity || "1") > 0;
        ariaHidden = ariaHidden
          || boundedLowerAttribute(candidate, "aria-hidden", 10) === "true";
        ariaBlocked = ariaBlocked
          || boundedLowerAttribute(candidate, "aria-disabled", 10) === "true";
        effectiveOpacity.set(candidate, opacityAllowed);
        effectiveAriaHidden.set(candidate, ariaHidden);
        effectiveAriaDisabled.set(candidate, ariaBlocked);
      }
    };
    for (const element of scannedElementNodes) cacheEffectiveState(element);
    const visible = (element, rect) => {
      const style = styleFor(element);
      return rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < innerHeight && rect.left < innerWidth
        && style.visibility !== "hidden" && style.display !== "none"
        && effectiveOpacity.get(element) !== false
        && effectiveAriaHidden.get(element) !== true;
    };
    const ariaDisabled = (element) => effectiveAriaDisabled.get(element) === true;
    const boundedImageAlt = (element, root = element) => {
      const image = element?.tagName === "IMG"
        || (element?.tagName === "INPUT"
          && normalizeText(element.type, 20).toLowerCase() === "image");
      if (!image) return "";
      const roleValue = element.getAttribute?.("role");
      const role = typeof roleValue === "string"
        ? normalizeText(roleValue, 50).toLowerCase()
        : "";
      if (role === "none" || role === "presentation") return "";
      let current = element;
      let visited = 0;
      while (current) {
        visited += 1;
        if (visited > ${MAX_LABEL_TEXT_NODES}) return "";
        const style = styleFor(current);
        if (
          current.hidden === true
          || boundedLowerAttribute(current, "aria-hidden", 10) === "true"
          || (current === element && style.visibility === "hidden")
          || style.display === "none"
        ) return "";
        if (current === root) break;
        current = current.parentElement;
      }
      if (!current) return "";
      const value = element.getAttribute?.("alt");
      return typeof value === "string"
        ? normalizeText(value, ${MAX_LABEL_TEXT_SOURCE_CHARS})
        : "";
    };
    const boundedElementText = (element) => {
      const chunks = [];
      let characters = 0;
      let visited = 0;
      let node = element?.firstChild || null;
      while (node) {
        visited += 1;
        if (visited > ${MAX_LABEL_TEXT_NODES}) break;
        if (node.nodeType === 3) {
          if (node.parentElement === element
            || styleFor(node.parentElement).visibility !== "hidden") {
            const value = String(node.nodeValue || "");
            const remaining = ${MAX_LABEL_TEXT_SOURCE_CHARS} - characters;
            if (remaining <= 0) break;
            chunks.push(value.slice(0, remaining));
            characters += Math.min(value.length, remaining);
            if (value.length > remaining) break;
          }
        } else if (node.nodeType === 1 && node.tagName === "IMG") {
          const value = boundedImageAlt(node, element);
          const remaining = ${MAX_LABEL_TEXT_SOURCE_CHARS} - characters;
          if (remaining <= 0) break;
          chunks.push(value.slice(0, remaining));
          characters += Math.min(value.length, remaining);
          if (value.length > remaining) break;
        } else if (node.nodeType === 1) {
          const style = styleFor(node);
          const hidden = ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)
            || node.hidden === true
            || boundedLowerAttribute(node, "aria-hidden", 10) === "true"
            || style.display === "none";
          if (!hidden && node.firstChild) {
            node = node.firstChild;
            continue;
          }
        }
        while (node && node !== element && !node.nextSibling) node = node.parentNode;
        node = node && node !== element ? node.nextSibling : null;
      }
      return normalizeText(chunks.join(" "), ${MAX_LABEL_TEXT_SOURCE_CHARS});
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
      const knownPassword = boundedInputType(input) === "password"
        || passwordNodes.has(input);
      if (!knownPassword && passwordValues.size === 0) continue;
      const value = normalizeText(input.value);
      if (knownPassword || (value && passwordValues.has(value))) {
        passwordNodes.add(input);
        rememberPasswordValue(value);
      }
    }
    const passwordField = (element) => element.tagName === "INPUT"
      && (
        boundedInputType(element) === "password"
        || passwordNodes.has(element)
      );
    const editableHost = (element) => {
      const state = element.getAttribute?.("contenteditable");
      return element.isContentEditable === true
        && element.parentElement?.isContentEditable !== true
        && typeof state === "string" && state.length <= 20
        && ["", "true", "plaintext-only"].includes(
          normalizeText(state, 20).toLowerCase(),
        );
    };
    const nativeEditable = (element) => !element.readOnly && (
      element.tagName === "TEXTAREA"
      || (element.tagName === "INPUT" && [
        "text", "search", "email", "url", "tel", "password", "number",
      ].includes(boundedInputType(element, "text")))
    );
    const sensitiveText = Array.from(passwordValues);
    for (const input of scannedInputs) {
      if (!passwordField(input)) continue;
      const labels = input.labels;
      for (let index = 0; index < Math.min(labels?.length || 0, 16); index += 1) {
        sensitiveText.push(boundedElementText(labels[index]));
      }
      const value = normalizeText(input.value);
      rememberPasswordValue(value);
      sensitiveText.push(value);
    }
    state.sensitiveText = sensitiveText;
    const redact = (value, maximum) => {
      let text = normalizeText(value, Math.max(${MAX_LABEL_TEXT_SOURCE_CHARS}, maximum * 4));
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
          || (editableHost(element)
            ? "textbox"
            : ({ A: "link", BUTTON: "button", INPUT: "input", SELECT: "select", TEXTAREA: "textbox", SUMMARY: "button" })[element.tagName]
              || element.tagName.toLowerCase()),
          50,
        );
    const labelledByFor = (element) => {
      const source = element.getAttribute("aria-labelledby");
      if (!source) return "";
      if (typeof source !== "string" || source.length > ${MAX_LABEL_TEXT_SOURCE_CHARS}) {
        elementScanTruncated = true;
        return "";
      }
      const references = normalizeText(source, ${MAX_LABEL_TEXT_SOURCE_CHARS}).split(" ");
      if (references.length > 16) elementScanTruncated = true;
      const labels = [];
      for (let index = 0; index < Math.min(references.length, 16); index += 1) {
        const id = references[index];
        if (!id || id.length > 300 || typeof document.getElementById !== "function") {
          elementScanTruncated = true;
          continue;
        }
        const label = document.getElementById(id);
        if (!label) {
          elementScanTruncated = true;
          continue;
        }
        labels.push(boundedElementText(label));
      }
      return normalizeText(labels.join(" "), ${MAX_LABEL_TEXT_SOURCE_CHARS});
    };
    const nameFor = (element) => {
      const isInput = element.tagName === "INPUT";
      const isEditable = editableHost(element);
      const inputType = isInput ? boundedInputType(element) : "";
      const valueSource = ["button", "reset", "submit"].includes(inputType)
        ? "control-value"
        : "value";
      const contentName = ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)
        ? ""
        : boundedElementText(element);
      const contentNameSource = isEditable
        ? "value"
        : "content";
      const title = element.getAttribute("title");
      const candidates = [
        [element.getAttribute("aria-label"), "aria-label"],
        [labelledByFor(element), "aria-labelledby"],
        [element.labels && boundedElementText(element.labels[0]), "label"],
        [boundedImageAlt(element), "alt"],
        [isEditable ? title : "", "title"],
        [contentName, contentNameSource],
        [isEditable ? "" : title, "title"],
        [element.getAttribute("placeholder"), "placeholder"],
        [isInput ? element.value : "", valueSource],
      ];
      const selected = candidates.find(([value]) => Boolean(value));
      return {
        name: passwordField(element)
          ? "Password field"
          : redact(selected?.[0], 300),
        nameSource: selected?.[1] || "none",
      };
    };
    const semanticTags = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"]);
    const actionableRoles = new Set([
      "button", "checkbox", "combobox", "link", "menuitem", "menuitemcheckbox",
      "menuitemradio", "option", "radio", "searchbox", "slider", "spinbutton",
      "switch", "tab", "textbox", "treeitem",
    ]);
    const hasAttribute = (element, name) => element.hasAttribute?.(name) === true
      || (typeof element.getAttribute === "function" && element.getAttribute(name) !== null);
    const actionableElement = (element) => semanticTags.has(element.tagName)
      || (element.tagName === "A" && hasAttribute(element, "href"))
      || hasAttribute(element, "tabindex")
      || editableHost(element)
      || actionableRoles.has(boundedLowerAttribute(element, "role", 50));
    const semanticCandidate = (element) => semanticTags.has(element.tagName)
      || (element.tagName === "A" && hasAttribute(element, "href"))
      || hasAttribute(element, "role")
      || editableHost(element)
      || hasAttribute(element, "tabindex");
    const elements = [];
    for (const element of scannedElementNodes) {
      if (!semanticCandidate(element)) continue;
      if (elements.length >= ${MAX_SEMANTIC_ELEMENTS}) {
        elementScanTruncated = true;
        break;
      }
      if (element.tagName === "INPUT"
        && boundedInputType(element) === "file") continue;
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
        ...nameFor(element),
        actionable: actionableElement(element),
        editable: editableHost(element) || nativeEditable(element),
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
          x: rect.x, y: rect.y,
          width: rect.width, height: rect.height,
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
        const style = styleFor(candidate);
        allowed = allowed
          && !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(candidate.tagName)
          && candidate.hidden !== true
          && boundedLowerAttribute(candidate, "aria-hidden", 10) !== "true"
          && style.display !== "none"
          && Number(style.opacity || "1") > 0;
        textStructureVisibility.set(candidate, allowed);
      }
      return allowed;
    };
    const textVisible = (element) => textStructureVisible(element)
      && styleFor(element).visibility !== "hidden";
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
    const normalizedBodyText = normalizeText(
      textChunks.join(" "),
      ${MAX_BODY_TEXT_SOURCE_CHARS},
    );
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
    const normalize = (value) => String(value ?? "")
      .slice(0, ${MAX_PAGE_VALUE_SOURCE_CHARS})
      .replace(/\\s+/gu, " ").trim();
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
      if (!(typeof input.type === "string" && input.type.length <= 20
        && input.type.toLowerCase() === "password")
        && !state.passwordNodes.has(input)) continue;
      const value = normalize(input.value);
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

function snapshotHasSensitiveVisualEvidence(value: unknown): boolean {
  if (!plainObject(value) || value.truncated === true || !Array.isArray(value.elements)
    || value.elements.length > MAX_SEMANTIC_ELEMENTS) return true;
  const sensitive = (candidate: unknown, maximum: number): boolean => {
    if (typeof candidate !== "string") return false;
    if (candidate.length > maximum) return true;
    if (!/\S/u.test(candidate)) return false;
    const step = Math.floor(MAX_BROWSER_EVIDENCE_TEXT_CHARS / 2);
    for (let start = 0; start < candidate.length; start += step) {
      const text = candidate.slice(start, start + MAX_BROWSER_EVIDENCE_TEXT_CHARS);
      if (browserEvidenceTextContainsSensitiveCredential(text)) return true;
    }
    return false;
  };
  const sensitiveNamedValue = (name: unknown, value: unknown): boolean => {
    if (typeof name !== "string" || typeof value !== "string") return false;
    if (name.length > 300 || value.length > 500) return true;
    const boundedName = name.trim();
    const boundedValue = value.trim();
    if (!boundedName || !boundedValue) return false;
    if (browserEvidenceFieldNameIsSensitiveCredential(boundedName, 300)) return true;
    const availableValue = Math.max(
      1,
      MAX_BROWSER_EVIDENCE_TEXT_CHARS - boundedName.length - 1,
    );
    return browserEvidenceTextContainsSensitiveCredential(
      `${boundedName}=${boundedValue.slice(0, availableValue)}`,
    );
  };
  if (sensitive(value.text, MAX_PAGE_TEXT_CHARS)) return true;
  for (const element of value.elements) {
    if (!plainObject(element)
      || sensitive(element.name, 300)
      || sensitive(element.value, 500)
      || sensitiveNamedValue(element.name, element.value)) return true;
  }
  return false;
}

export async function agentPageHasSensitiveScreenshotEvidence(
  contents: WebContents,
): Promise<boolean> {
  if (await agentPageHasSensitiveEvidence(contents)) return true;
  const snapshot = await semanticPageSnapshot(contents);
  try {
    return snapshotHasSensitiveVisualEvidence(JSON.parse(snapshot) as unknown);
  } catch {
    return true;
  }
}

export async function setAgentPageInputGuard(
  contents: WebContents,
  active: boolean,
  expectedClickRef?: string,
): Promise<void> {
  const updated = await execute(contents, `(() => {
    const state = globalThis.__inertiaAgentBrowser;
    if (state?.privacyGuardInstalled !== true) return false;
    state.agentActivationKey = undefined;
    state.blockedAgentActivationKey = undefined;
    state.expectedAgentClickRef = ${active && expectedClickRef ? JSON.stringify(expectedClickRef) : "undefined"};
    state.agentInputRefused = undefined;
    state.agentInputActive = ${active ? "true" : "false"};
    return true;
  })()`);
  if (updated !== true) throw new Error("The Browser privacy guard is unavailable.");
}

export type AgentPageInputRefusal = "disabled" | "file" | "nested" | "retargeted";

export async function agentPageInputRefusal(
  contents: WebContents,
): Promise<AgentPageInputRefusal | null> {
  const value = await execute(contents, `(() => {
    const value = globalThis.__inertiaAgentBrowser?.agentInputRefused;
    return ["disabled", "file", "nested", "retargeted"].includes(value) ? value : null;
  })()`);
  return value === "disabled" || value === "file" || value === "nested" || value === "retargeted"
    ? value
    : null;
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
    const boundedLowerAttribute = (candidate, name, maximum) => {
      const value = candidate.getAttribute?.(name);
      return typeof value === "string" && value.length <= maximum
        ? value.trim().toLowerCase()
        : "";
    };
    let ancestor = element;
    let ancestorDepth = 0;
    while (ancestor && ancestorDepth < ${MAX_SEMANTIC_SCAN_NODES}) {
      const ancestorStyle = getComputedStyle(ancestor);
      if (
        ancestor.hidden === true
        || boundedLowerAttribute(ancestor, "aria-hidden", 10) === "true"
        || ancestorStyle.display === "none"
        || Number(ancestorStyle.opacity || "1") <= 0
      ) {
        return { found: false };
      }
      ancestor = ancestor.parentElement;
      ancestorDepth += 1;
    }
    if (ancestor) return { found: false };
    const actionableRoles = new Set([
      "button", "checkbox", "combobox", "link", "menuitem", "menuitemcheckbox",
      "menuitemradio", "option", "radio", "searchbox", "slider", "spinbutton",
      "switch", "tab", "textbox", "treeitem",
    ]);
    const editableHost = (candidate) => {
      const value = candidate.getAttribute?.("contenteditable");
      const state = typeof value === "string" && value.length <= 20
        ? value.trim().toLowerCase()
        : null;
      return candidate.isContentEditable === true
        && candidate.parentElement?.isContentEditable !== true
        && state !== null
        && ["", "true", "plaintext-only"].includes(state);
    };
    const actionable = (candidate) => candidate.matches?.(
      "a[href],button,input,textarea,select,summary,[tabindex]",
    ) || editableHost(candidate)
      || actionableRoles.has(boundedLowerAttribute(candidate, "role", 50));
    let hitOwner = hit;
    let hitDepth = 0;
    while (hitOwner && hitOwner !== element && hitDepth < ${MAX_SEMANTIC_SCAN_NODES}) {
      if (actionable(hitOwner)) return { found: false };
      hitOwner = hitOwner.parentElement;
      hitDepth += 1;
    }
    if (hitOwner !== element) return { found: false };
    const passwordNodes = state.passwordNodes ??= new WeakSet();
    const passwordValues = state.passwordValues ??= new Set();
    const normalizeText = (value, maximum = ${MAX_PAGE_VALUE_SOURCE_CHARS}) => String(value ?? "")
      .slice(0, maximum)
      .replace(/\\s+/gu, " ").trim();
    const boundedImageAlt = (candidate, root) => {
      const image = candidate?.tagName === "IMG"
        || (candidate?.tagName === "INPUT"
          && typeof candidate.type === "string" && candidate.type.length <= 20
          && candidate.type.toLowerCase() === "image");
      if (!image) return "";
      const role = boundedLowerAttribute(candidate, "role", 50);
      if (role === "none" || role === "presentation") return "";
      let current = candidate;
      let visited = 0;
      while (current) {
        visited += 1;
        if (visited > ${MAX_LABEL_TEXT_NODES}) return "";
        const currentStyle = getComputedStyle(current);
        if (
          current.hidden === true
          || boundedLowerAttribute(current, "aria-hidden", 10) === "true"
          || (current === candidate && currentStyle.visibility === "hidden")
          || currentStyle.display === "none"
        ) return "";
        if (current === root) break;
        current = current.parentElement;
      }
      if (!current) return "";
      const value = candidate.getAttribute?.("alt");
      return typeof value === "string"
        ? normalizeText(value, ${MAX_LABEL_TEXT_SOURCE_CHARS})
        : "";
    };
    const boundedElementText = (root) => {
      const chunks = [];
      let characters = 0;
      let visited = 0;
      let node = root?.firstChild || null;
      while (node) {
        visited += 1;
        if (visited > ${MAX_LABEL_TEXT_NODES}) break;
        if (node.nodeType === 3) {
          if (node.parentElement === root
            || getComputedStyle(node.parentElement).visibility !== "hidden") {
            const value = String(node.nodeValue || "");
            const remaining = ${MAX_LABEL_TEXT_SOURCE_CHARS} - characters;
            if (remaining <= 0) break;
            chunks.push(value.slice(0, remaining));
            characters += Math.min(value.length, remaining);
            if (value.length > remaining) break;
          }
        } else if (node.nodeType === 1 && node.tagName === "IMG") {
          const value = boundedImageAlt(node, root);
          const remaining = ${MAX_LABEL_TEXT_SOURCE_CHARS} - characters;
          if (remaining <= 0) break;
          chunks.push(value.slice(0, remaining));
          characters += Math.min(value.length, remaining);
          if (value.length > remaining) break;
        } else if (node.nodeType === 1) {
          const nodeStyle = getComputedStyle(node);
          const hidden = ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)
            || node.hidden === true
            || boundedLowerAttribute(node, "aria-hidden", 10) === "true"
            || nodeStyle.display === "none";
          if (!hidden && node.firstChild) {
            node = node.firstChild;
            continue;
          }
        }
        while (node && node !== root && !node.nextSibling) node = node.parentNode;
        node = node && node !== root ? node.nextSibling : null;
      }
      return normalizeText(chunks.join(" "), ${MAX_LABEL_TEXT_SOURCE_CHARS});
    };
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
      const inputType = typeof input.type === "string" && input.type.length <= 20
        ? input.type.toLowerCase()
        : "";
      const knownPassword = inputType === "password"
        || passwordNodes.has(input);
      if (!knownPassword && passwordValues.size === 0) continue;
      const value = normalizeText(input.value);
      if (knownPassword || (value && passwordValues.has(value))) {
        passwordNodes.add(input);
        rememberPasswordValue(value);
      }
    }
    const rawInputType = element.tagName === "INPUT" ? element.type : "";
    const inputType = element.tagName === "INPUT"
      && (rawInputType === undefined
        || (typeof rawInputType === "string" && rawInputType.length <= 20))
      ? String(rawInputType || "text").toLowerCase()
      : "";
    const password = element.tagName === "INPUT" && (
      inputType === "password" || passwordNodes.has(element)
    );
    const blocked = inputType === "file";
    const editable = !element.readOnly && (
      element.tagName === "TEXTAREA"
      || editableHost(element)
      || (element.tagName === "INPUT"
        && ["text", "search", "email", "url", "tel", "password", "number"].includes(inputType))
    );
    const disabled = Boolean(
      element.matches?.(":disabled")
      || element.disabled
      || (() => {
        let current = element;
        let depth = 0;
        while (current && depth < ${MAX_SEMANTIC_SCAN_NODES}) {
          if (boundedLowerAttribute(current, "aria-disabled", 10) === "true") {
            return true;
          }
          current = current.parentElement;
          depth += 1;
        }
        return Boolean(current);
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
        sensitiveText.push(boundedElementText(labels[index]));
      }
      const value = normalizeText(input.value);
      rememberPasswordValue(value);
      sensitiveText.push(value);
    }
    state.sensitiveText = sensitiveText;
    const redact = (value) => {
      let text = normalizeText(value, ${MAX_LABEL_TEXT_SOURCE_CHARS});
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
            || boundedImageAlt(element, element)
            || boundedElementText(element)
            || (element.tagName === "INPUT" ? element.value : "")
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
    let depth = 0;
    while (active?.shadowRoot?.activeElement && depth < ${MAX_SEMANTIC_SCAN_NODES}) {
      active = active.shadowRoot.activeElement;
      depth += 1;
    }
    if (active?.shadowRoot?.activeElement) return false;
    return active === element;
  })()`);
  return value === true;
}

export async function agentPageActivationBlocked(
  contents: WebContents,
): Promise<"disabled" | "file" | null> {
  const value = await execute(contents, `(() => {
    const ariaDisabled = (candidate) => {
      const value = candidate?.getAttribute?.("aria-disabled");
      return typeof value === "string" && value.length <= 10
        && value.trim().toLowerCase() === "true";
    };
    let active = document.activeElement;
    let shadowDepth = 0;
    while (active?.shadowRoot?.activeElement
      && shadowDepth < ${MAX_SEMANTIC_SCAN_NODES}) {
      active = active.shadowRoot.activeElement;
      shadowDepth += 1;
    }
    if (active?.shadowRoot?.activeElement) return "disabled";
    if (active?.tagName === "INPUT"
      && typeof active.type === "string" && active.type.length <= 20
      && active.type.toLowerCase() === "file") return "file";
    let current = active;
    for (let depth = 0; current && depth < ${MAX_SEMANTIC_SCAN_NODES}; depth += 1) {
      if (current.matches?.(":disabled") || current.disabled
        || ariaDisabled(current)) {
        return "disabled";
      }
      current = current.parentElement || current.getRootNode?.()?.host || null;
    }
    return current ? "disabled" : null;
  })()`);
  return value === "file" || value === "disabled" ? value : null;
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
