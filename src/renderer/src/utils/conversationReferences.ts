import type { AppSnapshot, ArchivedConversationRef, Conversation } from "@shared/contracts";

export type ConversationReference = Pick<Conversation, "id" | "projectId" | "title" | "providerId" | "archivedAt">;

const EMPTY_REFS: readonly ArchivedConversationRef[] = [];

export function conversationReferences(
  snapshot: Pick<AppSnapshot, "conversations" | "archivedConversationRefs"> | null | undefined,
): ConversationReference[] {
  const conversations = snapshot?.conversations ?? [];
  const refs = snapshot?.archivedConversationRefs ?? EMPTY_REFS;
  if (refs.length === 0) return conversations;
  const live = new Set(conversations.map(({ id }) => id));
  return [...conversations, ...refs.filter(({ id }) => !live.has(id))];
}

export function archivedConversationRefsById(
  snapshot: Pick<AppSnapshot, "archivedConversationRefs"> | null | undefined,
): ReadonlyMap<string, ArchivedConversationRef> {
  return new Map((snapshot?.archivedConversationRefs ?? EMPTY_REFS).map((ref) => [ref.id, ref]));
}
