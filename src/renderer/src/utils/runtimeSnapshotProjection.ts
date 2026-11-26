import type {
  AppSnapshot,
  RuntimeMutationEvent,
} from "@shared/contracts";

import { EN_COLLATOR, compareTimestampsAsc } from "./fastCompare";
import { structurallyEqual } from "./structuralEquality";

type ConversationShellEvent = Extract<
  RuntimeMutationEvent,
  { type: "conversation.shell.updated" }
>;
type TodosEvent = Extract<RuntimeMutationEvent, { type: "todos.updated" }>;
type LibraryEvent = Extract<RuntimeMutationEvent, { type: "library.updated" }>;

function compareDescendingTimestamp<
  Item extends { id: string; startedAt?: string; updatedAt?: string },
>(left: Item, right: Item): number {
  const leftRaw = left.startedAt ?? left.updatedAt ?? "";
  const rightRaw = right.startedAt ?? right.updatedAt ?? "";
  const diff = compareTimestampsAsc(rightRaw, leftRaw);
  if (diff !== 0) return diff;
  return EN_COLLATOR.compare(left.id, right.id);
}

function sortDescendingTimestamp<
  Item extends { id: string; startedAt?: string; updatedAt?: string },
>(items: Item[]): Item[] {
  return items.sort(compareDescendingTimestamp);
}

function upsertSortedConversation<
  Item extends { id: string; startedAt?: string; updatedAt?: string },
>(items: readonly Item[], incoming: Item): Item[] {
  const next: Item[] = [];
  let inserted = false;
  let sorted = true;
  let previous: Item | null = null;
  for (const entry of items) {
    if (entry.id === incoming.id) continue;
    if (previous !== null && compareDescendingTimestamp(previous, entry) > 0) {
      sorted = false;
    }
    if (!inserted && compareDescendingTimestamp(incoming, entry) <= 0) {
      next.push(incoming);
      inserted = true;
    }
    next.push(entry);
    previous = entry;
  }
  if (!inserted) next.push(incoming);
  return sorted ? next : sortDescendingTimestamp(next);
}

/**
 * Applies one bounded conversation projection to the renderer's shell.
 * Transcript and execution-detail payloads remain on their subscribed stream.
 */
export function applyConversationShellEvent(
  shell: AppSnapshot,
  event: ConversationShellEvent,
): AppSnapshot {
  let snapshot = shell;
  const conversationId = event.conversation.id;
  const archived = event.conversation.archivedAt !== null
    && conversationId !== snapshot.activeConversationId;
  const refs = snapshot.archivedConversationRefs ?? [];
  if (archived || refs.some(({ id }) => id === conversationId)) {
    const { id, projectId, title, providerId, archivedAt } = event.conversation;
    const nextRefs = archived
      ? [...refs.filter((ref) => ref.id !== id), { id, projectId, title, providerId, archivedAt: archivedAt! }]
      : refs.filter((ref) => ref.id !== id);
    snapshot = { ...snapshot, archivedConversationRefs: nextRefs };
    if (archived) {
      return {
        ...snapshot,
        conversations: snapshot.conversations.filter((conversation) => conversation.id !== id),
        runs: sortDescendingTimestamp([
          ...snapshot.runs.filter((run) => run.conversationId !== id),
          ...event.runs,
        ]).slice(0, 200),
      };
    }
  }
  const current = snapshot.conversations.find(({ id }) => id === conversationId);
  const conversation = current && structurallyEqual(current, event.conversation)
    ? current
    : event.conversation;
  const currentRuns = snapshot.runs.filter((run) => run.conversationId === conversationId);
  const eventRuns = event.runs.map((run) => currentRuns.find((existing) => (
    existing.id === run.id && structurallyEqual(existing, run)
  )) ?? run);
  const runsUnchanged = currentRuns.length === eventRuns.length
    && eventRuns.every((run) => currentRuns.includes(run));
  if (conversation === current && runsUnchanged) return snapshot;
  const conversations = conversation === current
    ? snapshot.conversations
    : upsertSortedConversation(snapshot.conversations, conversation);
  const runs = runsUnchanged
    ? snapshot.runs
    : sortDescendingTimestamp([
        ...snapshot.runs.filter((run) => run.conversationId !== conversationId),
        ...eventRuns,
      ]).slice(0, 200);
  return {
    ...snapshot,
    conversations,
    runs,
  };
}

export function applyTodosEvent(
  snapshot: AppSnapshot,
  event: TodosEvent,
): AppSnapshot {
  if (structurallyEqual(snapshot.todos, event.todos)) return snapshot;
  return { ...snapshot, todos: event.todos };
}

export function withStableLibrary(
  previous: AppSnapshot | null,
  next: AppSnapshot,
): AppSnapshot {
  if (!previous?.library || !next.library || previous.library === next.library) return next;
  return structurallyEqual(previous.library, next.library) ? { ...next, library: previous.library } : next;
}

export function applyLibraryEvent(
  snapshot: AppSnapshot,
  event: LibraryEvent,
): AppSnapshot {
  if (structurallyEqual(snapshot.library, event.library)) return snapshot;
  return { ...snapshot, library: event.library };
}

type WatcherLinkEvent = Extract<
  RuntimeMutationEvent,
  { type: "watcher.link.updated" | "watcher.link.removed" }
>;

export function applyWatcherLinkEvent(
  snapshot: AppSnapshot,
  event: WatcherLinkEvent,
): AppSnapshot {
  const current = snapshot.watchers ?? [];
  if (event.type === "watcher.link.removed") {
    if (!current.some(({ id }) => id === event.linkId)) return snapshot;
    return { ...snapshot, watchers: current.filter(({ id }) => id !== event.linkId) };
  }
  const index = current.findIndex(({ id }) => id === event.link.id);
  if (index >= 0 && structurallyEqual(current[index], event.link)) return snapshot;
  const watchers = index >= 0
    ? current.map((link, position) => position === index ? event.link : link)
    : [...current, event.link];
  return { ...snapshot, watchers };
}
