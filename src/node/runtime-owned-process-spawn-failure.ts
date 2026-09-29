import type { ChildProcess } from "node:child_process";

import type {
  ActiveRuntimeOwnedProcessClaim,
  ActiveRuntimeOwnedProcessRegistry,
  RuntimeOwnedIntentRetirement,
} from "./runtime-owned-process-active.js";

export const MAX_INTENT_RETIREMENT_ATTEMPTS = 6;
export const INTENT_RETIREMENT_RETRY_DELAYS_MS = [100, 400, 1_600] as const;
export const INTENT_RETIREMENT_MIN_SPACING_MS = 50;

function retirePendingIntent(
  registry: ActiveRuntimeOwnedProcessRegistry,
  ownershipId: string,
): boolean {
  try {
    if (registry.journal.release(ownershipId)) return true;
  } catch {
    return false;
  }
  try {
    return registry.journal.claimPresent(ownershipId) === false;
  } catch {
    return false;
  }
}

function startIntentRetirement(
  registry: ActiveRuntimeOwnedProcessRegistry,
  ownershipId: string,
  onRetired: () => void,
  failureProven: () => boolean,
): RuntimeOwnedIntentRetirement {
  let attempts = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let scheduled = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let outcome: boolean | null = null;
  let settle!: (retired: boolean) => void;
  const settled = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const conclude = (retired: boolean): void => {
    if (outcome !== null) return;
    outcome = retired;
    if (timer) clearTimeout(timer);
    timer = null;
    registry.pendingIntentRetirements.delete(retirement);
    if (retired) onRetired();
    settle(retired);
  };
  const tryOnce = (): void => {
    attempts += 1;
    lastAttemptAt = Date.now();
    if (retirePendingIntent(registry, ownershipId)) conclude(true);
    else if (attempts >= MAX_INTENT_RETIREMENT_ATTEMPTS) conclude(false);
  };
  const scheduleNext = (): void => {
    if (outcome !== null || timer) return;
    if (scheduled >= INTENT_RETIREMENT_RETRY_DELAYS_MS.length) {
      conclude(false);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (outcome !== null || !registry.active) return;
      tryOnce();
      scheduleNext();
    }, INTENT_RETIREMENT_RETRY_DELAYS_MS[scheduled]);
    scheduled += 1;
    timer.unref();
  };
  const retirement: RuntimeOwnedIntentRetirement = {
    attempt: () => {
      if (outcome !== null) return outcome;
      if (!failureProven()) return false;
      if (
        registry.active
        && Date.now() - lastAttemptAt >= INTENT_RETIREMENT_MIN_SPACING_MS
      ) tryOnce();
      scheduleNext();
      return outcome === true;
    },
    settled,
    finalize: () => {
      if (
        outcome === null
        && failureProven()
        && attempts < MAX_INTENT_RETIREMENT_ATTEMPTS
      ) tryOnce();
      conclude(outcome === true);
    },
  };
  registry.pendingIntentRetirements.add(retirement);
  return retirement;
}

export function retireUnspawnedRuntimeOwnedIntent(
  registry: ActiveRuntimeOwnedProcessRegistry,
  ownershipId: string,
): void {
  startIntentRetirement(registry, ownershipId, () => undefined, () => true).attempt();
}

export function retireFailedRuntimeOwnedSpawn(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  child: ChildProcess,
): void {
  registry.claims.set(child, claim);
  let spawnFailed = false;
  const retirement = startIntentRetirement(
    registry,
    claim.ownershipId,
    () => { claim.released = true; },
    () => spawnFailed,
  );
  claim.intentRetirement = retirement;
  child.once("error", () => {
    if (child.pid !== undefined) return;
    spawnFailed = true;
    retirement.attempt();
  });
  child.once("close", () => {
    retirement.attempt();
  });
}
