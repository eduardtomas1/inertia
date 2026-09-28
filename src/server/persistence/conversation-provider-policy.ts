import type { ProviderId } from "../../shared/contracts";
import { CHAT_PROVIDER_CHANGE_MESSAGE } from "../../shared/continuation-policy";
import type { PersistenceContext } from "./context";

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
  if (conflictingTurn) throw new Error(CHAT_PROVIDER_CHANGE_MESSAGE);
  if (current.provider_id === providerId) return;
  const hasHistory = current.provider_session_id !== null
    || current.continuation_identity_json !== null
    || context.database.prepare(
      "SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1",
    ).get(conversationId) !== undefined;
  if (!allowUnusedDraftChange || hasHistory) {
    throw new Error(CHAT_PROVIDER_CHANGE_MESSAGE);
  }
}
