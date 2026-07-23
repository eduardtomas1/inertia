import type { Conversation, Project, ProjectGroupingMode } from "@shared/contracts";

export type SidebarThreadStatus = "working" | "approval" | "input" | "failed" | "completed" | "idle";

export interface SidebarThreadView {
  conversation: Conversation;
  status: SidebarThreadStatus;
  unread: boolean;
  settled: boolean;
}

export type SidebarWorkSectionId = "needs-you" | "in-progress" | "recent";

export interface SidebarWorkSection {
  id: SidebarWorkSectionId;
  label: string;
  threads: SidebarThreadView[];
}

export interface LogicalProjectGroup {
  key: string;
  label: string;
  projects: Project[];
}

export function resolvedProjectGrouping(project: Project, globalMode: ProjectGroupingMode): ProjectGroupingMode {
  return project.groupingMode ?? globalMode;
}

function physicalProjectKey(project: Project): string {
  return project.repositoryIdentity
    ? `repository:${project.repositoryIdentity}`
    : `path:${project.normalizedPath || project.path}`;
}

export function logicalProjectKey(project: Project, globalMode: ProjectGroupingMode): string {
  const mode = resolvedProjectGrouping(project, globalMode);
  if (mode === "separate") return `project:${project.id}`;
  const physical = physicalProjectKey(project);
  if (mode === "repository") return `${mode}:${physical}`;
  const relativePath = project.repositoryIdentity
    ? project.repositoryRelativePath || "."
    : project.normalizedPath || project.path;
  return `${mode}:${physical}:scope:${relativePath}`;
}

export function buildLogicalProjectGroups(
  projects: readonly Project[],
  globalMode: ProjectGroupingMode,
): LogicalProjectGroup[] {
  const groups = new Map<string, Project[]>();
  for (const project of projects) {
    const key = logicalProjectKey(project, globalMode);
    const existing = groups.get(key);
    if (existing) existing.push(project);
    else groups.set(key, [project]);
  }
  return [...groups.entries()]
    .map(([key, members]) => {
      const projects = [...members].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      const representative = projects[0]!;
      const repositoryName = representative.repositoryRoot?.split("/").filter(Boolean).at(-1);
      return {
        key,
        label: projects.length > 1 && repositoryName ? repositoryName : representative.name,
        projects,
      };
    })
    .sort((a, b) => b.projects[0]!.updatedAt.localeCompare(a.projects[0]!.updatedAt) || a.key.localeCompare(b.key));
}

export function hasUnreadCompletion(conversation: Conversation, activeConversationId: string | null): boolean {
  if (!conversation.completedAt || conversation.id === activeConversationId) return false;
  if (!conversation.lastViewedAt) return true;
  return conversation.completedAt > conversation.lastViewedAt;
}

export function sidebarThreadView(
  conversation: Conversation,
  activeConversationId: string | null,
): SidebarThreadView {
  const status: SidebarThreadStatus = conversation.status === "needs-input"
    ? conversation.attentionKind === "approval" ? "approval" : "input"
    : conversation.status === "running"
      ? "working"
      : conversation.status === "failed"
        ? "failed"
        : conversation.status === "completed"
          ? "completed"
          : "idle";
  return {
    conversation,
    status,
    unread: hasUnreadCompletion(conversation, activeConversationId),
    settled: conversation.settledAt !== null,
  };
}

const statusPriority: Record<SidebarThreadStatus, number> = {
  approval: 0,
  input: 1,
  working: 2,
  failed: 3,
  completed: 4,
  idle: 5,
};

export function sortActivityThreads(
  conversations: readonly Conversation[],
  activeConversationId: string | null,
): SidebarThreadView[] {
  return conversations
    .filter(({ archivedAt }) => archivedAt === null)
    .map((conversation) => sidebarThreadView(conversation, activeConversationId))
    .sort((a, b) => (
      Number(a.settled) - Number(b.settled)
      || statusPriority[a.status] - statusPriority[b.status]
      || Number(b.unread) - Number(a.unread)
      || b.conversation.updatedAt.localeCompare(a.conversation.updatedAt)
      || a.conversation.id.localeCompare(b.conversation.id)
    ));
}

export function groupWorkThreads(threads: readonly SidebarThreadView[]): SidebarWorkSection[] {
  const active = threads.filter(({ settled }) => !settled);
  return [
    {
      id: "needs-you",
      label: "Needs you",
      threads: active.filter(({ status }) => status === "approval" || status === "input" || status === "failed"),
    },
    {
      id: "in-progress",
      label: "In progress",
      threads: active.filter(({ status }) => status === "working"),
    },
    {
      id: "recent",
      label: "Recent",
      threads: active.filter(({ status }) => status === "completed" || status === "idle"),
    },
  ];
}

export function nextSidebarNavigationIndex(
  currentIndex: number,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
  itemCount: number,
): number {
  if (itemCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  const safeCurrent = currentIndex >= 0 && currentIndex < itemCount ? currentIndex : 0;
  if (key === "ArrowDown") return (safeCurrent + 1) % itemCount;
  return (safeCurrent - 1 + itemCount) % itemCount;
}
