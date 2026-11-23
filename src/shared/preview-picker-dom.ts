import {
  PREVIEW_ANNOTATION_MAX_NAME_CHARS,
  PREVIEW_ANNOTATION_MAX_ROLE_CHARS,
  PREVIEW_ANNOTATION_MAX_SELECTOR_CHARS,
  type PreviewAnnotationBounds,
} from "./preview-annotation";

export interface PickScope<E> {
  elementsFromPoint(x: number, y: number): ReadonlyArray<E>;
  contains(node: NoInfer<E>): boolean;
}

export function pickElementAtPoint<E extends { readonly shadowRoot: PickScope<E> | null }>(
  scope: PickScope<E>,
  x: number,
  y: number,
  isExcluded: (element: E) => boolean,
): E | null {
  for (const candidate of scope.elementsFromPoint(x, y)) {
    if (!scope.contains(candidate) || isExcluded(candidate)) continue;
    const inner =
      candidate.shadowRoot && pickElementAtPoint(candidate.shadowRoot, x, y, isExcluded);
    return inner ?? candidate;
  }
  return null;
}

export function cssEscapeIdent(value: string): string {
  if (typeof globalThis.CSS?.escape === "function") {
    return globalThis.CSS.escape(value);
  }
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const ch = value.charAt(index);
    if (codeUnit === 0x0000) {
      result += "\ufffd";
    } else if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f)
      || codeUnit === 0x007f
      || (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039)
      || (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && value.charCodeAt(0) === 0x002d)
    ) {
      result += `\\${codeUnit.toString(16)} `;
    } else if (index === 0 && value.length === 1 && codeUnit === 0x002d) {
      result += `\\${ch}`;
    } else if (
      codeUnit >= 0x0080
      || codeUnit === 0x002d
      || codeUnit === 0x005f
      || (codeUnit >= 0x0030 && codeUnit <= 0x0039)
      || (codeUnit >= 0x0041 && codeUnit <= 0x005a)
      || (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      result += ch;
    } else {
      result += `\\${ch}`;
    }
  }
  return result;
}

interface SelectorQueryRoot {
  querySelectorAll(selector: string): ArrayLike<Element>;
  host?: Element;
}

function queryRootFor(element: Element): SelectorQueryRoot | null {
  const root = typeof element.getRootNode === "function"
    ? element.getRootNode()
    : element.ownerDocument;
  if (root && typeof (root as SelectorQueryRoot).querySelectorAll === "function") {
    return root as SelectorQueryRoot;
  }
  return element.ownerDocument ?? null;
}

function isUniqueSelector(root: SelectorQueryRoot | null, selector: string, target: Element): boolean {
  if (!root || !selector) return false;
  try {
    const matches = root.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === target;
  } catch {
    return false;
  }
}

function nthChildIndex(element: Element): number {
  const parent = element.parentElement;
  if (!parent) return 1;
  let index = 1;
  for (let sibling = parent.firstElementChild; sibling; sibling = sibling.nextElementSibling) {
    if (sibling === element) return index;
    index += 1;
  }
  return 1;
}

function stableClassList(element: Element): string[] {
  const raw = typeof element.className === "string"
    ? element.className
    : element.getAttribute?.("class") ?? "";
  return raw
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0 && token.length <= 64)
    .slice(0, 2);
}

function buildLocalSelector(element: Element, root: SelectorQueryRoot | null): string {
  const segments: string[] = [];
  let current: Element | null = element;
  let depth = 0;

  while (current && depth < 32) {
    depth += 1;
    const tag = current.tagName.toLowerCase();
    const id = current.id?.trim() ?? "";
    if (id.length > 0 && id.length <= 128) {
      const idSelector = `#${cssEscapeIdent(id)}`;
      if (isUniqueSelector(root, idSelector, current)) {
        segments.unshift(idSelector);
        const combined = segments.join(" > ");
        if (isUniqueSelector(root, combined, element)) return combined;
        break;
      }
    }

    const classes = stableClassList(current);
    const classSuffix = classes.map((token) => `.${cssEscapeIdent(token)}`).join("");
    let segment = `${tag}${classSuffix}`;
    const parent: Element | null = current.parentElement;
    if (parent) {
      const matchingSiblings = Array.from(parent.children).filter((child) => {
        if (child.tagName !== current!.tagName) return false;
        if (classes.length === 0) return true;
        const childClasses = new Set(stableClassList(child));
        return classes.every((token) => childClasses.has(token));
      });
      if (matchingSiblings.length > 1) {
        segment = `${tag}:nth-child(${nthChildIndex(current)})`;
      }
    }

    segments.unshift(segment);
    const candidate = segments.join(" > ");
    if (isUniqueSelector(root, candidate, element)) return candidate;
    if (tag === "body" || tag === "html") break;
    current = parent;
  }

  const assembled = segments.join(" > ");
  if (isUniqueSelector(root, assembled, element)) return assembled;

  const fallback: string[] = [];
  let cursor: Element | null = element;
  let steps = 0;
  while (cursor && steps < 48) {
    steps += 1;
    const tag = cursor.tagName.toLowerCase();
    if (tag === "html" || tag === "body") {
      fallback.unshift(tag);
      break;
    }
    fallback.unshift(cursor.parentElement ? `${tag}:nth-child(${nthChildIndex(cursor)})` : tag);
    cursor = cursor.parentElement;
  }
  return fallback.join(" > ") || element.tagName.toLowerCase();
}

