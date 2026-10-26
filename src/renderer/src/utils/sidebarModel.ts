import type { Conversation, ConversationLatestTurnSummary, WorkspaceRun } from "@shared/contracts";
import {
  indexConversationWorkspaceRuns,
  selectConversationWorkspaceRun,
  workspaceRunAttentionView,
} from "../../../shared/attention";

export type SidebarThreadStatus = "working" | "approval" | "input" | "failed" | "limited" | "completed" | "idle";
type SidebarConversation = Conversation & {
  latestTurn?: Pick<ConversationLatestTurnSummary, "status" | "usageLimited"> | null;
};

export interface SidebarThreadView {
  conversation: Conversation;
  run: WorkspaceRun | null;
  status: SidebarThreadStatus;
  needsAttention: boolean;
  unread: boolean;
  hidden: boolean;
  settled: boolean;
}

export type SidebarWorkSectionId = "recent" | "yesterday" | "earlier" | "done" | "snoozed"
  | "no-project" | "no-project-done" | "no-project-snoozed";

export interface SidebarWorkSection {
  id: SidebarWorkSectionId;
  label: string;
  threads: SidebarThreadView[];
  totalCount?: number;
}

export function hasUnreadCompletion(conversation: Conversation, activeConversationId: string | null): boolean {
  if (!conversation.completedAt || conversation.id === activeConversationId) return false;
  if (!conversation.lastViewedAt) return true;
  return conversation.completedAt > conversation.lastViewedAt;
}

function sidebarThreadViewForRun(
  conversation: SidebarConversation,
  activeConversationId: string | null,
  run: WorkspaceRun | null,
): SidebarThreadView {
  const runAttention = run ? workspaceRunAttentionView(run) : null;
  const reported: SidebarThreadStatus = run?.status === "waiting"
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
  const status: SidebarThreadStatus = reported === "failed"
    && conversation.latestTurn?.status === "failed"
    && conversation.latestTurn.usageLimited === true
    ? "limited"
    : reported;
  return {
    conversation,
    run,
    status,
    needsAttention: runAttention?.needsAttention
      ?? (status === "approval" || status === "input" || status === "failed" || status === "limited"),
    unread: Boolean(conversation.markedUnreadAt) || (runAttention?.unread ?? hasUnreadCompletion(conversation, activeConversationId)),
    hidden: runAttention?.bucket === "hidden",
    settled: conversation.settledAt !== null,
  };
}

export function sidebarThreadView(
  conversation: SidebarConversation,
  activeConversationId: string | null,
  runs: readonly WorkspaceRun[] = [],
): SidebarThreadView {
  return sidebarThreadViewForRun(
    conversation,
    activeConversationId,
    selectConversationWorkspaceRun(conversation.id, runs),
  );
}

const previousViews = new WeakMap<
  readonly SidebarConversation[],
  readonly [activeConversationId: string | null, views: ReadonlyMap<string, SidebarThreadView>]
>();

export function sidebarThreadViewMap(
  conversations: readonly SidebarConversation[],
  activeConversationId: string | null,
  runs: readonly WorkspaceRun[] = [],
): ReadonlyMap<string, SidebarThreadView> {
  const runsByConversation = indexConversationWorkspaceRuns(runs);
  const [previousActiveConversationId, previous] = previousViews.get(conversations) ?? [];
  const prior = previousActiveConversationId === activeConversationId ? previous : undefined;
  let reused = prior !== undefined;
  const views = new Map(conversations.map((conversation) => {
    const run = runsByConversation.get(conversation.id) ?? null;
    const view = prior?.get(conversation.id);
    if (view?.run === run) return [conversation.id, view];
    reused = false;
    return [conversation.id, sidebarThreadViewForRun(conversation, activeConversationId, run)];
  }));
  const result = reused ? prior! : views;
  previousViews.set(conversations, [activeConversationId, result]);
  return result;
}

const statusPriority: Record<SidebarThreadStatus, number> = {
  approval: 0,
  input: 1,
  working: 2,
  failed: 3,
  limited: 3,
  completed: 4,
  idle: 5,
};

export function sortActivityThreads(
  conversations: readonly SidebarConversation[],
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
      || (
        a.status === "working" && b.status === "working"
          ? (b.run?.startedAt ?? b.conversation.createdAt)
              .localeCompare(a.run?.startedAt ?? a.conversation.createdAt, "en")
          : b.conversation.updatedAt.localeCompare(a.conversation.updatedAt, "en")
      )
      || a.conversation.id.localeCompare(b.conversation.id, "en")
    ));
}

function localCalendarDayStart(value: number | string): number {
  const date = new Date(value);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

export function groupWorkThreads(
  threads: readonly SidebarThreadView[],
  now = Date.now(),
  scratchProjectIds: ReadonlySet<string> = new Set(),
): SidebarWorkSection[] {
  if (scratchProjectIds.size > 0) {
    const scratch = groupWorkThreads(threads.filter(({ conversation }) => (
      scratchProjectIds.has(conversation.projectId)
    )), now);
    const projects = groupWorkThreads(threads.filter(({ conversation }) => (
      !scratchProjectIds.has(conversation.projectId)
    )), now);
    const totalCount = scratch.reduce((total, section) => total + section.threads.length, 0);
    if (totalCount === 0) return projects;
    return [...projects, {
      id: "no-project",
      label: "No project",
      totalCount,
      threads: scratch.filter(({ id }) => id !== "done" && id !== "snoozed")
        .flatMap(({ threads }) => threads),
    }, ...scratch.filter(({ id }) => id === "done" || id === "snoozed")
      .map((section): SidebarWorkSection => ({
        ...section,
        id: section.id === "done" ? "no-project-done" : "no-project-snoozed",
      }))];
  }
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
  const currentDay = localCalendarDayStart(now);
  const recent: SidebarThreadView[] = [];
  const yesterday: SidebarThreadView[] = [];
  const earlier: SidebarThreadView[] = [];
  const done: SidebarThreadView[] = [];
  const snoozed: SidebarThreadView[] = [];
  for (const thread of threads) {
    if (isOrdinarilySnoozed(thread)) snoozed.push(thread);
    else if (thread.hidden) continue;
    else if (thread.settled) done.push(thread);
    else if (thread.needsAttention || thread.status === "working") recent.push(thread);
    else {
      const offset = Math.round(
        (currentDay - localCalendarDayStart(thread.conversation.updatedAt)) / 86_400_000,
      );
      if (offset <= 0) recent.push(thread);
      else if (offset === 1) yesterday.push(thread);
      else earlier.push(thread);
    }
  }
  return [
    {
      id: "recent",
      label: "Recent",
      threads: recent,
    },
    {
      id: "yesterday",
      label: "Yesterday",
      threads: yesterday,
    },
    {
      id: "earlier",
      label: "Earlier",
      threads: earlier,
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

export type SidebarNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function isSidebarNavigationKey(key: string): key is SidebarNavigationKey {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
}

export function nextSidebarNavigationIndex(
  currentIndex: number,
  key: SidebarNavigationKey,
  itemCount: number,
): number {
  if (itemCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (currentIndex < 0 || currentIndex >= itemCount) {
    return key === "ArrowUp" ? itemCount - 1 : 0;
  }
  if (key === "ArrowDown") return (currentIndex + 1) % itemCount;
  return (currentIndex - 1 + itemCount) % itemCount;
}

export function nextSelectableNavigationIndex(
  indices: readonly number[],
  currentIndex: number,
  key: SidebarNavigationKey,
): number {
  return indices[nextSidebarNavigationIndex(
    indices.indexOf(currentIndex),
    key,
    indices.length,
  )] ?? -1;
}
