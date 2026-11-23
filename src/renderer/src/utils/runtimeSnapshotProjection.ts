import type {
  AppSnapshot,
  RuntimeMutationEvent,
} from "@shared/contracts";

import { structurallyEqual } from "./structuralEquality";

type ConversationShellEvent = Extract<
  RuntimeMutationEvent,
  { type: "conversation.shell.updated" }
>;
type TodosEvent = Extract<RuntimeMutationEvent, { type: "todos.updated" }>;
type LibraryEvent = Extract<RuntimeMutationEvent, { type: "library.updated" }>;

function sortDescendingTimestamp<
  Item extends { id: string; startedAt?: string; updatedAt?: string },
>(items: Item[]): Item[] {
  const times = new Map(items.map((item) => [
    item,
    Date.parse(item.startedAt ?? item.updatedAt ?? "") || 0,
  ]));
  return items.sort((left, right) => (
    times.get(right)! - times.get(left)!
    || left.id.localeCompare(right.id, "en")
  ));
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
  if (
    conversation === current
    && currentRuns.length === eventRuns.length
    && eventRuns.every((run) => currentRuns.includes(run))
  ) return snapshot;
  const conversations = sortDescendingTimestamp([
    ...snapshot.conversations.filter(({ id }) => id !== conversationId),
    conversation,
  ]);
  return {
    ...snapshot,
    conversations: conversations.every((item, index) => item === snapshot.conversations[index])
      ? snapshot.conversations
      : conversations,
    runs: sortDescendingTimestamp([
      ...snapshot.runs.filter((run) => run.conversationId !== conversationId),
      ...eventRuns,
    ]).slice(0, 200),
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
