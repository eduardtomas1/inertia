import type { RuntimeSystemSuspendInterval } from "../../node/runtime-process-protocol";
import type { RuntimeMutationEvent } from "../../shared/contracts";
import type { RuntimeStore } from "../database";

export const PROVIDER_STOPPED_WHILE_ASLEEP_NOTE = "The provider stopped while the computer was asleep.";

export function recordSystemSuspendInterval(
  store: {
    systemSuspends: Pick<RuntimeStore["systemSuspends"], "record">;
  },
  interval: RuntimeSystemSuspendInterval,
  broadcast: (event: RuntimeMutationEvent) => void,
  broadcastSnapshot: () => void,
  turns?: {
    settleTurnsWhoseProviderExited(reason: string): unknown;
    restampProviderActivity(): unknown;
  },
  onResumed?: () => void,
): boolean {
  const recorded = recordSuspendAccounting(store, interval, broadcast, broadcastSnapshot);
  try {
    turns?.settleTurnsWhoseProviderExited(PROVIDER_STOPPED_WHILE_ASLEEP_NOTE);
  } catch (error) {
    console.error("Unable to check provider liveness after a system resume.", error);
  }
  try {
    turns?.restampProviderActivity();
  } catch (error) {
    console.error("Unable to restart the provider silence clock after a system resume.", error);
  }
  if (!recorded) return false;
  try {
    onResumed?.();
  } catch (error) {
    console.error("Unable to re-check providers after a system resume.", error);
  }
  return true;
}

function recordSuspendAccounting(
  store: {
    systemSuspends: Pick<RuntimeStore["systemSuspends"], "record">;
  },
  interval: RuntimeSystemSuspendInterval,
  broadcast: (event: RuntimeMutationEvent) => void,
  broadcastSnapshot: () => void,
): boolean {
  let conversationIds: string[];
  try {
    conversationIds = store.systemSuspends.record(interval);
  } catch (error) {
    // Suspend accounting is advisory. A malformed or unrecoverable interval
    // must not escape the synchronous utility-process command boundary and
    // turn a display-time correction into a runtime restart loop.
    console.error("Unable to record system suspend accounting.", error);
    return false;
  }
  if (conversationIds.length === 0) return true;
  for (const conversationId of conversationIds) {
    broadcast({
      type: "conversation.detail.invalidated",
      conversationId,
    });
  }
  broadcastSnapshot();
  return true;
}
