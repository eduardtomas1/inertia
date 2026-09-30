import type { ProviderId } from "../../shared/contracts";
import { CHAT_PROVIDER_CHANGE_MESSAGE, MIXED_PROVIDER_HISTORY_MESSAGE } from "../../shared/continuation-policy";
import type { PersistenceContext } from "./context";
import { ConversationProviderChangeError } from "./errors";

export const CONVERSATION_HAS_HISTORY_SQL = `(
  conversations.provider_session_id IS NOT NULL
  OR conversations.continuation_identity_json IS NOT NULL
  OR EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id)
  OR EXISTS (SELECT 1 FROM agent_turns WHERE agent_turns.conversation_id = conversations.id)
)`;

export const CONVERSATION_MIXED_PROVIDER_SQL = `EXISTS (
  SELECT 1 FROM agent_turns
  WHERE agent_turns.conversation_id = conversations.id
    AND agent_turns.provider_id <> conversations.provider_id
)`;

/** Check durable ownership before changing a selection or admitting a turn. */
export function assertConversationProvider(
  context: Pick<PersistenceContext, "database" | "requireConversation">,
  conversationId: string,
  providerId: ProviderId,
  allowUnusedDraftChange = false,
): void {
  const current = context.requireConversation(conversationId);
  const conflictingTurn = context.database.prepare(`
    SELECT 1 FROM agent_turns WHERE conversation_id = ? AND provider_id <> ? LIMIT 1
  `).get(conversationId, providerId);
  if (conflictingTurn) {
    throw new ConversationProviderChangeError(
      current.provider_id === providerId ? MIXED_PROVIDER_HISTORY_MESSAGE : CHAT_PROVIDER_CHANGE_MESSAGE,
    );
  }
  if (current.provider_id === providerId) return;
  const { has_history: hasHistory } = context.database.prepare(
    `SELECT ${CONVERSATION_HAS_HISTORY_SQL} AS has_history FROM conversations WHERE id = ?`,
  ).get(conversationId) as { has_history: number };
  if (!allowUnusedDraftChange || hasHistory === 1) {
    throw new ConversationProviderChangeError(CHAT_PROVIDER_CHANGE_MESSAGE);
  }
}
