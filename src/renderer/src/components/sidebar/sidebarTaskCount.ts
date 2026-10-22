import type { ConversationShell } from "@shared/contracts";
import type { Todo } from "@shared/todos";

import type { SidebarThreadView } from "../../utils/sidebarModel";
import { deriveTaskStatus } from "../tasks/taskStatus";

export function tasksNeedingYou(input: {
  todos: readonly Todo[] | undefined;
  conversations: readonly ConversationShell[];
  threadViews: ReadonlyMap<string, Pick<SidebarThreadView, "status">>;
  projectId: string | null;
  now: number;
}): number {
  if (!input.todos?.length) return 0;
  const shells = new Map(input.conversations.map((conversation) => [conversation.id, conversation]));
  return input.todos.filter((todo) => {
    if (todo.completedAt !== null || todo.conversationId === null) return false;
    if (input.projectId && todo.projectId !== null && todo.projectId !== input.projectId) return false;
    return deriveTaskStatus({
      todo,
      status: input.threadViews.get(todo.conversationId)?.status ?? null,
      shell: shells.get(todo.conversationId) ?? null,
      now: input.now,
      starting: false,
    }).bucket === "needs-you";
  }).length;
}

export function sidebarTasksLabel(count: number): string {
  return count > 0 ? `Tasks, ${count} need${count === 1 ? "s" : ""} you` : "Tasks";
}
