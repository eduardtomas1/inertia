import type { ConversationDetail } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import { HISTORY_TOO_LARGE_MESSAGE } from "../persistence/conversation-history";

/** Mobile projects a recent window; it never needs the full saved transcript. */
export function privateConnectStoreDetail(
  store: Pick<RuntimeStore, "conversationHistory" | "conversation">,
  conversationId: string,
): ConversationDetail | null {
  try {
    return store.conversationHistory(conversationId);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== HISTORY_TOO_LARGE_MESSAGE) throw error;
    // One oversized turn must not prevent authenticated stop/input actions.
    // The gateway still checks project, conversation grants and current shell.
    return {
      conversation: store.conversation(conversationId), agentTurns: [], turnGitArtifacts: [],
      messages: [], activities: [], subagents: [], reasonings: [], usage: [], plans: [],
      goals: [], checkpoints: [], reviewSummaries: [], reviewStates: [], reviewNotes: [],
      contextPackets: [],
    };
  }
}
