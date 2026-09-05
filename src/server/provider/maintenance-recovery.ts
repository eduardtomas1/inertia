import type { ProviderId } from "./contracts";
import {
  ProviderInstallationLeaseCoordinator,
  sameProviderInstallationIdentity,
  type ProviderInstallationIdentity,
  type ProviderInstallationMaintenanceLease,
  type ProviderInstallationVerificationAuthority,
} from "./installation-lease";
import type {
  ProviderMaintenanceJournal,
  ProviderMaintenanceRecoveryRecord,
} from "./maintenance-journal";

export interface ProviderMaintenanceRecoveryRuntime {
  invalidateInstallationEvidence(providerId: ProviderId): void;
  verifyInstallationConformance(
    providerId: ProviderId,
    cwd: string,
    authority: ProviderInstallationVerificationAuthority,
  ): Promise<ProviderInstallationIdentity>;
}

export interface ProviderMaintenanceStartupRecoveryOptions {
  journal: ProviderMaintenanceJournal;
  installationLeases: ProviderInstallationLeaseCoordinator;
  runtime: ProviderMaintenanceRecoveryRuntime;
  cwd: string;
  confirmedRuntimeGenerationIds: ReadonlySet<string>;
  currentSystemBootId: string;
  priorBootCleanupConfirmed: boolean;
}

function cleanupConfirmedFor(
  record: ProviderMaintenanceRecoveryRecord,
  options: ProviderMaintenanceStartupRecoveryOptions,
): boolean {
  return options.confirmedRuntimeGenerationIds.has(record.runtimeGenerationId)
    || (
      options.priorBootCleanupConfirmed
      && record.systemBootId !== options.currentSystemBootId
    );
}

function quarantineRecord(
  record: ProviderMaintenanceRecoveryRecord,
  coordinator: ProviderInstallationLeaseCoordinator,
  reason: string,
  observedIdentity?: ProviderInstallationIdentity,
): void {
  const identities = [
    record.installationIdentity,
    ...(record.verifiedIdentity ? [record.verifiedIdentity] : []),
    ...(observedIdentity ? [observedIdentity] : []),
  ];
  const seen = new Set<string>();
  for (const identity of identities) {
    if (seen.has(identity.scopeId)) continue;
    seen.add(identity.scopeId);
    coordinator.quarantineObservation(
      identity,
      { kind: "startup-recovery", operationId: record.operationId },
      reason,
    );
  }
}

/**
 * Reconciles only records whose prior runtime process cleanup is authoritative,
 * then re-runs native installation conformance before retiring durable state.
 */
export async function recoverProviderMaintenanceJournal(
  options: ProviderMaintenanceStartupRecoveryOptions,
): Promise<readonly ProviderMaintenanceRecoveryRecord[]> {
  const records = options.journal.reconcile({
    confirmedRuntimeGenerationIds: options.confirmedRuntimeGenerationIds,
    currentSystemBootId: options.currentSystemBootId,
    priorBootCleanupConfirmed: options.priorBootCleanupConfirmed,
  });
  for (const record of records) {
    if (!cleanupConfirmedFor(record, options)) {
      quarantineRecord(
        record,
        options.installationLeases,
        "provider-maintenance-runtime-cleanup-unconfirmed",
      );
      continue;
    }

    let lease: ProviderInstallationMaintenanceLease | null = null;
    let observedIdentity: ProviderInstallationIdentity | undefined;
    try {
      lease = await options.installationLeases.acquireMaintenance(
        record.installationIdentity,
        { operationId: record.operationId },
      );
      const authority = lease.authorizePostMaintenanceVerification({
        cleanupConfirmed: true,
      });
      if (!authority) {
        throw new Error(
          "Provider maintenance recovery could not establish verification authority.",
        );
      }
      options.runtime.invalidateInstallationEvidence(
        record.installationIdentity.providerId,
      );
      observedIdentity = await options.runtime.verifyInstallationConformance(
        record.installationIdentity.providerId,
        options.cwd,
        authority,
      );
      if (
        record.verifiedIdentity
        && !sameProviderInstallationIdentity(
          record.verifiedIdentity,
          observedIdentity,
        )
      ) {
        throw new Error(
          "The provider installation changed after durable maintenance verification.",
        );
      }
      if (!options.journal.markVerified(record.operationId, observedIdentity)) {
        throw new Error(
          "Provider maintenance recovery verification was not durable.",
        );
      }
      if (!lease.complete({
        cleanupConfirmed: true,
        stateDurable: true,
        observedIdentity,
      })) {
        lease = null;
        throw new Error(
          "Provider maintenance recovery could not release exact authority.",
        );
      }
      lease = null;
      if (!options.journal.retireVerified(
        record.operationId,
        observedIdentity,
      )) {
        throw new Error(
          "Provider maintenance recovery journal retirement was unconfirmed.",
        );
      }
    } catch {
      lease?.quarantine(
        "provider-maintenance-startup-reverification-failed",
        observedIdentity,
      );
      quarantineRecord(
        record,
        options.installationLeases,
        "provider-maintenance-startup-reverification-failed",
        observedIdentity,
      );
    }
  }
  return options.journal.pending();
}
