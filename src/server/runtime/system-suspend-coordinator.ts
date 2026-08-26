import type { RuntimeSystemSuspendInterval } from "../../node/runtime-process-protocol";
import type { RuntimeMutationEvent } from "../../shared/contracts";
import type { RuntimeStore } from "../database";

export function recordSystemSuspendInterval(
  store: {
    systemSuspends: Pick<RuntimeStore["systemSuspends"], "record">;
  },
  interval: RuntimeSystemSuspendInterval,
  broadcast: (event: RuntimeMutationEvent) => void,
  broadcastSnapshot: () => void,
): void {
  let conversationIds: string[];
  try {
    conversationIds = store.systemSuspends.record(interval);
  } catch (error) {
    // Suspend accounting is advisory. A malformed or unrecoverable interval
    // must not escape the synchronous utility-process command boundary and
    // turn a display-time correction into a runtime restart loop.
    console.error("Unable to record system suspend accounting.", error);
    return;
  }
  if (conversationIds.length === 0) return;
  for (const conversationId of conversationIds) {
    broadcast({
      type: "conversation.detail.invalidated",
      conversationId,
    });
  }
  broadcastSnapshot();
}
