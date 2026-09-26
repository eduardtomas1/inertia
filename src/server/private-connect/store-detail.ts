import type { Conversation, ConversationDetail } from "../../shared/contracts";
import { PRIVATE_CONNECT_RUNTIME_LIMITS } from "../../shared/private-connect/runtime-contract";
import { PRIVATE_CONNECT_INSPECTION_CHARACTERS } from "../../shared/private-connect/sanitizer";
import type { RuntimeStore } from "../database";

export function privateConnectStoreReads(store: Pick<RuntimeStore, "conversationShell" | "recentConversationDetail">): {
  conversation(conversationId: string): Conversation | null;
  detail(conversationId: string): ConversationDetail | null;
} {
  return {
    conversation: (conversationId) => store.conversationShell(conversationId),
    detail: (conversationId) => store.recentConversationDetail(conversationId, {
      messages: PRIVATE_CONNECT_RUNTIME_LIMITS.transcriptMessages,
      activities: PRIVATE_CONNECT_RUNTIME_LIMITS.activities,
      subagents: PRIVATE_CONNECT_RUNTIME_LIMITS.subagents,
      contentCharacters: PRIVATE_CONNECT_INSPECTION_CHARACTERS,
    }),
  };
}
