import type { ProviderId } from "../../shared/contracts";
import type { PersistenceContext } from "./context";
import { ConversationProviderChangeError } from "./errors";

export const CONVERSATION_HAS_HISTORY_SQL = `(
  conversations.provider_session_id IS NOT NULL
  OR conversations.continuation_identity_json IS NOT NULL
  OR EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id)
  OR EXISTS (SELECT 1 FROM agent_turns WHERE agent_turns.conversation_id = conversations.id)
)`;

export const CONVERSATION_PROVIDER_MISMATCH_MESSAGE =
  "The model route does not match this chat's provider.";

/**
 * Checks that a turn or provider contact uses the chat's current provider.
 * Changing the provider itself is a conversation update; earlier turns on
 * another provider are a handoff, not a conflict.
 */
export function assertConversationProvider(
  context: Pick<PersistenceContext, "requireConversation">,
  conversationId: string,
  providerId: ProviderId,
): void {
  const current = context.requireConversation(conversationId);
  if (current.provider_id !== providerId) {
    throw new ConversationProviderChangeError(CONVERSATION_PROVIDER_MISMATCH_MESSAGE);
  }
}
