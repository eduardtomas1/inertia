import type {
  AgentTurn,
  Conversation,
  ModelBackendProfileView,
  ProviderInfo,
} from "../../../shared/contracts";
import {
  fastModeProviderValue,
  modelSelectionSchema,
  providerIdForHarness,
  providerNativeModelSelection,
  type ModelSelection,
} from "../../../shared/model-routing";
import {
  routingCatalogFromProviders,
  type RoutingCatalogEntry,
} from "../../../shared/routing/routing-catalog";
import type {
  RoutingCandidate,
  RoutingCurrentRoute,
} from "../../../shared/routing/routing-planner";

/**
 * The live routing catalog: advertised native models and enabled custom
 * backends, with the chat's own usage-limit evidence folded in so a route
 * that just hit its limit is never chosen again for the next turn.
 */
export function runtimeRoutingCatalog(
  providers: readonly ProviderInfo[],
  backendProfiles: readonly ModelBackendProfileView[],
  latestTurn: Pick<AgentTurn, "providerId" | "backendProfileId" | "usageLimited"> | null,
): RoutingCatalogEntry[] {
  return routingCatalogFromProviders(providers, backendProfiles).map((entry) =>
    latestTurn?.usageLimited
      && entry.providerId === latestTurn.providerId
      && entry.backendProfileId === latestTurn.backendProfileId
      ? { ...entry, usageLimited: true }
      : entry);
}

export function currentRoutingRoute(
  conversation: Pick<Conversation, "providerId" | "modelSelection">,
): RoutingCurrentRoute {
  return {
    providerId: providerIdForHarness(conversation.modelSelection.harnessId) ?? conversation.providerId,
    backendProfileId: conversation.modelSelection.backendProfileId,
    modelId: conversation.modelSelection.modelId,
    reasoningEffort: conversation.modelSelection.reasoningEffort,
    fastMode: fastModeProviderValue(conversation.modelSelection) !== null,
  };
}

/**
 * Builds the unvalidated selection for a candidate. Callers must still pass
 * it through the authoritative selection validator before using it.
 */
export function routingCandidateSelection(
  candidate: Pick<RoutingCandidate, "preset" | "entry">,
  providers: readonly ProviderInfo[],
  backendProfiles: readonly ModelBackendProfileView[],
): ModelSelection {
  const { preset, entry } = candidate;
  if (entry.native) {
    const model = providers
      .find(({ id }) => id === preset.providerId)
      ?.models.find(({ id }) => id === preset.modelId);
    const fastMode = preset.fastMode ? model?.fastMode?.providerValue ?? null : null;
    return providerNativeModelSelection({
      providerId: preset.providerId,
      modelId: preset.modelId,
      alias: model && model.label !== model.id ? model.label : null,
      reasoningEffort: preset.reasoningEffort,
      providerOptions: fastMode ? { fastMode } : {},
    });
  }
  const profile = backendProfiles.find(({ id }) => id === preset.backendProfileId);
  if (!profile) throw new Error("The routed backend profile is unavailable.");
  return modelSelectionSchema.parse({
    harnessId: profile.harnessId,
    backendProfileId: profile.id,
    backendProfileDisplayName: profile.displayName,
    modelId: preset.modelId,
    alias: null,
    reasoningEffort: preset.reasoningEffort,
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: profile.configurationRevision,
  });
}
