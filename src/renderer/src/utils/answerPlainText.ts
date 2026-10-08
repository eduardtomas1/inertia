const SKIPPED = [
  "button",
  "[aria-hidden='true']",
  "[role='alert']",
  ".visually-hidden",
  ".response-code-block > header",
  ".response-table-toolbar",
].join(", ");
const BLOCKS = new Set([
  "P", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "DIV", "UL", "OL", "TABLE",
]);
const STRUCTURAL = new Set(["UL", "OL", "TABLE", "THEAD", "TBODY", "TFOOT", "TR"]);

function listPrefix(item: HTMLElement): string {
  const list = item.parentElement;
  let depth = 0;
  for (let node = list?.parentElement ?? null; node && !node.classList.contains("response-markdown"); node = node.parentElement) {
    if (node.tagName === "LI") depth += 1;
  }
  const indent = "  ".repeat(depth);
  if (!(list instanceof HTMLOListElement)) return `${indent}- `;
  return `${indent}${list.start + [...list.children].indexOf(item)}. `;
}

function listItemText(item: HTMLElement): string {
  const prefix = listPrefix(item);
  const hanging = " ".repeat(prefix.length);
  const lines: string[] = [];
  let pending = "";
  const flush = (): void => {
    for (const line of pending.split("\n")) {
      if (line.trim()) lines.push(`${lines.length ? hanging : prefix}${line}`);
    }
    pending = "";
  };
  for (const child of item.childNodes) {
    if (child instanceof HTMLUListElement || child instanceof HTMLOListElement) {
      flush();
      if (!lines.length) lines.push(prefix.trimEnd());
      lines.push(...plainText(child).split("\n").filter((line) => line.trim()));
    } else {
      pending += plainText(child);
    }
  }
  flush();
  return `${lines.join("\n") || prefix.trimEnd()}\n`;
}

function withTarget(text: string, target: string): string {
  return target && text !== target ? `${text} (${target})` : text;
}

function linkText(node: HTMLElement, text: string): string {
  const path = node.dataset.linkPath;
  if (path) return withTarget(text, path);
  const href = node.getAttribute("href") ?? "";
  if (!/^(?:https?|mailto):/iu.test(href)) return text;
  const named = [text, `mailto:${text}`, `http://${text}`]
    .some((candidate) => URL.canParse(candidate) && new URL(candidate).href === href);
  return named ? text : `${text} (${href})`;
}

function imageText(node: HTMLElement): string {
  const alt = node.dataset.markdownImageAlt ?? "";
  const source = node.dataset.markdownImageSource ?? "";
  return alt ? withTarget(alt, source) : source;
}

function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    return STRUCTURAL.has(node.parentElement?.tagName ?? "") && !text.trim() ? "" : text;
  }
  if (!(node instanceof HTMLElement)) return "";
  if (node.dataset.markdownImageSource !== undefined) return imageText(node);
  if (node.matches(SKIPPED)) return "";
  if (node instanceof HTMLInputElement) {
    return node.type === "checkbox" ? `[${node.checked ? "x" : " "}]` : "";
  }
  if (node.tagName === "BR") return "\n";
  if (node.tagName === "HR") return "\n\n";
  if (node.tagName === "LI") return listItemText(node);
  const text = [...node.childNodes].map(plainText).join("");
  if (node.tagName === "A") return linkText(node, text);
  if (node.tagName === "TD" || node.tagName === "TH") return `${text}\t`;
  if (node.tagName === "TR") return `${text.replace(/\t$/u, "")}\n`;
  return BLOCKS.has(node.tagName) ? `\n${text}\n` : text;
}

export function renderedAnswerText(surface: HTMLElement, fallback: string): string {
  const body = surface.querySelector<HTMLElement>(".response-markdown");
  if (!body) return fallback;
  const text = plainText(body)
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/^(?:[ \t]*\n)+/u, "")
    .replace(/(?:\n[ \t]*)+$/u, "");
  return text.trim() ? text : fallback;
}
