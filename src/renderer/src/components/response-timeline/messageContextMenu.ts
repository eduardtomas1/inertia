import type { ChatMessage } from "@shared/contracts";
import { todoDraftFromMessage } from "@shared/todos";
import {
  contextMenuHandlers,
  copyFromMenu,
  hasNativeMenuTarget,
  isContextMenuId,
  selectionInside,
  type ContextMenuHandlers,
} from "../../utils/contextMenu";
import { renderedAnswerText } from "../../utils/answerPlainText";
import type { TaskCreator } from "../tasks/taskCreation";

export function messageContextMenu(
  message: Pick<ChatMessage, "conversationId" | "role">,
  content: string,
  taskCreator: TaskCreator | null = null,
): ContextMenuHandlers<HTMLElement> | undefined {
  const { conversationId, role } = message;
  if ((role !== "user" && role !== "assistant") || !isContextMenuId(conversationId)) return undefined;
  return contextMenuHandlers<HTMLElement>(
    (target, surface) => hasNativeMenuTarget(target, surface)
      ? null
      : { kind: "message", conversationId, role, hasSelection: selectionInside(surface) },
    (action, surface) => {
      const plainText = (): string => role === "assistant" ? renderedAnswerText(surface, content) : content;
      if (action === "copy-message") {
        void copyFromMenu(plainText());
      } else if (action === "copy-markdown") {
        void copyFromMenu(content);
      } else if (action === "create-task") {
        taskCreator?.create(conversationId, () => todoDraftFromMessage(plainText()));
      }
    },
  );
}
