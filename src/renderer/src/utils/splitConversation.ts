import type { AppSnapshot, Conversation } from "@shared/contracts";

export const SPLIT_CONVERSATION_STORAGE_KEY =
  "inertia:layout:split-conversation:v1";

export function readSplitConversationId(
  storage: Pick<Storage, "getItem">,
): string | null {
  const value = storage.getItem(SPLIT_CONVERSATION_STORAGE_KEY)?.trim();
  return value ? value : null;
}

export function persistSplitConversationId(
  storage: Pick<Storage, "removeItem" | "setItem">,
  conversationId: string | null,
): void {
  if (conversationId) {
    storage.setItem(SPLIT_CONVERSATION_STORAGE_KEY, conversationId);
  } else {
    storage.removeItem(SPLIT_CONVERSATION_STORAGE_KEY);
  }
}

export function resolvedSplitConversation(
  snapshot: AppSnapshot | null,
  requestedId: string | null,
): Conversation | null {
  if (!snapshot || !requestedId || !snapshot.activeConversationId) return null;
  const primary = snapshot.conversations.find(
    ({ id }) => id === snapshot.activeConversationId,
  );
  const secondary = snapshot.conversations.find(({ id }) => id === requestedId);
  if (
    !primary
    || !secondary
    || secondary.id === primary.id
    || secondary.archivedAt !== null
  ) {
    return null;
  }
  return secondary;
}

export function splitConversationAfterPrimaryChange(
  previousPrimary: Conversation | null,
  nextPrimary: Conversation,
  currentSecondary: Conversation | null,
): string | null {
  if (!previousPrimary || !currentSecondary) return null;
  if (nextPrimary.id === currentSecondary.id) return previousPrimary.id;
  return currentSecondary.id;
}
