import { officiallyAllowsModelSwitchWithinSession } from "../../shared/continuation-policy";
import type { BackendCompatibilityProbeResult } from "../../shared/backend-probe";
import {
  currentKnownHarnessIdSchema,
  modelSelectionSchema,
  providerIdForHarness,
  resolveHarnessBackendCompatibility,
  versionedContinuationIdentityForSelection,
  type HarnessBackendCompatibility,
  type ModelBackendProfile,
  type ModelSelection,
} from "../../shared/model-routing";
import { officialPresetEndpoint } from "../runtime/backends/backend-profile-presets";
import { ProviderRuntimeError } from "./contracts";
import type { ProviderCapabilityAuthority } from "./provider-capability-authority";
import type { ResolvedModelRoute } from "./provider-manager-types";

export interface ModelRouteResolutionState {
  readonly backendProfiles: ReadonlyMap<string, ModelBackendProfile>;
  readonly backendCompatibilities: ReadonlyMap<string, HarnessBackendCompatibility>;
  readonly backendProbeResults: ReadonlyMap<string, BackendCompatibilityProbeResult>;
  readonly backendProbeNow: () => Date;
  readonly capabilityAuthority: Pick<ProviderCapabilityAuthority, "continuationToken">;
}

export function resolveModelRoute(
  state: ModelRouteResolutionState,
  selectionInput: ModelSelection,
): ResolvedModelRoute {
  const selection = modelSelectionSchema.parse(selectionInput);
  const harnessId = currentKnownHarnessIdSchema.safeParse(selection.harnessId);
  const providerId = providerIdForHarness(selection.harnessId);
  if (!harnessId.success || !providerId) {
    throw new ProviderRuntimeError("invalid_input", `Unknown agent harness '${selection.harnessId}'.`);
  }
  const backendProfile = state.backendProfiles.get(selection.backendProfileId);
  if (!backendProfile || !backendProfile.enabled) {
    throw new ProviderRuntimeError(
      "invalid_input",
      `Model backend '${selection.backendProfileDisplayName}' is unavailable.`,
    );
  }
  if (backendProfile.configurationRevision !== selection.backendConfigurationRevision) {
    throw new ProviderRuntimeError(
      "invalid_input",
      `Model backend '${backendProfile.displayName}' changed. Start a new chat before continuing.`,
    );
  }
  const explicit = state.backendCompatibilities.get(
    `${selection.harnessId}\0${selection.backendProfileId}`,
  );
  const probe = state.backendProbeResults.get(
    `${selection.backendProfileId}\0${selection.modelId}`,
  );
  // Custom profiles are always adjudicated from exact probe evidence. An
  // optimistic registration must never bypass a stale or failed probe.
  const compatibility = backendProfile.source === "custom"
    ? resolveHarnessBackendCompatibility(harnessId.data, backendProfile, {
        evaluatedAt: state.backendProbeNow(),
        modelId: selection.modelId,
        probe,
        officialEndpoint: officialPresetEndpoint(backendProfile),
      })
    : explicit ?? resolveHarnessBackendCompatibility(
        harnessId.data,
        backendProfile,
        {
          evaluatedAt: state.backendProbeNow(),
          modelId: selection.modelId,
          probe,
        },
      );
  const providerCompatibilityToken = state.capabilityAuthority.continuationToken(
    providerId,
    harnessId.data,
    backendProfile,
    compatibility,
    selection.modelId,
  );
  return {
    providerId,
    harnessId: harnessId.data,
    backendProfile,
    compatibility,
    continuationIdentity: versionedContinuationIdentityForSelection(
      selection,
      backendProfile.endpointIdentity,
      !officiallyAllowsModelSwitchWithinSession(compatibility),
      providerCompatibilityToken,
    ),
  };
}
