import type { AgentActivity } from "./contracts";

export const TURN_CHECKPOINT_UNAVAILABLE_TITLE = "No checkpoint for this turn";

export function isTurnCheckpointUnavailableActivity(
  activity: Pick<AgentActivity, "kind" | "title">,
): boolean {
  return activity.kind === "status"
    && activity.title === TURN_CHECKPOINT_UNAVAILABLE_TITLE;
}
