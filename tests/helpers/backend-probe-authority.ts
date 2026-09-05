import {
  BACKEND_PROBE_AUTHORITY_SCHEMA_VERSION,
  BACKEND_PROBE_FRESHNESS_MS,
  type HarnessBackendProbeAuthority,
} from "../../src/shared/model-routing";

export function backendProbeTestAuthority(
  checkedAt: string,
  admissionSequence = 1,
  installationFingerprint: string | null = "1".repeat(64),
): HarnessBackendProbeAuthority {
  return {
    schemaVersion: BACKEND_PROBE_AUTHORITY_SCHEMA_VERSION,
    operationId: "00000000-0000-4000-8000-000000000001",
    admissionSequence,
    installationFingerprint,
    expiresAt: new Date(
      Date.parse(checkedAt) + BACKEND_PROBE_FRESHNESS_MS,
    ).toISOString(),
  };
}
