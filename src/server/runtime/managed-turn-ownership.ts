import type { AgentTurn } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import { RuntimeRequestError } from "../runtime-errors";
import { requestAgentStop, SUPERSEDED_STOP_CODE } from "./commands/agent-stop-command";
import type { TurnController } from "./turns/turn-controller";
import { sameTurnOwner, type TurnOwnerIdentity } from "./turns/turn-ownership";
import { liveProviderRunOwnership } from "./turns/turn-checkout-activity";

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

const MANAGED_TURN_GONE_MESSAGE = "The approved turn is no longer active. A newer turn was not stopped.";

export async function stopOwnedManagedTurn(store: RuntimeStore, turns: TurnController, conversationId: string, owner: TurnOwnerIdentity): Promise<void> {
  if (!turns.cancelOwned(conversationId, owner)) throw new Error(MANAGED_TURN_GONE_MESSAGE);
  await confirmManagedStop(store, turns, conversationId, owner);
}

/**
 * An agent's approved Stop of a chat it manages, through the same receipted
 * Stop command as the user's, recorded with cause `agent`. The approval named
 * one exact turn and run, so a newer one is refused as superseded and never
 * stopped. Answers whether the approved turn was stopped or had already ended.
 */
export async function stopManagedTurnForAgent(store: RuntimeStore, turns: TurnController, conversationId: string,
  owner: TurnOwnerIdentity, operationId: string): Promise<"stopped" | "ended"> {
  const commandId = `agent-stop:${operationId}`;
  const command = { type: "agent.stop", requestId: commandId,
    payload: { conversationId, expectedTurnId: owner.turnId, expectedRunId: owner.runId } };
  let disposition: Awaited<ReturnType<typeof requestAgentStop>>;
  try {
    disposition = await requestAgentStop({ store, turns }, { conversationId, expectedTurnId: owner.turnId,
      expectedRunId: owner.runId, cause: "agent", rejection: null, source: { actorId: "agent", commandId, command } });
  } catch (error) {
    if (error instanceof RuntimeRequestError && error.code === SUPERSEDED_STOP_CODE) throw new Error(MANAGED_TURN_GONE_MESSAGE);
    throw error;
  }
  if (disposition === "isolated") throw new Error(MANAGED_TURN_GONE_MESSAGE);
  await confirmManagedStop(store, turns, conversationId, owner);
  // Nothing was active, or the recorded run ended before the cancel reached it.
  return disposition === "idle" || disposition === "releasing" || disposition === "ended" ? "ended" : "stopped";
}

async function confirmManagedStop(store: RuntimeStore, turns: TurnController, conversationId: string,
  owner: TurnOwnerIdentity): Promise<void> {
  await turns.waitForProviderCleanup([conversationId]);
  const ownsProvider = liveProviderRunOwnership(store, store.providerRunOwnership.forConversation(conversationId))
    .some((run) => sameTurnOwner(run, owner));
  if (ownsProvider || sameTurnOwner(turns.activeIdentity(conversationId), owner)) {
    throw new Error("Stop was requested, but exact provider cleanup was not confirmed.");
  }
}
