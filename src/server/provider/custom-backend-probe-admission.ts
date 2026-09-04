import {
  backendCompatibilityProbeResultSchema,
  backendProbeMatchesProfile,
  type BackendCompatibilityProbeResult,
} from "../../shared/backend-probe";
import type { ModelBackendProfile } from "../../shared/model-routing";
import type { ModelCapability } from "../../shared/model-routing";
import type { ProviderCapabilityId } from "./capability-manifest";
import { customBackendObservedCapabilities } from "./runtime-capability-attestation";

export function recordBackendProbeEvidence(
  results: Map<string, BackendCompatibilityProbeResult>,
  profiles: ReadonlyMap<string, ModelBackendProfile>,
  resultInput: BackendCompatibilityProbeResult,
  evaluatedAt: Date,
): void {
  const result = backendCompatibilityProbeResultSchema.parse(resultInput);
  const profile = profiles.get(result.profileId);
  if (!profile || !backendProbeMatchesProfile(
    result,
    profile,
    result.modelId,
    evaluatedAt,
  )) return;
  const key = `${result.profileId}\0${result.modelId}`;
  const current = results.get(key);
  if (
    current
    && (current.authority?.admissionSequence ?? 0)
      >= (result.authority?.admissionSequence ?? 0)
  ) return;
  results.set(key, result);
}

/** Capabilities admitted only by fresh, exact, successful custom-route proof. */
export function admittedCustomBackendProbeEvidence(
  probe: BackendCompatibilityProbeResult | undefined,
  profile: ModelBackendProfile,
  modelId: string,
  evaluatedAt: Date,
  installationFingerprint: string | null,
): readonly ModelCapability[] {
  if (
    !probe
    || probe.failure !== null
    || !probe.protocolVerified
    || !probe.modelVerified
    || installationFingerprint === null
    || probe.authority?.installationFingerprint !== installationFingerprint
    || !backendProbeMatchesProfile(probe, profile, modelId, evaluatedAt)
  ) return [];
  return probe.capabilities;
}

export function admittedCustomBackendCapabilities(
  probe: BackendCompatibilityProbeResult | undefined,
  profile: ModelBackendProfile,
  modelId: string,
  evaluatedAt: Date,
  installationFingerprint: string | null,
): readonly ProviderCapabilityId[] {
  return customBackendObservedCapabilities(
    admittedCustomBackendProbeEvidence(
      probe,
      profile,
      modelId,
      evaluatedAt,
      installationFingerprint,
    ),
  );
}
