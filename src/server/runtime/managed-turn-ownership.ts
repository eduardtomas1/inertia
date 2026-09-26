import type { AgentTurn } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type { TurnController } from "./turns/turn-controller";
import { sameTurnOwner, type TurnOwnerIdentity } from "./turns/turn-ownership";

export function recordManagedTurn(store: RuntimeStore, operationId: string, turn: { id: string; runId: string }, now: string): void {
  store.agentThreadManagement.transition(operationId, ["dispatching"], "dispatching",
    { targetTurnId: turn.id, targetRunId: turn.runId }, now);
}

export function recordQueuedManagedTurn(store: RuntimeStore, turns: TurnController, operationId: string, turn: AgentTurn, now: string): void {
  try { recordManagedTurn(store, operationId, turn, now); }
  catch (error) {
    turns.failBeforeStart(turn.conversationId, "The managed turn's ownership could not be saved.");
    throw error;
  }
}

export async function stopOwnedManagedTurn(store: RuntimeStore, turns: TurnController, conversationId: string, owner: TurnOwnerIdentity): Promise<void> {
  if (!turns.cancelOwned(conversationId, owner)) {
    throw new Error("The approved turn is no longer active. A newer turn was not stopped.");
  }
  await turns.waitForProviderCleanup([conversationId]);
  const ownsProvider = store.providerRunOwnership.forConversation(conversationId)
    .some((run) => sameTurnOwner(run, owner));
  if (ownsProvider || sameTurnOwner(turns.activeIdentity(conversationId), owner)) {
    throw new Error("Stop was requested, but exact provider cleanup was not confirmed.");
  }
}
