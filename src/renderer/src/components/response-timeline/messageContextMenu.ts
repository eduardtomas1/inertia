import type { ChatMessage } from "@shared/contracts";
import {
  contextMenuHandlers,
  copyFromMenu,
  hasNativeMenuTarget,
  isContextMenuId,
  selectionInside,
  type ContextMenuHandlers,
} from "../../utils/contextMenu";
import { renderedAnswerText } from "../../utils/answerPlainText";

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
        void copyFromMenu(role === "assistant" ? renderedAnswerText(surface, content) : content);
      } else if (action === "copy-markdown") {
        void copyFromMenu(content);
      }
    },
  );
}
