import type {
  ActiveRuntimeOwnedProcessClaim,
  ActiveRuntimeOwnedProcessRegistry,
} from "./runtime-owned-process-active.js";
import type { RuntimeOwnedProcessDiagnostic } from "./runtime-owned-process-diagnostic.js";
import { reportRuntimeOwnedProcessFault } from "./runtime-owned-process-linux-policy.js";
import { releaseActiveClaim } from "./runtime-owned-process-release.js";

export const DARWIN_QUARANTINE_PROOF_MS = 3_000;
const DARWIN_QUARANTINE_POLL_MS = 20;

function waitFor(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    timer.unref();
  });
}

async function proveClosedDarwinGuardianGone(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  guardianPid: number,
  isActive: () => boolean,
): Promise<boolean> {
  const identity = claim.darwinIdentity;
  if (!identity || identity.pid !== guardianPid) return false;
  const deadlineAt = Date.now() + DARWIN_QUARANTINE_PROOF_MS;
  const signal = registry.admissionController.signal;
  while (isActive() && !claim.released) {
    const sessionEmpty = await registry.readDarwinSessionEmptyAsync(guardianPid, signal)
      .catch(() => null);
    const remainingMs = deadlineAt - Date.now();
    if (sessionEmpty === true && remainingMs > 0) {
      const census = await registry.readDarwinEscapeesAsync(identity, {
        reap: true,
        timeoutMs: remainingMs,
        abortSignal: signal,
      }).catch(() => ({ absent: null, remaining: [] }));
      if (census.absent === true) {
        if (!isActive()) return false;
        try { return releaseActiveClaim(registry, claim); } catch { return false; }
      }
      if (census.absent === false) return false;
    }
    if (deadlineAt - Date.now() <= DARWIN_QUARANTINE_POLL_MS) return claim.released;
    await waitFor(DARWIN_QUARANTINE_POLL_MS);
  }
  return claim.released;
}

export function quarantineClosedDarwinGuardian(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  guardianPid: number,
  diagnostic: RuntimeOwnedProcessDiagnostic,
  isActive: () => boolean,
): void {
  if (claim.released || claim.darwinQuarantined) return;
  claim.darwinQuarantined = true;
  const start = (): void => {
    if (claim.released || !isActive()) return;
    let settleConfirmation!: (confirmed: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      settleConfirmation = resolve;
    });
    claim.releaseConfirmation = confirmation;
    claim.settleReleaseConfirmation = settleConfirmation;
    registry.pendingReleaseConfirmations.add(confirmation);
    void confirmation.then((confirmed) => {
      registry.pendingReleaseConfirmations.delete(confirmation);
      if (claim.settleReleaseConfirmation === settleConfirmation) {
        claim.settleReleaseConfirmation = null;
      }
      if (!confirmed && !claim.released && claim.releaseConfirmation === confirmation) {
        claim.releaseConfirmation = null;
      }
    });
    void proveClosedDarwinGuardianGone(registry, claim, guardianPid, isActive)
      .catch(() => false)
      .then((confirmed) => {
        if (!confirmed && !claim.released && isActive()) {
          reportRuntimeOwnedProcessFault(registry, { kind: "quarantined", diagnostic });
        }
        settleConfirmation(confirmed || claim.released);
      });
  };
  const admission = claim.admission;
  if (admission) {
    void admission.then((admitted) => { if (admitted) start(); });
  } else if (claim.admissionSucceeded) start();
}
