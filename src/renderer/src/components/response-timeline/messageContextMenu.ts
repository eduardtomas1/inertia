import type { ChatMessage } from "@shared/contracts";
import { writeClipboardText } from "../../utils/clipboard";
import {
  contextMenuHandlers,
  hasNativeMenuTarget,
  isContextMenuId,
  selectionInside,
  type ContextMenuHandlers,
} from "../../utils/contextMenu";

const SKIPPED = [
  "button",
  "[aria-hidden='true']",
  "[role='alert']",
  ".visually-hidden",
  ".response-code-block > header",
  ".response-table-toolbar",
].join(", ");
const BLOCKS = new Set([
  "P", "PRE", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TR", "HR", "DIV",
]);

function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement) || node.matches(SKIPPED)) return "";
  if (node.tagName === "BR") return "\n";
  const text = [...node.childNodes].map(plainText).join("");
  if (node.tagName === "TD" || node.tagName === "TH") return `${text}\t`;
  return BLOCKS.has(node.tagName) ? `\n${text}\n` : text;
}

function renderedText(surface: HTMLElement, fallback: string): string {
  const body = surface.querySelector<HTMLElement>(".response-markdown");
  if (!body) return fallback;
  const text = plainText(body)
    .replace(/\t\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return text || fallback;
}

export function messageContextMenu(
  message: Pick<ChatMessage, "conversationId" | "role">,
  content: string,
): ContextMenuHandlers<HTMLElement> | undefined {
  const { conversationId, role } = message;
  if ((role !== "user" && role !== "assistant") || !isContextMenuId(conversationId)) return undefined;
  return contextMenuHandlers<HTMLElement>(
    (target, surface) => hasNativeMenuTarget(target, surface)
      ? null
      : { kind: "message", conversationId, role, hasSelection: selectionInside(surface) },
    (action, surface) => {
      if (action === "copy-message") {
        void writeClipboardText(role === "assistant" ? renderedText(surface, content) : content);
      } else if (action === "copy-markdown") {
        void writeClipboardText(content);
      }
    },
  );
}
