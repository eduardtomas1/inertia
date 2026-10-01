import type { Conversation, Project, WorkspaceRun } from "@shared/contracts";
import { sidebarThreadViewMap, type SidebarThreadView } from "./sidebarModel";

export const TASK_BOARD_COLUMNS = [
  { id: "ready", label: "Ready", description: "Tasks waiting to be picked up" },
  { id: "working", label: "Working", description: "Agents currently running" },
  { id: "review", label: "Needs attention", description: "Review results or unblock an agent" },
  { id: "done", label: "Done", description: "Tasks you have settled" },
] as const;
export type TaskBoardColumn = typeof TASK_BOARD_COLUMNS[number]["id"];
export interface TaskBoardCard extends SidebarThreadView { project: Project; column: TaskBoardColumn }

export function taskBoardColumn(thread: SidebarThreadView): TaskBoardColumn {
  if (thread.status === "working") return "working";
  if (thread.status === "approval" || thread.status === "input") return "review";
  if (thread.settled) return "done";
  return thread.status === "completed" || thread.status === "failed" ? "review" : "ready";
}

export function taskBoardCards(input: {
  conversations: readonly Conversation[]; projects: readonly Project[]; runs: readonly WorkspaceRun[];
  projectId: string | null; query: string; includeSnoozed: boolean; now: number;
}): TaskBoardCard[] {
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  const views = sidebarThreadViewMap(input.conversations, null, input.runs);
  const query = input.query.trim().toLocaleLowerCase();
  return input.conversations.flatMap((conversation): TaskBoardCard[] => {
    const project = projects.get(conversation.projectId);
    const thread = views.get(conversation.id);
    if (!project || !thread || conversation.archivedAt || (input.projectId && input.projectId !== project.id)) return [];
    if (!input.includeSnoozed && conversation.snoozedUntil && Date.parse(conversation.snoozedUntil) > input.now
      && thread.status !== "working" && !thread.needsAttention) return [];
    if (query && !`${conversation.title}\n${project.name}\n${project.path}\n${conversation.branch ?? ""}`.toLocaleLowerCase().includes(query)) return [];
    return [{ ...thread, project, column: taskBoardColumn(thread) }];
  }).sort((a, b) => Number(Boolean(b.conversation.pinnedAt)) - Number(Boolean(a.conversation.pinnedAt))
    || b.conversation.updatedAt.localeCompare(a.conversation.updatedAt)
    || a.conversation.id.localeCompare(b.conversation.id));
}

export function canSettleBoardCard(card: TaskBoardCard): boolean {
  return card.status !== "working" && card.status !== "approval" && card.status !== "input"
    && card.conversation.status !== "running" && card.conversation.status !== "needs-input";
}
