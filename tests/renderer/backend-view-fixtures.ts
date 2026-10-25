import type { BackendCompatibilityProbeResult } from "../../src/shared/backend-probe";
import {
  backendProfileProviderId,
  backendProfileRouteKind,
  type BackendModelDefinition,
  type ModelBackendProfileModelView,
  type ModelBackendProfileView,
} from "../../src/shared/backend-profile-settings";
import { MODEL_CAPABILITY_IDS } from "../../src/shared/model-routing";

type LegacyModel = BackendModelDefinition & Partial<Pick<ModelBackendProfileModelView, "compatibility" | "latestProbe">>;

export type LegacyBackendProfile<Profile extends ModelBackendProfileView> =
  Omit<Profile, "models" | "routeKind" | "providerId" | "allowPrivateNetwork"> & {
    models: readonly LegacyModel[];
    routeKind?: ModelBackendProfileView["routeKind"];
    providerId?: ModelBackendProfileView["providerId"];
    allowPrivateNetwork?: boolean;
  };

export function backendView<Profile extends ModelBackendProfileView = ModelBackendProfileView>(
  profile: LegacyBackendProfile<Profile>,
): Profile {
  return {
    ...profile,
    allowPrivateNetwork: profile.allowPrivateNetwork ?? false,
    routeKind: profile.routeKind ?? backendProfileRouteKind(profile),
    providerId: profile.providerId ?? backendProfileProviderId(profile),
    models: profile.models.map((model) => ({
      ...model,
      compatibility: model.compatibility ?? { ...profile.compatibility },
      latestProbe: model.latestProbe ?? null,
    })),
  } as unknown as Profile;
}

export function probeResult(
  profileId: string,
  modelId: string,
  failure: BackendCompatibilityProbeResult["failure"] = null,
  revision = 1,
): BackendCompatibilityProbeResult {
  const checkedAt = "2026-10-24T10:00:00.000Z";
  return {
    profileId,
    backendConfigurationRevision: revision,
    endpointIdentity: `endpoint:${profileId}`,
    protocol: "anthropic-messages",
    modelId,
    compatibility: failure ? "unavailable" : "protocol-compatible",
    protocolVerified: failure === null,
    modelVerified: failure === null,
    capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
      id,
      state: "unknown",
      provenance: "probe",
      detail: null,
      checkedAt,
    })),
    contextWindow: {
      tokens: null,
      state: "unknown",
      provenance: "unknown",
      detail: null,
      checkedAt,
    },
    failure,
    checkedAt,
  };
}
