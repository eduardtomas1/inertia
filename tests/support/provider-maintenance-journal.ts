import type {
  ProviderInstallationIdentity,
} from "../../src/server/provider/installation-lease";
import type {
  ProviderMaintenanceJournalAuthority,
  ProviderMaintenanceRecoveryRecord,
} from "../../src/server/provider/maintenance-journal";

/** Minimal deterministic authority for controller tests that do not test I/O. */
export function providerMaintenanceJournalTestDouble():
ProviderMaintenanceJournalAuthority {
  const records = new Map<string, {
    identity: ProviderInstallationIdentity;
    verified: ProviderInstallationIdentity | null;
  }>();
  return {
    begin: (operationId, identity) => {
      if (
        records.has(operationId)
        || [...records.values()].some(
          (record) => record.identity.providerId === identity.providerId,
        )
      ) return false;
      records.set(operationId, { identity, verified: null });
      return true;
    },
    markVerified: (operationId, observedIdentity) => {
      const record = records.get(operationId);
      if (!record || record.identity.providerId !== observedIdentity.providerId) {
        return false;
      }
      if (record.identity.boundaryId !== observedIdentity.boundaryId) return false;
      record.verified = observedIdentity;
      return true;
    },
    retireVerified: (operationId, observedIdentity) => {
      const record = records.get(operationId);
      if (
        !record?.verified
        || record.verified.boundaryId !== observedIdentity.boundaryId
        || record.verified.scopeId !== observedIdentity.scopeId
        || record.verified.fingerprint !== observedIdentity.fingerprint
      ) return false;
      records.delete(operationId);
      return true;
    },
    abandonUnadmitted: (operationId, identity) => {
      const record = records.get(operationId);
      if (
        !record
        || record.verified
        || record.identity.boundaryId !== identity.boundaryId
        || record.identity.scopeId !== identity.scopeId
        || record.identity.fingerprint !== identity.fingerprint
      ) return false;
      records.delete(operationId);
      return true;
    },
    pending: (): ProviderMaintenanceRecoveryRecord[] => [...records].map(
      ([operationId, record]) => ({
        operationId,
        installationIdentity: record.identity,
        runtimeGenerationId: "00000000-0000-4000-8000-000000000001:1",
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
        verifiedIdentity: record.verified,
      }),
    ),
  };
}
