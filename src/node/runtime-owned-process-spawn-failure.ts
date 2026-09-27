import type { ChildProcess } from "node:child_process";

import type {
  ActiveRuntimeOwnedProcessClaim,
  ActiveRuntimeOwnedProcessRegistry,
} from "./runtime-owned-process-active.js";

function releasePendingIntent(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
): boolean {
  try {
    return registry.journal.release(claim.ownershipId);
  } catch {
    return false;
  }
}

export function retireFailedRuntimeOwnedSpawn(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  child: ChildProcess,
): void {
  registry.claims.set(child, claim);
  child.once("error", () => {
    if (child.pid !== undefined || claim.released) return;
    claim.released = releasePendingIntent(registry, claim);
  });
}
