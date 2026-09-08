import type Database from "better-sqlite3";
import type { AgentTurn, Conversation, WorkspaceRun } from "../../shared/contracts";
import type { AgentTurnSettlementResult, AgentTurnSettlementUpdate } from "./types";

interface SettlementProjectionStore {
  latestAgentTurnForConversation(conversationId: string): AgentTurn | null;
  updateConversation(conversationId: string, update: Partial<Pick<Conversation,
    "status" | "attentionKind" | "providerSessionId" | "continuationIdentity">>): Conversation;
  workspaceRun(runId: string): WorkspaceRun;
  updateWorkspaceRun(runId: string, update: Partial<Pick<WorkspaceRun, "status" | "detail">>): WorkspaceRun;
}

/** Stored lifecycle projections commit with their terminal row, or not at all. */
export function settleProjectedAgentTurn(
  database: Database.Database,
  store: SettlementProjectionStore,
  projection: AgentTurnSettlementUpdate["projection"],
  settle: () => AgentTurnSettlementResult,
): AgentTurnSettlementResult {
  if (!projection) return settle();
  return database.transaction(() => {
    const result = settle();
    if (!result.settled) return result;
    const { turn } = result;
    // An old terminal edge never rewrites a newer conversation's live state.
    if (store.latestAgentTurnForConversation(turn.conversationId)?.id === turn.id) {
      store.updateConversation(turn.conversationId, {
        status: turn.status === "completed" ? "completed" : turn.status === "cancelled" ? "idle" : "failed",
        attentionKind: null,
        ...(turn.providerSessionAfter ? {
          providerSessionId: turn.providerSessionAfter,
          continuationIdentity: turn.continuationIdentity,
        } : {}),
      });
    }
    if (projection.workspaceRunCreated) {
      const run = store.workspaceRun(turn.runId);
      if (run.kind !== "agent" || run.conversationId !== turn.conversationId) {
        throw new Error("The terminal workspace projection does not own this turn.");
      }
      store.updateWorkspaceRun(turn.runId, {
        status: turn.status === "completed" ? "succeeded" : turn.status === "cancelled" ? "cancelled" : "failed",
        detail: projection.detail,
      });
    }
    return result;
  })();
}
