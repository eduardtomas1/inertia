import type { AppSnapshot, Project } from "@shared/contracts";

export function activeWorkspaceProject(snapshot: AppSnapshot | null): Project | null {
  const project = snapshot?.projects.find(({ id }) => id === snapshot.activeProjectId) ?? null;
  if (project?.workspaceKind === "scratch" && !snapshot?.activeConversationId) return null;
  return project;
}
