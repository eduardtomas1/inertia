import type { Conversation, Project, ProjectGroupingMode, WorkspaceRun } from "@shared/contracts";
import {
  indexConversationWorkspaceRuns,
  selectConversationWorkspaceRun,
  workspaceRunAttentionView,
} from "../../../shared/attention";

export type SidebarThreadStatus = "working" | "approval" | "input" | "failed" | "completed" | "idle";

export interface ClassicSidebarSearchResult {
  projects: Project[];
  conversationsByProject: Map<string, Conversation[]>;
}

/**
 * Archived and ordinary snoozed chats never participate in classic search.
 * Running or attention-blocked chats stay visible even while snoozed. A
 * project-name/path match exposes its visible chats, while a chat-only match
 * exposes only the matching chats instead of every sibling in the project.
 */
export function classicSidebarSearch(
  projects: readonly Project[],
  conversations: readonly Conversation[],
  query: string,
  now = Date.now(),
): ClassicSidebarSearchResult {
  const needle = query.trim().toLocaleLowerCase();
  const activeByProject = new Map<string, Conversation[]>();
  for (const conversation of conversations) {
    if (conversation.archivedAt !== null) continue;
    const snoozed = Boolean(
      conversation.snoozedUntil
      && Date.parse(conversation.snoozedUntil) > now,
    );
    if (
      snoozed
      && conversation.status !== "running"
      && conversation.status !== "needs-input"
    ) continue;
    const current = activeByProject.get(conversation.projectId) ?? [];
    current.push(conversation);
    activeByProject.set(conversation.projectId, current);
  }
  for (const current of activeByProject.values()) {
    current.sort((left, right) => (
      Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt))
      || (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "")
      || right.updatedAt.localeCompare(left.updatedAt)
    ));
  }

  const visibleProjects: Project[] = [];
  const conversationsByProject = new Map<string, Conversation[]>();
  for (const project of projects) {
    const active = activeByProject.get(project.id) ?? [];
    const projectMatches = !needle
      || project.name.toLocaleLowerCase().includes(needle)
      || project.path.toLocaleLowerCase().includes(needle);
    const matchingConversations = needle
      ? active.filter(({ title }) =>
          title.toLocaleLowerCase().includes(needle))
      : active;
    if (!projectMatches && matchingConversations.length === 0) continue;
    visibleProjects.push(project);
    conversationsByProject.set(
      project.id,
      projectMatches ? active : matchingConversations,
    );
  }
  return { projects: visibleProjects, conversationsByProject };
}

export interface SidebarThreadView {
  conversation: Conversation;
  run: WorkspaceRun | null;
  status: SidebarThreadStatus;
  needsAttention: boolean;
  unread: boolean;
  hidden: boolean;
  settled: boolean;
}

export type SidebarWorkSectionId = "recent" | "yesterday" | "earlier" | "done" | "snoozed";

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

function sidebarThreadViewForRun(
  conversation: Conversation,
  activeConversationId: string | null,
  run: WorkspaceRun | null,
): SidebarThreadView {
  const runAttention = run ? workspaceRunAttentionView(run) : null;
  const status: SidebarThreadStatus = run?.status === "waiting"
    ? conversation.attentionKind === "approval" ? "approval" : "input"
    : run?.status === "running"
      ? "working"
      : run?.status === "failed"
        ? "failed"
        : run?.status === "succeeded"
          ? "completed"
          : run
            ? "idle"
            : conversation.status === "needs-input"
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
    run,
    status,
    needsAttention: runAttention?.needsAttention
      ?? (status === "approval" || status === "input" || status === "failed"),
    unread: runAttention?.unread ?? hasUnreadCompletion(conversation, activeConversationId),
    hidden: runAttention?.bucket === "hidden",
    settled: conversation.settledAt !== null,
  };
}

export function sidebarThreadView(
  conversation: Conversation,
  activeConversationId: string | null,
  runs: readonly WorkspaceRun[] = [],
): SidebarThreadView {
  return sidebarThreadViewForRun(
    conversation,
    activeConversationId,
    selectConversationWorkspaceRun(conversation.id, runs),
  );
}

export function sidebarThreadViewMap(
  conversations: readonly Conversation[],
  activeConversationId: string | null,
  runs: readonly WorkspaceRun[] = [],
): ReadonlyMap<string, SidebarThreadView> {
  const runsByConversation = indexConversationWorkspaceRuns(runs);
  return new Map(conversations.map((conversation) => [
    conversation.id,
    sidebarThreadViewForRun(
      conversation,
      activeConversationId,
      runsByConversation.get(conversation.id) ?? null,
    ),
  ]));
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
  runs: readonly WorkspaceRun[] = [],
): SidebarThreadView[] {
  const views = sidebarThreadViewMap(
    conversations,
    activeConversationId,
    runs,
  );
  return sortSidebarThreadViews(conversations
    .filter(({ archivedAt }) => archivedAt === null)
    .map((conversation) => views.get(conversation.id)!));
}

export function sortSidebarThreadViews(
  threads: readonly SidebarThreadView[],
): SidebarThreadView[] {
  return [...threads]
    .filter(({ conversation }) => conversation.archivedAt === null)
    .sort((a, b) => (
      Number(a.settled) - Number(b.settled)
      || Number(b.needsAttention) - Number(a.needsAttention)
      || Number(Boolean(b.conversation.pinnedAt))
        - Number(Boolean(a.conversation.pinnedAt))
      || statusPriority[a.status] - statusPriority[b.status]
      || Number(b.unread) - Number(a.unread)
      || b.conversation.updatedAt.localeCompare(a.conversation.updatedAt)
      || a.conversation.id.localeCompare(b.conversation.id)
    ));
}

function localCalendarDayOffset(value: string, now: number): number {
  const date = new Date(value);
  const current = new Date(now);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(current.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  const dateDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const currentDay = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
  ).getTime();
  return Math.round((currentDay - dateDay) / 86_400_000);
}

export function groupWorkThreads(
  threads: readonly SidebarThreadView[],
  now = Date.now(),
): SidebarWorkSection[] {
  const isOrdinarilySnoozed = ({
    conversation,
    needsAttention,
    status,
  }: SidebarThreadView) => Boolean(
    conversation.snoozedUntil
    && Date.parse(conversation.snoozedUntil) > now
    && !needsAttention
    && status !== "working"
  );
  const snoozed = threads.filter(isOrdinarilySnoozed);
  const active = threads.filter((thread) => (
    !thread.settled && !thread.hidden && !isOrdinarilySnoozed(thread)
  ));
  const done = threads.filter((thread) => (
    thread.settled && !thread.hidden && !isOrdinarilySnoozed(thread)
  ));
  const dayOffset = ({ conversation }: SidebarThreadView) => (
    localCalendarDayOffset(conversation.updatedAt, now)
  );
  const urgent = ({ needsAttention, status }: SidebarThreadView) => (
    needsAttention || status === "working"
  );
  return [
    {
      id: "recent",
      label: "Recent",
      threads: active.filter((thread) => urgent(thread) || dayOffset(thread) <= 0),
    },
    {
      id: "yesterday",
      label: "Yesterday",
      threads: active.filter((thread) => !urgent(thread) && dayOffset(thread) === 1),
    },
    {
      id: "earlier",
      label: "Earlier",
      threads: active.filter((thread) => !urgent(thread) && dayOffset(thread) > 1),
    },
    {
      id: "done",
      label: "Done",
      threads: done,
    },
    {
      id: "snoozed",
      label: "Snoozed",
      threads: snoozed,
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
