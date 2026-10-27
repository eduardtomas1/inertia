export type AgentPageNestedEvidence = "clear" | "sensitive" | "unreadable";

export const MAX_NESTED_EVIDENCE_NODES = 4_000;
export const MAX_NESTED_EVIDENCE_TEXT_CHARS = 12_000;
export const MAX_NESTED_EVIDENCE_FIELDS = 200;

export function agentPageNestedEvidenceScript(privacyRuntime: string): string {
  return `(() => {
    const state = globalThis.__inertiaAgentBrowser;
    if (state?.privacyGuardInstalled !== true) {
      throw new Error("The Browser privacy guard is unavailable.");
    }
    const privacy = ${privacyRuntime};
    const frameTags = ["IFRAME", "FRAME", "OBJECT", "EMBED"];
    const fieldTags = ["INPUT", "TEXTAREA", "SELECT"];
    const hiddenTextTags = ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"];
    const roots = [];
    const texts = [];
    const fields = [];
    let unreadable = state.closedShadowRootsObserved === true;
    let truncated = false;
    let nodes = 0;
    let characters = 0;
    const painted = (element) => {
      const rect = element.getBoundingClientRect?.();
      return !rect || !(rect.width <= 0 || rect.height <= 0);
    };
    const discover = (element) => {
      const shadow = element.shadowRoot;
      if (shadow) roots.push(shadow);
      if (!frameTags.includes(element.tagName)) return;
      let inner = null;
      try {
        inner = element.contentDocument ?? null;
      } catch {
        inner = null;
      }
      if (inner) roots.push(inner);
      else if (painted(element)) unreadable = true;
    };
    const attribute = (element, name) => {
      const value = element.getAttribute?.(name);
      return typeof value === "string" ? value : "";
    };
    const fieldName = (element) => attribute(element, "aria-label")
      || String(element.labels?.[0]?.textContent ?? "")
      || attribute(element, "placeholder")
      || attribute(element, "title")
      || attribute(element, "name");
    const read = (element) => {
      if (element.tagName !== "SELECT") privacy.inspect(state, element, "observe");
      if (fields.length >= ${MAX_NESTED_EVIDENCE_FIELDS}) {
        truncated = true;
        return;
      }
      fields.push({
        name: fieldName(element).replace(/\\s+/gu, " ").trim().slice(0, 300),
        value: typeof element.value === "string" && !state.passwordNodes.has(element)
          ? element.value.slice(0, 500)
          : "",
      });
    };
    const top = document.documentElement;
    const topIterator = top && typeof document.createNodeIterator === "function"
      ? document.createNodeIterator(top, 1)
      : null;
    if (!topIterator) truncated = true;
    let scanned = 0;
    for (let element = topIterator?.nextNode(); element; element = topIterator.nextNode()) {
      if (++scanned > ${MAX_NESTED_EVIDENCE_NODES}) {
        truncated = true;
        break;
      }
      discover(element);
    }
    for (let index = 0; index < roots.length && !truncated; index += 1) {
      const root = roots[index];
      const owner = root.nodeType === 9 ? root : root.ownerDocument;
      const iterator = typeof owner?.createNodeIterator === "function"
        ? owner.createNodeIterator(root, 5)
        : null;
      if (!iterator) {
        truncated = true;
        break;
      }
      for (let node = iterator.nextNode(); node; node = iterator.nextNode()) {
        if (++nodes > ${MAX_NESTED_EVIDENCE_NODES}) {
          truncated = true;
          break;
        }
        if (node.nodeType === 3) {
          if (hiddenTextTags.includes(node.parentElement?.tagName)) continue;
          const value = String(node.nodeValue ?? "");
          if (!/\\S/u.test(value)) continue;
          characters += value.length + 1;
          if (characters > ${MAX_NESTED_EVIDENCE_TEXT_CHARS}) {
            truncated = true;
            break;
          }
          texts.push(value);
          continue;
        }
        if (node.nodeType !== 1) continue;
        discover(node);
        if (fieldTags.includes(node.tagName)) read(node);
      }
    }
    return {
      text: texts.join(" "),
      fields,
      unreadable,
      truncated,
      passwords: state.passwordValues.size > 0,
    };
  })()`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function agentPageNestedEvidenceVerdict(
  value: unknown,
  visualEvidenceIsSensitive: (snapshot: unknown) => boolean,
): AgentPageNestedEvidence {
  if (!plainObject(value) || value.truncated !== false || value.passwords !== false
    || typeof value.text !== "string" || !Array.isArray(value.fields)) return "sensitive";
  if (visualEvidenceIsSensitive({ text: value.text, elements: value.fields, truncated: false })) {
    return "sensitive";
  }
  return value.unreadable === false ? "clear" : "unreadable";
}
