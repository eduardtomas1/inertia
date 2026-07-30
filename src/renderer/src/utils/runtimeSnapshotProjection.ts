import type {
  AppSnapshot,
  RuntimeMutationEvent,
} from "@shared/contracts";

type ConversationShellEvent = Extract<
  RuntimeMutationEvent,
  { type: "conversation.shell.updated" }
>;

function descendingTimestamp(
  left: { id: string; startedAt?: string; updatedAt?: string },
  right: { id: string; startedAt?: string; updatedAt?: string },
): number {
  const leftTime = Date.parse(left.startedAt ?? left.updatedAt ?? "");
  const rightTime = Date.parse(right.startedAt ?? right.updatedAt ?? "");
  return (Number.isFinite(rightTime) ? rightTime : 0)
    - (Number.isFinite(leftTime) ? leftTime : 0)
    || left.id.localeCompare(right.id);
}

/**
 * Applies one bounded conversation projection to the renderer's shell.
 * Transcript and execution-detail payloads remain on their subscribed stream.
 */
export function applyConversationShellEvent(
  snapshot: AppSnapshot,
  event: ConversationShellEvent,
): AppSnapshot {
  const conversations = [
    ...snapshot.conversations.filter(({ id }) => id !== event.conversation.id),
    event.conversation,
  ].sort(descendingTimestamp);
  const runs = [
    ...snapshot.runs.filter(
      ({ conversationId }) => conversationId !== event.conversation.id,
    ),
    ...event.runs,
  ].sort(descendingTimestamp).slice(0, 200);
  return {
    ...snapshot,
    conversations,
    runs,
  };
}
