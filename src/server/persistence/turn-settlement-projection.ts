import type Database from "better-sqlite3";
import type { AgentTurn, Conversation, WorkspaceRun } from "../../shared/contracts";
import { continuationIdentityForSelection } from "../../shared/model-routing";
import type { TurnFailureKind } from "../../shared/turn-lifecycle";
import type { AgentTurnSettlementResult, AgentTurnSettlementUpdate } from "./types";

interface SettlementProjectionStore {
  conversation(conversationId: string): Conversation;
  latestAgentTurnForConversation(conversationId: string): AgentTurn | null;
  updateConversation(conversationId: string, update: Partial<Pick<Conversation,
    "status" | "attentionKind" | "providerSessionId" | "continuationIdentity">>): Conversation;
  workspaceRun(runId: string): WorkspaceRun;
  updateWorkspaceRun(runId: string, update: Partial<Pick<WorkspaceRun, "status" | "detail">>): WorkspaceRun;
  limitResets: {
    markUsageLimited(turnId: string): void;
    markFailureKind(turnId: string, failureKind: TurnFailureKind): void;
  };
}

function conversationMatchesTurnContinuation(
  conversation: Conversation,
  turn: Pick<AgentTurn, "providerId" | "continuationIdentity">,
): boolean {
  if (conversation.providerId !== turn.providerId) return false;
  const target = turn.continuationIdentity;
  const selectionIdentity = continuationIdentityForSelection(
    conversation.modelSelection,
    conversation.continuationIdentity?.endpointIdentity ?? null,
    target.modelIdentity !== null,
  );
  if (
    selectionIdentity.harnessId !== target.harnessId
    || selectionIdentity.backendProfileId !== target.backendProfileId
    || selectionIdentity.backendConfigurationRevision !== target.backendConfigurationRevision
    || (selectionIdentity.performanceModeIdentity ?? null) !== (target.performanceModeIdentity ?? null)
  ) {
    return false;
  }
  if (target.modelIdentity !== null && conversation.modelSelection.modelId !== target.modelIdentity) {
    return false;
  }
  const persisted = conversation.continuationIdentity;
  if (persisted !== null) {
    if (
      persisted.harnessId !== target.harnessId
      || persisted.backendProfileId !== target.backendProfileId
      || persisted.backendConfigurationRevision !== target.backendConfigurationRevision
      || (persisted.endpointIdentity ?? null) !== (target.endpointIdentity ?? null)
      || (persisted.modelIdentity ?? null) !== (target.modelIdentity ?? null)
      || (persisted.performanceModeIdentity ?? null) !== (target.performanceModeIdentity ?? null)
    ) {
      return false;
    }
  }
  return true;
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
    // An old terminal edge never rewrites a newer conversation's live state,
    // and a settling turn never overwrites a provider/profile selected mid-turn.
    if (store.latestAgentTurnForConversation(turn.conversationId)?.id === turn.id) {
      const currentConversation = store.conversation(turn.conversationId);
      const persistSession = Boolean(turn.providerSessionAfter)
        && conversationMatchesTurnContinuation(currentConversation, turn);
      store.updateConversation(turn.conversationId, {
        status: turn.status === "completed" ? "completed" : turn.status === "cancelled" ? "idle" : "failed",
        attentionKind: null,
        ...(persistSession && turn.providerSessionAfter ? {
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
    if (projection.usageLimited && turn.status === "failed") store.limitResets.markUsageLimited(turn.id);
    if (projection.failureKind && turn.status === "failed") {
      store.limitResets.markFailureKind(turn.id, projection.failureKind);
    }
    return result;
  })();
}