export function buildElementSelector(element: Element): string {
  const chain: string[] = [];
  let current: Element | null = element;
  let hops = 0;

  while (current && hops < 16) {
    hops += 1;
    const root = queryRootFor(current);
    chain.unshift(buildLocalSelector(current, root));
    const host = root && "host" in root && root.host ? root.host : null;
    if (!host || host === current) break;
    current = host;
  }

  const joined = chain.join(" >>> ");
  return joined.length <= PREVIEW_ANNOTATION_MAX_SELECTOR_CHARS
    ? joined
    : joined.slice(0, PREVIEW_ANNOTATION_MAX_SELECTOR_CHARS);
}

export function describePickedElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id?.trim() ? `#${element.id.trim()}` : "";
  const classes = stableClassList(element).map((token) => `.${token}`).join("");
  const label = `${tag}${id}${classes}`;
  return label.length <= 80 ? label : `${label.slice(0, 79)}…`;
}

function normalizeLabelText(value: string | null | undefined, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\0/gu, "").replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

function isSensitiveInput(element: Element): boolean {
  if (element.tagName !== "INPUT") return false;
  const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
  return type === "password";
}

function implicitRoleFor(element: Element): string {
  const tag = element.tagName.toLowerCase();
  switch (tag) {
    case "a":
      return element.hasAttribute("href") ? "link" : "generic";
    case "button":
    case "summary":
      return "button";
    case "textarea":
      return "textbox";
    case "select":
      return "combobox";
    case "img":
      return "img";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "form":
      return "form";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listitem";
    case "dialog":
      return "dialog";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "input": {
      const type = (element.getAttribute("type") ?? "text").trim().toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      return "textbox";
    }
    default:
      return tag;
  }
}

export function extractElementRoleAndName(element: Element): { role: string; name: string } {
  const explicitRole = normalizeLabelText(element.getAttribute("role"), PREVIEW_ANNOTATION_MAX_ROLE_CHARS).toLowerCase();
  const role = (explicitRole || implicitRoleFor(element)).slice(0, PREVIEW_ANNOTATION_MAX_ROLE_CHARS);

  const ariaLabel = normalizeLabelText(element.getAttribute("aria-label"), PREVIEW_ANNOTATION_MAX_NAME_CHARS);
  if (ariaLabel) return { role, name: ariaLabel };

  const labelledBy = normalizeLabelText(element.getAttribute("aria-labelledby"), 512);
  if (labelledBy) {
    const root = typeof element.getRootNode === "function" ? element.getRootNode() : element.ownerDocument;
    const parts: string[] = [];
    for (const id of labelledBy.split(" ").slice(0, 8)) {
      if (!id) continue;
      const byId = root && "getElementById" in root && typeof (root as Document).getElementById === "function"
        ? (root as Document).getElementById(id)
        : element.ownerDocument?.getElementById(id) ?? null;
      const text = normalizeLabelText(byId?.textContent, PREVIEW_ANNOTATION_MAX_NAME_CHARS);
      if (text) parts.push(text);
    }
    const combined = normalizeLabelText(parts.join(" "), PREVIEW_ANNOTATION_MAX_NAME_CHARS);
    if (combined) return { role, name: combined };
  }

  const labels = (element as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    const labelText = normalizeLabelText(labels[0]?.textContent, PREVIEW_ANNOTATION_MAX_NAME_CHARS);
    if (labelText) return { role, name: labelText };
  }

  const alt = normalizeLabelText(element.getAttribute("alt"), PREVIEW_ANNOTATION_MAX_NAME_CHARS);
  if (alt) return { role, name: alt };

  const title = normalizeLabelText(element.getAttribute("title"), PREVIEW_ANNOTATION_MAX_NAME_CHARS);
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT") {
    if (title) return { role, name: title };
    const placeholder = normalizeLabelText(element.getAttribute("placeholder"), PREVIEW_ANNOTATION_MAX_NAME_CHARS);
    if (placeholder) return { role, name: placeholder };
    if (element.tagName === "INPUT" && !isSensitiveInput(element)) {
      const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") {
        const value = normalizeLabelText((element as HTMLInputElement).value, PREVIEW_ANNOTATION_MAX_NAME_CHARS);
        if (value) return { role, name: value };
      }
    }
    return { role, name: "" };
  }

  const content = normalizeLabelText(element.textContent, PREVIEW_ANNOTATION_MAX_NAME_CHARS);
  if (content) return { role, name: content };
  return { role, name: title };
}

export function rectFromElement(element: Element): PreviewAnnotationBounds {
  const rect = element.getBoundingClientRect();
  return {
    x: Number.isFinite(rect.left) ? Math.round(rect.left * 100) / 100 : 0,
    y: Number.isFinite(rect.top) ? Math.round(rect.top * 100) / 100 : 0,
    width: Number.isFinite(rect.width) ? Math.max(0, Math.round(rect.width * 100) / 100) : 0,
    height: Number.isFinite(rect.height) ? Math.max(0, Math.round(rect.height * 100) / 100) : 0,
  };
}
