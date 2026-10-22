import type { AppSettings, ConversationShell, Project, ProviderInfo } from "@shared/contracts";
import { compareTodoBasics, todoDueKey, type Todo, type TodoPriority } from "@shared/todos";

import { INTERFACE_LOCALE } from "../../lib/locale";
import { todoIsOverdue } from "../../utils/todoDates";
import { taskStatusRank, type TaskStatus } from "./taskStatus";

export const TASK_PRIORITY_LABELS: Record<TodoPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const TASK_COMPLETION_HOLD_MS = 400;
export const TASK_COMPLETION_COLLAPSE_MS = 180;

function comparablePath(path: string, windows: boolean): string {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/u, "") : path;
  return windows ? trimmed.replaceAll("\\", "/").toLocaleLowerCase("en-US") : trimmed;
}

export function projectForFolder(
  projects: readonly Project[],
  folder: string,
): Project | undefined {
  const windows = /^[a-z]:[\\/]/iu.test(folder) || folder.startsWith("\\\\");
  const wanted = comparablePath(folder, windows);
  return projects.find((project) => comparablePath(project.normalizedPath, windows) === wanted
    || comparablePath(project.path, windows) === wanted);
}

export function defaultTaskProjectId(
  projects: readonly Project[],
  scopedProjectId: string | null,
  activeProjectId: string | null,
  taskProjectId: string | null = null,
): string | null {
  const known = (id: string | null) => id !== null && projects.some((project) => project.id === id);
  if (known(taskProjectId)) return taskProjectId;
  if (known(scopedProjectId)) return scopedProjectId;
  if (known(activeProjectId)) return activeProjectId;
  return projects[0]?.id ?? null;
}

export function todoInScope(todo: Pick<Todo, "projectId">, scopeId: string | null): boolean {
  return scopeId === null || todo.projectId === null || todo.projectId === scopeId;
}

export interface OrderedTask {
  todo: Todo;
  status: TaskStatus;
}

export function compareOpenTasks(left: OrderedTask, right: OrderedTask, now: Date): number {
  const rank = taskStatusRank(left.status.kind) - taskStatusRank(right.status.kind);
  if (rank !== 0) return rank;
  const leftOverdue = todoIsOverdue(left.todo, now);
  const rightOverdue = todoIsOverdue(right.todo, now);
  if (leftOverdue !== rightOverdue) return leftOverdue ? -1 : 1;
  if (leftOverdue) {
    const leftDue = todoDueKey(left.todo);
    const rightDue = todoDueKey(right.todo);
    if (leftDue !== rightDue) return leftDue < rightDue ? -1 : 1;
  }
  return compareTodoBasics(left.todo, right.todo);
}

export function compareDoneTodos(left: Todo, right: Todo): number {
  const leftDone = left.completedAt ?? "";
  const rightDone = right.completedAt ?? "";
  if (leftDone !== rightDone) return leftDone < rightDone ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function taskProviderLabel(
  shell: Pick<ConversationShell, "providerId"> | null,
  settings: Pick<AppSettings, "providerIdentityLabels">,
  providers: readonly Pick<ProviderInfo, "id" | "label">[],
): string {
  if (!shell) return "The agent";
  return settings.providerIdentityLabels[shell.providerId]
    ?? providers.find(({ id }) => id === shell.providerId)?.label
    ?? "The agent";
}

export function formatTaskDay(value: string, now: Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const month = date.toLocaleDateString(INTERFACE_LOCALE, { month: "short" });
  const label = `${date.getDate()} ${month}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${date.getFullYear()}`;
}

export function finishedLabel(completedAt: string | null, now: number): string {
  const finished = completedAt ? Date.parse(completedAt) : Number.NaN;
  if (!Number.isFinite(finished)) return "Finished";
  const minutes = Math.floor(Math.max(0, now - finished) / 60_000);
  if (minutes < 1) return "Finished just now";
  if (minutes < 60) return `Finished · ${minutes} m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Finished · ${hours} h ago`;
  return `Finished · ${Math.floor(hours / 24)} d ago`;
}

export function sameTaskStatus(left: TaskStatus, right: TaskStatus): boolean {
  return left.kind === right.kind
    && left.bucket === right.bucket
    && left.word === right.word
    && left.tone === right.tone
    && left.need === right.need;
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type);
}
