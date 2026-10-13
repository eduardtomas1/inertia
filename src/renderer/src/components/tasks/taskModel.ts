import type { Project } from "@shared/contracts";
import type { TodoPriority } from "@shared/todos";

import type { SidebarThreadStatus } from "../../utils/sidebarModel";

export type TaskStatusWord = "Working" | "Needs attention" | "Done" | "Failed";

export const TASK_PRIORITY_LABELS: Record<TodoPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function taskStatusWord(status: SidebarThreadStatus): TaskStatusWord | null {
  if (status === "working") return "Working";
  if (status === "approval" || status === "input" || status === "limited") return "Needs attention";
  if (status === "failed") return "Failed";
  if (status === "completed") return "Done";
  return null;
}

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
): string | null {
  const known = (id: string | null) => id !== null && projects.some((project) => project.id === id);
  if (known(scopedProjectId)) return scopedProjectId;
  if (known(activeProjectId)) return activeProjectId;
  return projects[0]?.id ?? null;
}
