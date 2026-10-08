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

function linkText(text: string, href: string): string {
  if (!/^(?:https?|mailto):/iu.test(href)) return text;
  const named = [text, `mailto:${text}`]
    .some((candidate) => URL.canParse(candidate) && new URL(candidate).href === href);
  return named ? text : `${text} (${href})`;
}

function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    return STRUCTURAL.has(node.parentElement?.tagName ?? "") && !text.trim() ? "" : text;
  }
  if (!(node instanceof HTMLElement) || node.matches(SKIPPED)) return "";
  if (node.tagName === "BR") return "\n";
  if (node.tagName === "HR") return "\n\n";
  const text = [...node.childNodes].map(plainText).join("");
  if (node.tagName === "A") return linkText(text, node.getAttribute("href") ?? "");
  if (node.tagName === "TD" || node.tagName === "TH") return `${text}\t`;
  if (node.tagName === "TR") return `${text.replace(/\t$/u, "")}\n`;
  if (node.tagName === "LI") {
    return `${listPrefix(node)}${text.replace(/^\n+|\n+$/gu, "").replace(/\n{2,}/gu, "\n")}\n`;
  }
  return BLOCKS.has(node.tagName) ? `\n${text}\n` : text;
}

export function renderedAnswerText(surface: HTMLElement, fallback: string): string {
  const body = surface.querySelector<HTMLElement>(".response-markdown");
  if (!body) return fallback;
  const text = plainText(body).replace(/\n{3,}/gu, "\n\n").trim();
  return text || fallback;
}
