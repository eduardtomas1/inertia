import type {
  ModelBackendProfileUpdate,
  PersistedModelBackendProfile,
} from "../../../shared/backend-profile-settings";
import { isApiKeyBackendPresetId, normalizeBackendBaseUrl } from "../../../shared/backend-presets";
import type { BackendCompatibilityProbeResult } from "../../../shared/backend-probe";
import type { HarnessBackendCompatibility } from "../../../shared/model-routing";
import { promptCacheTtlAllowed } from "../../../shared/compact-on-return";

export function backendConnectionSemantics(
  profile: Pick<
    PersistedModelBackendProfile,
    | "harnessId"
    | "protocol"
    | "authenticationMode"
    | "preset"
    | "endpointIdentity"
    | "allowInsecureLocalhost"
    | "allowPrivateNetwork"
  >,
): string {
  return JSON.stringify({
    harnessId: profile.harnessId,
    protocol: profile.protocol,
    authenticationMode: profile.authenticationMode,
    preset: profile.preset,
    endpointIdentity: profile.endpointIdentity,
    allowInsecureLocalhost: profile.allowInsecureLocalhost,
    allowPrivateNetwork: profile.allowPrivateNetwork,
  });
}

export function backendPersistedState(
  profile: PersistedModelBackendProfile,
): string {
  return JSON.stringify({
    ...profile,
    updatedAt: null,
  });
}

export function sameNormalizedBaseUrl(
  protocol: PersistedModelBackendProfile["protocol"],
  left: string | null,
  right: string,
): boolean {
  if (left === null) return false;
  try {
    return normalizeBackendBaseUrl(protocol, left) === right;
  } catch {
    return false;
  }
}

export function profileProbesOverHttp(profile: PersistedModelBackendProfile): boolean {
  return profile.source === "custom"
    && profile.baseUrl !== null
    && (profile.protocol === "anthropic-messages" || profile.protocol === "openai-responses");
}

export function compatibilityFailureMessage(
  compatibility: HarnessBackendCompatibility,
  probe: BackendCompatibilityProbeResult | null,
): string {
  return probe?.failure
    ? `${compatibility.reason} ${probe.failure.message}`
    : compatibility.reason;
}

export function backendDraftForValidation(
  requested: PersistedModelBackendProfile,
  update: ModelBackendProfileUpdate,
): Record<string, unknown> {
  const common = {
    displayName: requested.displayName,
    models: requested.models,
    routing: requested.routing,
    capabilityHints: requested.capabilityHints,
    ...(requested.promptCacheTtl ? { promptCacheTtl: requested.promptCacheTtl } : {}),
  };
  if (isApiKeyBackendPresetId(requested.preset)) {
    return {
      ...common,
      preset: requested.preset,
      harnessId: requested.harnessId,
      protocol: requested.protocol,
      authenticationMode: requested.authenticationMode,
      ...(update.baseUrl === undefined ? {} : { baseUrl: update.baseUrl }),
      allowInsecureLocalhost: requested.allowInsecureLocalhost,
      allowPrivateNetwork: requested.allowPrivateNetwork,
    };
  }
  return {
    ...common,
    preset: "custom",
    harnessId: requested.harnessId,
    protocol: requested.protocol,
    authenticationMode: requested.authenticationMode,
    baseUrl: update.baseUrl ?? requested.baseUrl ?? "",
    allowInsecureLocalhost: requested.allowInsecureLocalhost,
    allowPrivateNetwork: requested.allowPrivateNetwork,
  };
}

export function withPromptCacheTtl(
  stored: PersistedModelBackendProfile,
  update: Omit<ModelBackendProfileUpdate, "enabled">,
): PersistedModelBackendProfile {
  const { promptCacheTtl: requested, ...connection } = update;
  const { promptCacheTtl: _stored, ...merged } = { ...stored, ...connection };
  const next = requested === undefined
    ? promptCacheTtlAllowed(merged) ? stored.promptCacheTtl : undefined
    : requested ?? undefined;
  return next ? { ...merged, promptCacheTtl: next } : merged;
}
