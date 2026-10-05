import { TURN_CHECKPOINT_UNAVAILABLE_TITLE } from "../../../shared/turn-checkpoint";
import { CheckpointError } from "../../checkpoints";
import type { RuntimeStore } from "../../database";
import { GitError } from "../../git/types";
import type { ActiveTurn, TurnControllerHooks } from "./turn-controller-types";

export function isExpectedCheckpointAbsence(error: unknown): boolean {
  return (error instanceof CheckpointError && error.message === "not-repository")
    || (error instanceof GitError && error.code === "not-repository");
}

export function checkpointFailureReason(error: unknown): string {
  if (error instanceof CheckpointError || error instanceof GitError) {
    return error.message.slice(0, 240);
  }
  return "Git could not create the checkpoint.";
}

export function recordTurnCheckpointUnavailable(
  store: Pick<RuntimeStore, "addActivity">,
  hooks: Pick<TurnControllerHooks, "broadcast">,
  active: Pick<ActiveTurn, "turn" | "checkpointFailure">,
): void {
  if (!active.checkpointFailure) return;
  const activity = store.addActivity({
    conversationId: active.turn.conversationId,
    runId: active.turn.runId,
    turnId: active.turn.id,
    kind: "status",
    title: TURN_CHECKPOINT_UNAVAILABLE_TITLE,
    detail: active.checkpointFailure,
    status: "completed",
  });
  hooks.broadcast({ type: "agent.activity", activity });
}
