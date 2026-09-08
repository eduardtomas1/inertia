import type { ActiveRuntimeOwnedProcessClaim, ActiveRuntimeOwnedProcessRegistry } from "./runtime-owned-process-active.js";
import type { LinuxProcessIdentity } from "./runtime-owned-process-journal.js";
import { linuxGuardianTerminalAuthority, signalLinuxGuardianExactAsync } from "./runtime-owned-process-linux.js";

export async function stopExactLinuxGuardian(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  identity: LinuxProcessIdentity,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent()) return false;
  // Terminal authority is monotonic: the hardened, child-free native guardian
  // cannot execute a payload again. Its monitor may retire/release it before a
  // pending JS admission callback asks for stop. A rejected signal alone says
  // nothing about cleanup; only this exact receipt can settle that race.
  const terminal = (): boolean => isCurrent() && (
    claim.released || claim.linuxTerminalObserved === true
    || linuxGuardianTerminalAuthority(identity, registry.darwinGuardianPath!, "/proc", "inertia-exdone")
    || linuxGuardianTerminalAuthority(identity, registry.darwinGuardianPath!)
  );
  if (terminal()) return true;
  const signalled = await signalLinuxGuardianExactAsync(
    identity, registry.darwinGuardianPath!, "stop", registry.admissionController.signal,
  );
  return isCurrent() && (signalled || terminal());
}
