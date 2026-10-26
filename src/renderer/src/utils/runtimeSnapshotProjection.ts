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
  snapshot: AppSnapshot,
  event: ConversationShellEvent,
): AppSnapshot {
  const conversationId = event.conversation.id;
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
