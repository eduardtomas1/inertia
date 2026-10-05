import type { Project } from "@shared/contracts";
import type { SettingsTarget } from "../../lib/settingsTarget";

export const ALL_PROJECTS_ROW_IDS: ReadonlySet<string> = new Set(["project-chooser", "project-grouping", "compact-sidebar"]);

export function withRowProject(target: SettingsTarget, projects: readonly Pick<Project, "id" | "workspaceKind">[], currentProjectId: string | null): SettingsTarget {
  if (target.section !== "projects" || !target.anchor || ALL_PROJECTS_ROW_IDS.has(target.anchor) || target.projectId) return target;
  const regular = projects.filter(({ workspaceKind }) => workspaceKind !== "scratch");
  const projectId = (regular.find(({ id }) => id === currentProjectId) ?? regular[0])?.id;
  return projectId ? { ...target, projectId } : target;
}
