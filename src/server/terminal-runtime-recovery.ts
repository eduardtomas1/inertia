import { runtimeOwnedProcessOwnershipIsTainted } from "../node/runtime-owned-processes";

export function requestRecoveryFromTaintedOwnedProcess(
  recover: () => void,
  ownershipIsTainted: () => boolean = runtimeOwnedProcessOwnershipIsTainted,
): void {
  if (!ownershipIsTainted()) return;
  try { recover(); } catch {
    // The tainted runtime remains fail closed if the outer restart signal fails.
  }
}
