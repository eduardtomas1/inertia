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
): RuntimeOwnedIntentRetirement {
  let attempts = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let retired = false;
  let scheduled = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    registry.pendingIntentRetirements.delete(retirement);
  };
  const attempt = (): boolean => {
    if (retired) return true;
    if (
      attempts >= MAX_INTENT_RETIREMENT_ATTEMPTS
      || Date.now() - lastAttemptAt < INTENT_RETIREMENT_MIN_SPACING_MS
    ) return false;
    attempts += 1;
    lastAttemptAt = Date.now();
    if (retirePendingIntent(registry, ownershipId)) {
      retired = true;
      cancel();
      onRetired();
      return true;
    }
    if (attempts >= MAX_INTENT_RETIREMENT_ATTEMPTS) cancel();
    return false;
  };
  const scheduleNext = (): void => {
    if (
      retired
      || timer
      || attempts >= MAX_INTENT_RETIREMENT_ATTEMPTS
      || scheduled >= INTENT_RETIREMENT_RETRY_DELAYS_MS.length
    ) return;
    timer = setTimeout(() => {
      timer = null;
      attempt();
      scheduleNext();
    }, INTENT_RETIREMENT_RETRY_DELAYS_MS[scheduled]);
    scheduled += 1;
    timer.unref();
  };
  const retirement: RuntimeOwnedIntentRetirement = {
    attempt: () => {
      const done = attempt();
      if (!done) scheduleNext();
      return done;
    },
    cancel,
  };
  registry.pendingIntentRetirements.add(retirement);
  return retirement;
}

export function retireUnspawnedRuntimeOwnedIntent(
  registry: ActiveRuntimeOwnedProcessRegistry,
  ownershipId: string,
): void {
  startIntentRetirement(registry, ownershipId, () => undefined).attempt();
}

export function retireFailedRuntimeOwnedSpawn(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  child: ChildProcess,
): void {
  registry.claims.set(child, claim);
  let retirement: RuntimeOwnedIntentRetirement | null = null;
  child.once("error", () => {
    if (child.pid !== undefined || retirement) return;
    retirement = startIntentRetirement(registry, claim.ownershipId, () => {
      claim.released = true;
    });
    claim.retireIntent = retirement.attempt;
    retirement.attempt();
  });
  child.once("close", () => {
    retirement?.attempt();
  });
}
