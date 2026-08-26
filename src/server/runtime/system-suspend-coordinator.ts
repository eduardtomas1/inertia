import type { RuntimeSystemSuspendInterval } from "../../node/runtime-process-protocol";
import type { RuntimeMutationEvent } from "../../shared/contracts";
import type { RuntimeStore } from "../database";

export function recordSystemSuspendInterval(
  store: Pick<RuntimeStore, "systemSuspends">,
  interval: RuntimeSystemSuspendInterval,
  broadcast: (event: RuntimeMutationEvent) => void,
  broadcastSnapshot: () => void,
): void {
  const conversationIds = store.systemSuspends.record(interval);
  if (conversationIds.length === 0) return;
  for (const conversationId of conversationIds) {
    broadcast({
      type: "conversation.detail.invalidated",
      conversationId,
    });
  }
  broadcastSnapshot();
}
