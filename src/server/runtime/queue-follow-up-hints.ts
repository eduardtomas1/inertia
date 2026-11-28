import type { QueueEnqueuePlacement } from "../../shared/orchestration-queue";

/**
 * Ephemeral in-process call-through hints passed synchronously from
 * `message-send-command.ts` / `message-follow-up-command.ts` into
 * `queued-message-runtime.ts`'s `undeliveredFollowUps` callbacks without
 * altering the unowned `TurnInteractionCommandDependencies` interface.
 * Every hint is consumed and deleted synchronously inside the target call.
 */
export interface FollowUpQueueHint {
  placement?: QueueEnqueuePlacement;
  steerFollowUpOfRunId?: string;
  steerWhenReadyRunId?: string;
  queueHeld?: boolean;
  releaseHoldsR1?: boolean;
}

const hintsByItemId = new Map<string, FollowUpQueueHint>();

export function setFollowUpQueueHint(itemId: string, hint: FollowUpQueueHint): void {
  hintsByItemId.set(itemId, hint);
}

export function takeFollowUpQueueHint(itemId: string): FollowUpQueueHint | undefined {
  const hint = hintsByItemId.get(itemId);
  if (hint !== undefined) hintsByItemId.delete(itemId);
  return hint;
}
