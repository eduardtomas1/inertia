import type { ProviderRunInput } from "./contracts";
import type { ProviderInstallationLeaseCoordinator } from "./installation-lease";
import type { ProviderManagerInstallationAuthority } from "./provider-manager-installation";
import type { ProviderInstallationRecovery } from "./provider-installation-recovery";
import type { CursorSdkController } from "./cursor-sdk-controller";

export function acquireProviderRunInstallation(input: ProviderRunInput, executable: string, owners: {
  leases: ProviderInstallationLeaseCoordinator | undefined;
  authority: ProviderManagerInstallationAuthority;
  recovery: ProviderInstallationRecovery;
  cursorSdk: CursorSdkController;
}) {
  if (input.harnessId === "cursor-sdk" && owners.leases) {
    owners.cursorSdk.requireModel(input.modelSelection.modelId);
    const installation = owners.cursorSdk.requireInstallation();
    const lease = owners.leases.acquireUse(installation.identity, { kind: "provider-run", operationId: input.runId });
    return { release: () => lease.release({ cleanupConfirmed: true }), quarantine: (reason: string) => { lease.quarantine(reason); } };
  }
  const admission = owners.authority.acquire(input.providerId, executable, input.backendProfile, "provider-run", input.runId);
  const finished = owners.recovery.trackRun(input.providerId);
  return {
    release: () => {
      const released = owners.authority.release(admission);
      if (released) finished();
      return released;
    },
    quarantine: (reason: string) => { owners.authority.quarantine(admission, reason); },
    liftQuarantine: () => {
      finished();
      if (admission) owners.leases?.liftQuarantine(admission.identity, admission.owner.operationId);
    },
  };
}
