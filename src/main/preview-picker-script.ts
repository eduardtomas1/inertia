import type { WebContents } from "electron";

import {
  PREVIEW_ANNOTATION_MAX_NAME_CHARS,
  PREVIEW_ANNOTATION_MAX_ROLE_CHARS,
  PREVIEW_ANNOTATION_MAX_SELECTOR_CHARS,
  PREVIEW_ANNOTATION_MAX_TAG_CHARS,
} from "../shared/preview-annotation.js";
import { AGENT_BROWSER_WORLD_ID } from "./preview-agent-page.js";

export interface PreviewPickerStartOptions {
  readonly point?: { readonly x: number; readonly y: number };
  readonly generation?: number;
}

export const PREVIEW_PICKER_OVERLAY_ATTR = "data-inertia-preview-picker";
const RAW_HTML_PRE_TRANSPORT_LIMIT = 24_576;

export function previewPickerStartScript(options: PreviewPickerStartOptions = {}): string {
  const initialPoint = options.point
    && Number.isFinite(options.point.x)
    && Number.isFinite(options.point.y)
    ? { x: options.point.x, y: options.point.y }
    : null;
  const generation = typeof options.generation === "number" && Number.isSafeInteger(options.generation) && options.generation >= 0
    ? options.generation
    : 0;

  return `(() => {
    const OVERLAY_ATTR = ${JSON.stringify(PREVIEW_PICKER_OVERLAY_ATTR)};
    const MAX_SELECTOR = ${PREVIEW_ANNOTATION_MAX_SELECTOR_CHARS};
    const MAX_ROLE = ${PREVIEW_ANNOTATION_MAX_ROLE_CHARS};
    const MAX_NAME = ${PREVIEW_ANNOTATION_MAX_NAME_CHARS};
    const MAX_TAG = ${PREVIEW_ANNOTATION_MAX_TAG_CHARS};
    const MAX_RAW_HTML = ${RAW_HTML_PRE_TRANSPORT_LIMIT};
    const INITIAL_POINT = ${JSON.stringify(initialPoint)};
    const GENERATION = ${generation};
    const owner = globalThis;
    if (owner.__inertiaPreviewPicker && typeof owner.__inertiaPreviewPicker.stop === "function") {
      owner.__inertiaPreviewPicker.stop(false);
    }

    const sendEvent = (payload) => {
      const bridge = owner.__inertiaPreviewPickerBridge;
      if (bridge && typeof bridge.send === "function") {
        bridge.send({ ...payload, generation: GENERATION });
      }
    };

    const cssEscapeIdent = (value) => {
      if (owner.CSS && typeof owner.CSS.escape === "function") return owner.CSS.escape(value);
      let result = "";
      for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        const ch = value.charAt(i);
        if (code === 0) result += "\\ufffd";
        else if ((code >= 1 && code <= 0x1f) || code === 0x7f || (i === 0 && code >= 0x30 && code <= 0x39) || (i === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d)) {
          result += "\\\\" + code.toString(16) + " ";
        } else if (i === 0 && value.length === 1 && code === 0x2d) {
          result += "\\\\" + ch;
        } else if (code >= 0x80 || code === 0x2d || code === 0x5f || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
          result += ch;
        } else {
          result += "\\\\" + ch;
        }
      }
      return result;
    };

    const stableClasses = (el) => {
      const raw = typeof el.className === "string" ? el.className : (el.getAttribute ? el.getAttribute("class") || "" : "");
      return raw.trim().split(/\\s+/u).filter((t) => t.length > 0 && t.length <= 64).slice(0, 2);
    };

    const nthChildIndex = (el) => {
      const parent = el.parentElement;
      if (!parent) return 1;
      let idx = 1;
      for (let s = parent.firstElementChild; s; s = s.nextElementSibling) {
        if (s === el) return idx;
        idx += 1;
      }
      return 1;
    };

    const queryRootFor = (el) => {
      const root = typeof el.getRootNode === "function" ? el.getRootNode() : el.ownerDocument;
      if (root && typeof root.querySelectorAll === "function") return root;
      return el.ownerDocument || document;
    };

    const isUnique = (root, selector, target) => {
      if (!root || !selector) return false;
      try {
        const matches = root.querySelectorAll(selector);
        return matches.length === 1 && matches[0] === target;
      } catch {
        return false;
      }
    };

    const buildLocalSelector = (element, root) => {
      const segments = [];
      let current = element;
      let depth = 0;
      while (current && depth < 32) {
        depth += 1;
        const tag = String(current.tagName || "").toLowerCase();
        const id = typeof current.id === "string" ? current.id.trim() : "";
        if (id.length > 0 && id.length <= 128) {
          const idSel = "#" + cssEscapeIdent(id);
          if (isUnique(root, idSel, current)) {
            segments.unshift(idSel);
            const combined = segments.join(" > ");
            if (isUnique(root, combined, element)) return combined;
            break;
          }
        }
        const classes = stableClasses(current);
        let segment = tag + classes.map((t) => "." + cssEscapeIdent(t)).join("");
        const parent = current.parentElement;
        if (parent) {
          const matchingSiblings = Array.from(parent.children).filter((child) => {
            if (child.tagName !== current.tagName) return false;
            if (classes.length === 0) return true;
            const childClasses = new Set(stableClasses(child));
            return classes.every((t) => childClasses.has(t));
          });
          if (matchingSiblings.length > 1) {
            segment = tag + ":nth-child(" + nthChildIndex(current) + ")";
          }
        }
        segments.unshift(segment);
        const candidate = segments.join(" > ");
        if (isUnique(root, candidate, element)) return candidate;
        if (tag === "body" || tag === "html") break;
        current = parent;
      }
      const assembled = segments.join(" > ");
      if (isUnique(root, assembled, element)) return assembled;
      const fallback = [];
      let cursor = element;
      let steps = 0;
      while (cursor && steps < 48) {
        steps += 1;
        const tag = String(cursor.tagName || "").toLowerCase();
        if (tag === "html" || tag === "body") {
          fallback.unshift(tag);
          break;
        }
        fallback.unshift(cursor.parentElement ? tag + ":nth-child(" + nthChildIndex(cursor) + ")" : tag);
        cursor = cursor.parentElement;
      }
      return fallback.join(" > ") || String(element.tagName || "div").toLowerCase();
    };

    const buildSelector = (element) => {
      const chain = [];
      let current = element;
      let hops = 0;
      while (current && hops < 16) {
        hops += 1;
        const root = queryRootFor(current);
        chain.unshift(buildLocalSelector(current, root));
        const host = root && root.host ? root.host : null;
        if (!host || host === current) break;
        current = host;
      }
      return chain.join(" >>> ").slice(0, MAX_SELECTOR);
    };

    const describeElement = (el) => {
      const tag = String(el.tagName || "").toLowerCase();
      const id = typeof el.id === "string" && el.id.trim() ? "#" + el.id.trim() : "";
      const cls = stableClasses(el).map((t) => "." + t).join("");
      const text = tag + id + cls;
      return text.length <= 80 ? text : text.slice(0, 79) + "\\u2026";
    };

    const normalizeText = (value, max) => typeof value === "string"
      ? value.replace(/\\0/gu, "").replace(/\\s+/gu, " ").trim().slice(0, max)
      : "";

    const extractRoleAndName = (el) => {
      const tag = String(el.tagName || "").toLowerCase();
      const explicitRole = normalizeText(el.getAttribute ? el.getAttribute("role") : "", MAX_ROLE).toLowerCase();
      let role = explicitRole;
      if (!role) {
        if (tag === "a") role = el.hasAttribute && el.hasAttribute("href") ? "link" : "generic";
        else if (tag === "button" || tag === "summary") role = "button";
        else if (tag === "textarea") role = "textbox";
        else if (tag === "select") role = "combobox";
        else if (tag === "img") role = "img";
        else if (tag === "nav") role = "navigation";
        else if (tag === "main") role = "main";
        else if (tag === "form") role = "form";
        else if (tag === "ul" || tag === "ol") role = "list";
        else if (tag === "li") role = "listitem";
        else if (tag === "dialog") role = "dialog";
        else if (/^h[1-6]$/u.test(tag)) role = "heading";
        else if (tag === "input") {
          const type = String((el.getAttribute && el.getAttribute("type")) || "text").trim().toLowerCase();
          if (type === "checkbox") role = "checkbox";
          else if (type === "radio") role = "radio";
          else if (type === "button" || type === "submit" || type === "reset") role = "button";
          else if (type === "search") role = "searchbox";
          else if (type === "number") role = "spinbutton";
          else if (type === "range") role = "slider";
          else role = "textbox";
        } else {
          role = tag;
        }
      }
      role = role.slice(0, MAX_ROLE);

      const ariaLabel = normalizeText(el.getAttribute ? el.getAttribute("aria-label") : "", MAX_NAME);
      if (ariaLabel) return { role, name: ariaLabel };

      const labelledBy = normalizeText(el.getAttribute ? el.getAttribute("aria-labelledby") : "", 512);
      if (labelledBy) {
        const root = typeof el.getRootNode === "function" ? el.getRootNode() : el.ownerDocument;
        const parts = [];
        for (const id of labelledBy.split(" ").slice(0, 8)) {
          if (!id) continue;
          const refEl = root && typeof root.getElementById === "function"
            ? root.getElementById(id)
            : (document.getElementById ? document.getElementById(id) : null);
          const text = normalizeText(refEl && refEl.textContent, MAX_NAME);
          if (text) parts.push(text);
        }
        const combined = normalizeText(parts.join(" "), MAX_NAME);
        if (combined) return { role, name: combined };
      }

      if (el.labels && el.labels.length > 0) {
        const lbl = normalizeText(el.labels[0] && el.labels[0].textContent, MAX_NAME);
        if (lbl) return { role, name: lbl };
      }

      const alt = normalizeText(el.getAttribute ? el.getAttribute("alt") : "", MAX_NAME);
      if (alt) return { role, name: alt };

      const title = normalizeText(el.getAttribute ? el.getAttribute("title") : "", MAX_NAME);
      if (tag === "input" || tag === "textarea" || tag === "select") {
        if (title) return { role, name: title };
        const placeholder = normalizeText(el.getAttribute ? el.getAttribute("placeholder") : "", MAX_NAME);
        if (placeholder) return { role, name: placeholder };
        if (tag === "input") {
          const type = String((el.getAttribute && el.getAttribute("type")) || "").trim().toLowerCase();
          if (type === "button" || type === "submit" || type === "reset") {
            const value = normalizeText(el.value, MAX_NAME);
            if (value) return { role, name: value };
          }
        }
        return { role, name: "" };
      }

      const content = normalizeText(el.textContent, MAX_NAME);
      return { role, name: content || title };
    };

    const rectFromElement = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Number.isFinite(r.left) ? Math.round(r.left * 100) / 100 : 0,
        y: Number.isFinite(r.top) ? Math.round(r.top * 100) / 100 : 0,
        width: Number.isFinite(r.width) ? Math.max(0, Math.round(r.width * 100) / 100) : 0,
        height: Number.isFinite(r.height) ? Math.max(0, Math.round(r.height * 100) / 100) : 0,
      };
    };

    const pickAtPoint = (scope, x, y, isExcluded) => {
      if (!scope || typeof scope.elementsFromPoint !== "function") return null;
      const list = scope.elementsFromPoint(x, y) || [];
      for (const candidate of list) {
        if (!candidate) continue;
        if (typeof scope.contains === "function" && !scope.contains(candidate)) continue;
        if (isExcluded(candidate)) continue;
        const inner = candidate.shadowRoot ? pickAtPoint(candidate.shadowRoot, x, y, isExcluded) : null;
        return inner || candidate;
      }
      return null;
    };

    const host = document.createElement("div");
    host.setAttribute(OVERLAY_ATTR, "host");
    host.setAttribute("dir", "ltr");
    try {
      host.popover = "manual";
    } catch {}
    host.style.cssText = "position:fixed;inset:0;width:auto;height:auto;margin:0;border:0;padding:0;overflow:visible;background:transparent;color:inherit;z-index:2147483647;pointer-events:none;";

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = [
      ":host { all: initial; }",
      ".layer { position: fixed; inset: 0; pointer-events: none; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #f4f4f5; }",
      ".box { position: fixed; display: none; pointer-events: none; border: 2px solid #3b82f6; background: rgba(59, 130, 246, 0.14); border-radius: 3px; box-sizing: border-box; }",
      ".badge { position: fixed; display: none; pointer-events: none; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: #1d4ed8; color: #ffffff; font-size: 11px; font-weight: 600; line-height: 16px; padding: 2px 7px; border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); }",
    ].join("\\n");
    shadow.appendChild(style);

    const layer = document.createElement("div");
    layer.className = "layer";
    const hoverBox = document.createElement("div");
    hoverBox.className = "box";
    const hoverBadge = document.createElement("div");
    hoverBadge.className = "badge";
    layer.append(hoverBox, hoverBadge);
    shadow.appendChild(layer);

    const cursorStyle = document.createElement("style");
    cursorStyle.setAttribute(OVERLAY_ATTR, "cursor");
    cursorStyle.textContent = "[" + OVERLAY_ATTR + "]::backdrop { display: none !important; } html[" + OVERLAY_ATTR + "-active] body, html[" + OVERLAY_ATTR + "-active] body * { cursor: crosshair !important; }";

    let finished = false;
    let submitting = false;

    const isOverlayTarget = (node) => {
      if (!node) return false;
      if (node === host || node === cursorStyle) return true;
      if (typeof host.contains === "function" && host.contains(node)) return true;
      if (typeof shadow.contains === "function" && shadow.contains(node)) return true;
      if (node.getAttribute && node.getAttribute(OVERLAY_ATTR) !== null) return true;
      return false;
    };

    const isExcluded = (el) => isOverlayTarget(el) || el === document.documentElement || el === document.body;

    const positionHighlight = (box, badge, el) => {
      if (!el || !el.isConnected) {
        box.style.display = "none";
        badge.style.display = "none";
        return null;
      }
      const r = rectFromElement(el);
      if (r.width <= 0 && r.height <= 0) {
        box.style.display = "none";
        badge.style.display = "none";
        return r;
      }
      box.style.display = "block";
      box.style.left = r.x + "px";
      box.style.top = r.y + "px";
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";
      badge.textContent = describeElement(el);
      badge.style.display = "block";
      badge.style.left = Math.max(4, Math.min(r.x, Math.max(4, (window.innerWidth || 800) - 220))) + "px";
      badge.style.top = Math.max(4, r.y >= 24 ? r.y - 22 : r.y + r.height + 4) + "px";
      return r;
    };

    const eventTargetsOverlay = (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      for (const item of path) {
        if (isOverlayTarget(item)) return true;
      }
      return isOverlayTarget(event.target);
    };

    const swallow = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    };

    const stop = (notifyMain) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("mousedown", onMouseOrClick, true);
      window.removeEventListener("mouseup", onMouseOrClick, true);
      window.removeEventListener("click", onMouseOrClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
      if (document.documentElement) {
        document.documentElement.removeAttribute(OVERLAY_ATTR + "-active");
      }
      try {
        if (host.matches && host.matches(":popover-open") && typeof host.hidePopover === "function") {
          host.hidePopover();
        }
      } catch {}
      cursorStyle.remove();
      host.remove();
      if (owner.__inertiaPreviewPicker && owner.__inertiaPreviewPicker.host === host) {
        owner.__inertiaPreviewPicker = null;
      }
      if (notifyMain) sendEvent({ type: "cancelled" });
    };

    const selectElement = (el) => {
      if (finished || submitting || !el) return;
      submitting = true;
      const bounds = rectFromElement(el);
      const selector = buildSelector(el);
      const { role, name } = extractRoleAndName(el);
      const tagName = String(el.tagName || "").toLowerCase().slice(0, MAX_TAG);
      const rawHtml = typeof el.outerHTML === "string"
        ? el.outerHTML.slice(0, MAX_RAW_HTML)
        : "";
      const payload = {
        selector,
        role,
        name,
        tagName,
        label: describeElement(el),
        bounds,
        html: rawHtml,
        devicePixelRatio: Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
        viewportWidth: Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 0,
        viewportHeight: Number.isFinite(window.innerHeight) && window.innerHeight > 0 ? window.innerHeight : 0,
      };
      host.style.visibility = "hidden";
      host.style.display = "none";
      const dispatch = () => {
        if (finished) return;
        stop(false);
        sendEvent({ type: "selected", payload });
      };
      if (typeof window.requestAnimationFrame === "function") {
        let dispatched = false;
        const once = () => {
          if (dispatched) return;
          dispatched = true;
          dispatch();
        };
        window.requestAnimationFrame(once);
        if (typeof window.setTimeout === "function") window.setTimeout(once, 60);
      } else {
        dispatch();
      }
    };

    const onPointerMove = (event) => {
      if (finished || submitting) return;
      if (eventTargetsOverlay(event)) {
        hoverBox.style.display = "none";
        hoverBadge.style.display = "none";
        return;
      }
      const target = pickAtPoint(document, event.clientX, event.clientY, isExcluded);
      if (target) positionHighlight(hoverBox, hoverBadge, target);
      else {
        hoverBox.style.display = "none";
        hoverBadge.style.display = "none";
      }
    };

    let selectedOnPointerDown = false;

    const onPointerDown = (event) => {
      if (finished || !event.isTrusted || eventTargetsOverlay(event)) return;
      swallow(event);
      if (submitting || event.button !== 0) return;
      const target = pickAtPoint(document, event.clientX, event.clientY, isExcluded);
      if (target) {
        selectedOnPointerDown = true;
        selectElement(target);
      }
    };

    const onMouseOrClick = (event) => {
      if (finished || !event.isTrusted || eventTargetsOverlay(event)) return;
      swallow(event);
      if (submitting) {
        if (event.type === "click") selectedOnPointerDown = false;
        return;
      }
      if (event.type === "click" && !selectedOnPointerDown && event.button === 0) {
        const target = pickAtPoint(document, event.clientX, event.clientY, isExcluded);
        if (target) selectElement(target);
      }
      if (event.type === "click") selectedOnPointerDown = false;
    };

    const onKeyDown = (event) => {
      if (finished || submitting || !event.isTrusted) return;
      if (event.key === "Escape" && !event.isComposing) {
        swallow(event);
        stop(true);
      }
    };

    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("mousedown", onMouseOrClick, true);
    window.addEventListener("mouseup", onMouseOrClick, true);
    window.addEventListener("click", onMouseOrClick, true);
    window.addEventListener("keydown", onKeyDown, true);

    const mountRoot = document.documentElement || document.body;
    if (mountRoot) {
      mountRoot.setAttribute(OVERLAY_ATTR + "-active", "true");
      mountRoot.appendChild(cursorStyle);
      mountRoot.appendChild(host);
    }
    try {
      if (typeof host.showPopover === "function") host.showPopover();
    } catch {}

    owner.__inertiaPreviewPicker = { host, generation: GENERATION, stop };

    if (INITIAL_POINT) {
      const target = pickAtPoint(document, INITIAL_POINT.x, INITIAL_POINT.y, isExcluded);
      if (target) {
        selectElement(target);
      }
    }
    return true;
  })()`;
}

export function previewPickerStopScript(expectedGeneration?: number): string {
  const expected = typeof expectedGeneration === "number" && Number.isSafeInteger(expectedGeneration)
    ? expectedGeneration
    : null;
  return `(() => {
    const picker = globalThis.__inertiaPreviewPicker;
    const expectedGeneration = ${JSON.stringify(expected)};
    if (
      picker
      && typeof picker.stop === "function"
      && (expectedGeneration === null || picker.generation === expectedGeneration)
    ) {
      picker.stop(false);
      return true;
    }
    return false;
  })()`;
}

export async function startPreviewPickerInPage(
  contents: WebContents,
  options: PreviewPickerStartOptions = {},
): Promise<void> {
  await contents.executeJavaScriptInIsolatedWorld(
    AGENT_BROWSER_WORLD_ID,
    [{ code: previewPickerStartScript(options) }],
    true,
  );
}

export async function stopPreviewPickerInPage(
  contents: WebContents,
  expectedGeneration?: number,
): Promise<void> {
  if (contents.isDestroyed()) return;
  await contents.executeJavaScriptInIsolatedWorld(
    AGENT_BROWSER_WORLD_ID,
    [{ code: previewPickerStopScript(expectedGeneration) }],
    true,
  );
}
