import { compareInitiatives, initiativeMembers } from "@shared/initiatives";

import {
  groupWorkThreads,
  isOrdinarilySnoozedThread,
  sortSidebarThreadViews,
  type SidebarInitiative,
  type SidebarInitiativeSectionId,
  type SidebarThreadStatus,
  type SidebarThreadView,
  type SidebarWorkSection,
} from "./sidebarModel";

/*
 * Initiative grouping for the Work list. Kept apart from sidebarModel so the
 * chat routes that only need thread status do not load it.
 */

export function initiativeWorkSectionId(initiativeId: string): SidebarInitiativeSectionId {
  return `initiative:${initiativeId}`;
}

export function isInitiativeWorkSectionId(id: string): id is SidebarInitiativeSectionId {
  return id.startsWith("initiative:") && id.length > "initiative:".length;
}

export interface InitiativeAggregate {
  /**
   * The most urgent member status: approval > input > failed/limited > working
   * > completed > idle. Attention statuses count only while a member still
   * needs the user, so a settled or acknowledged failure no longer raises it.
   */
  status: SidebarThreadStatus;
  /** Member chats still waiting on the user: needing attention and not settled. */
  attentionCount: number;
  workingCount: number;
}

const aggregatePriority: Record<SidebarThreadStatus, number> = {
  approval: 0,
  input: 1,
  failed: 2,
  limited: 2,
  working: 3,
  completed: 4,
  idle: 5,
};

const ATTENTION_STATUSES: ReadonlySet<SidebarThreadStatus> = new Set(["approval", "input", "failed", "limited"]);

export function initiativeAggregate(threads: readonly SidebarThreadView[]): InitiativeAggregate {
  let status: SidebarThreadStatus = "idle";
  let attentionCount = 0;
  let workingCount = 0;
  for (const thread of threads) {
    const waiting = thread.needsAttention && !thread.settled;
    if (waiting) attentionCount += 1;
    if (thread.status === "working") workingCount += 1;
    // An attention status the user has dealt with no longer ranks as one.
    if (ATTENTION_STATUSES.has(thread.status) && !waiting) continue;
    if (aggregatePriority[thread.status] < aggregatePriority[status]) status = thread.status;
  }
  return { status, attentionCount, workingCount };
}

/**
 * An active initiative section holds only its members that are active work:
 * not settled, not ordinarily snoozed and not hidden. Its snoozed and settled
 * members fall through to Snoozed and Done (or their No project variants)
 * exactly as if they had no initiative, so membership never changes snooze or
 * done semantics. A done initiative's section, collapsed by default, lists all
 * of its non-hidden members. Archived initiatives get no section. A section
 * without a visible member (for example under a project filter or search) is
 * omitted. Active sections sit above the date sections; done sections sit
 * after Earlier and before Done.
 */
export function groupWorkThreadsWithInitiatives(
  threads: readonly SidebarThreadView[],
  initiatives: readonly SidebarInitiative[] = [],
  now = Date.now(),
  scratchProjectIds: ReadonlySet<string> = new Set(),
): SidebarWorkSection[] {
  const sectioned = new Map(initiatives
    .filter(({ status }) => status === "active" || status === "done")
    .map((initiative) => [initiative.id, initiative]));
  const inSection = (thread: SidebarThreadView): boolean => {
    const initiativeId = thread.conversation.initiativeId;
    const initiative = initiativeId ? sectioned.get(initiativeId) : undefined;
    if (!initiative || thread.hidden) return false;
    return initiative.status === "done"
      || (!thread.settled && !isOrdinarilySnoozedThread(thread, now));
  };
  const placed = threads.filter(inSection);
  const base = groupWorkThreads(
    placed.length === 0 ? threads : threads.filter((thread) => !inSection(thread)),
    now,
    scratchProjectIds,
  );
  if (placed.length === 0) return base;
  const members = initiativeMembers(placed, ({ conversation }) => conversation.initiativeId);
  const sectionsFor = (status: SidebarInitiative["status"]): SidebarWorkSection[] => [...sectioned.values()]
    .filter((initiative) => initiative.status === status && members.has(initiative.id))
    .sort(compareInitiatives)
    .map((initiative) => ({
      id: initiativeWorkSectionId(initiative.id),
      label: initiative.name,
      threads: sortSidebarThreadViews(members.get(initiative.id) ?? []),
      initiative,
    }));
  const doneIndex = base.findIndex(({ id }) => id === "done");
  const insertAt = doneIndex < 0 ? base.length : doneIndex;
  return [
    ...sectionsFor("active"),
    ...base.slice(0, insertAt),
    ...sectionsFor("done"),
    ...base.slice(insertAt),
  ];
}
