import type { AppSnapshot, ConversationShell } from "@shared/contracts";

import { requestComposerPrefill } from "./composerPrefill";
import { persistComposerDraft } from "./composerDraftPersistence";

/** Text waiting for the chat a creation request is about to activate. */
export interface PendingNewChatDraft {
  projectId: string;
  knownConversationIds: ReadonlySet<string>;
  text: string;
}

type ConversationIdentities = readonly Pick<ConversationShell, "id" | "projectId">[];

export function pendingNewChatDraft(
  snapshot: { conversations: ConversationIdentities },
  projectId: string,
  text: string,
): PendingNewChatDraft {
  return {
    projectId,
    knownConversationIds: new Set(snapshot.conversations.map(({ id }) => id)),
    text,
  };
}

/**
 * The chat a pending draft belongs to: the active chat once it is one that did
 * not exist when the request was made and belongs to the requested project.
 */
export function newChatDraftTarget(
  snapshot: Pick<AppSnapshot, "activeConversationId"> & { conversations: ConversationIdentities } | null,
  pending: PendingNewChatDraft,
): string | null {
  const activeConversationId = snapshot?.activeConversationId;
  if (!activeConversationId || pending.knownConversationIds.has(activeConversationId)) return null;
  return snapshot.conversations.some(({ id, projectId }) => id === activeConversationId && projectId === pending.projectId)
    ? activeConversationId
    : null;
}

/**
 * Puts the text in the new chat's message box: the open box receives it now,
 * otherwise the box reads it as the chat's saved draft when it opens.
 */
export function deliverNewChatDraft(conversationId: string, text: string): void {
  if (!requestComposerPrefill({ conversationId, text })) persistComposerDraft(conversationId, text);
}
