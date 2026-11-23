import type { AgentActivity } from "./contracts";

export const TURN_CHECKPOINT_UNAVAILABLE_TITLE = "No checkpoint for this turn";
export const CHECKPOINT_EXPIRED_LABEL = "No longer available";
export const CHECKPOINT_EXPIRED_DESCRIPTION = "This checkpoint was pruned and is no longer available to restore.";
export const TURN_COMPARE_EXPIRED_DESCRIPTION = "This turn snapshot was pruned and is no longer available to compare.";

export function isTurnCheckpointUnavailableActivity(
  activity: Pick<AgentActivity, "kind" | "title">,
): boolean {
  return activity.kind === "status"
    && activity.title === TURN_CHECKPOINT_UNAVAILABLE_TITLE;
}
