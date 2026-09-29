import type {
  ActiveRuntimeOwnedProcessClaim,
  ActiveRuntimeOwnedProcessRegistry,
} from "./runtime-owned-process-active.js";
import { exactProcessGroupTerminal } from "./runtime-owned-process-posix.js";

export const PROCESS_GROUP_EXIT_WAIT_MS = 1_000;
const PROCESS_GROUP_EXIT_POLL_MS = 10;

function exactUnownedClaim(
  registry: ActiveRuntimeOwnedProcessRegistry,
  ownershipId: string,
): boolean {
  const records = registry.journal.records(registry.runtimeGenerationId);
  if (!records) return false;
  const matching = records.filter((record) =>
    record.ownershipId === ownershipId);
  return matching.length === 1
    && (matching[0]?.state === "pending" || matching[0]?.state === "preauth")
    && matching[0].runtimeGenerationId === registry.runtimeGenerationId
    && matching[0].systemBootId === registry.systemBootId;
}

export function releaseFailedPidClaimIfStopped(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  pid: number,
  processCanExecute: (pid: number) => boolean | null,
): Promise<boolean> {
  if (claim.releaseConfirmation) return claim.releaseConfirmation;
  let settleConfirmation!: (confirmed: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => {
    settleConfirmation = resolve;
  });
  claim.releaseConfirmation = confirmation;
  claim.settleReleaseConfirmation = settleConfirmation;
  registry.pendingReleaseConfirmations.add(confirmation);
  void confirmation.then(() => {
    registry.pendingReleaseConfirmations.delete(confirmation);
    claim.settleReleaseConfirmation = null;
  });
  const deadlineAt = Date.now() + PROCESS_GROUP_EXIT_WAIT_MS;
  const poll = (): void => {
    if (
      !registry.active
      || claim.released
      || !exactUnownedClaim(registry, claim.ownershipId)
    ) {
      settleConfirmation(claim.released);
      return;
    }
    const executable = processCanExecute(pid);
    if (
      executable === false
      && exactProcessGroupTerminal(pid, registry.platform) === true
    ) {
      try {
        if (!registry.journal.release(claim.ownershipId)) {
          settleConfirmation(false);
          return;
        }
        claim.stopLinuxMonitor?.();
        claim.released = true;
        claim.settleLinuxMonitorConfirmation?.(true);
        settleConfirmation(true);
      } catch {
        settleConfirmation(false);
      }
      return;
    }
    const remainingMs = Math.trunc(deadlineAt - Date.now());
    if (remainingMs <= 0) {
      settleConfirmation(false);
      return;
    }
    const timer = setTimeout(
      poll,
      Math.max(1, Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs)),
    );
    timer.unref();
  };
  poll();
  return confirmation;
}

export function releaseIfGroupExited(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  pid: number,
): Promise<boolean> {
  if (claim.releaseConfirmation) return claim.releaseConfirmation;
  if (claim.released) return Promise.resolve(true);
  let settleConfirmation!: (confirmed: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => {
    settleConfirmation = resolve;
  });
  claim.groupExitReleaseAttempts += 1;
  claim.releaseConfirmation = confirmation;
  claim.settleReleaseConfirmation = settleConfirmation;
  registry.pendingReleaseConfirmations.add(confirmation);
  void confirmation.then((confirmed) => {
    registry.pendingReleaseConfirmations.delete(confirmation);
    claim.settleReleaseConfirmation = null;
    if (
      !confirmed
      && registry.active
      && !claim.released
      && claim.releaseConfirmation === confirmation
    ) {
      claim.releaseConfirmation = null;
      // A guardian can become reapable immediately after the first bounded
      // absence check expires, especially under host contention. Retry once
      // within the worker's shutdown budget; a second failure remains durable
      // and fails closed.
      if (claim.groupExitReleaseAttempts < 2) {
        void releaseIfGroupExited(registry, claim, pid);
      }
    }
  });
  const deadlineAt = Date.now() + PROCESS_GROUP_EXIT_WAIT_MS;
  const poll = async (): Promise<void> => {
    if (!registry.active) {
      settleConfirmation(false);
      return;
    }
    if (claim.released) {
      settleConfirmation(true);
      return;
    }
    try {
      const containmentAbsent = registry.platform === "darwin"
        ? await registry.readDarwinSessionEmptyAsync(
            pid,
            registry.admissionController.signal,
          ) === true
        : exactProcessGroupTerminal(pid, registry.platform) === true;
      if (containmentAbsent) {
        try {
          if (!releaseActiveClaim(registry, claim)) settleConfirmation(false);
        } catch {
          // A removed test/runtime root cannot authorize further mutation.
          settleConfirmation(false);
        }
        return;
      }
    } catch {
      // An unreadable containment boundary remains durably owned.
    }
    const remainingMs = Math.trunc(deadlineAt - Date.now());
    if (remainingMs <= 0) {
      settleConfirmation(false);
      return;
    }
    const timer = setTimeout(
      () => { void poll(); },
      Math.max(1, Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs)),
    );
    timer.unref();
  };
  void poll();
  return confirmation;
}

export function releaseActiveClaim(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
): boolean {
  if (claim.released) return true;
  if (!(registry.platform === "linux"
    ? registry.journal.releaseRetiring(claim.ownershipId)
    : registry.journal.release(claim.ownershipId))) return false;
  claim.stopLinuxMonitor?.();
  claim.released = true;
  claim.settleLinuxMonitorConfirmation?.(true);
  claim.settleReleaseConfirmation?.(true);
  return true;
}
