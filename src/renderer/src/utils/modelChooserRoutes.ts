import type {
  BackendModelDefinition,
  ContinuationIdentity,
  HarnessBackendCompatibility,
  ModelBackendProfileView,
  ModelSelection,
  ProviderId,
  ProviderInfo,
} from "@shared/contracts";
import {
  continuationIdentityForSelection,
  legacyProviderIdForHarness,
  modelSelectionSchema,
  nativeBackendProfile,
  nativeHarnessId,
  nativeModelSelection,
  resolveHarnessBackendCompatibility,
} from "../../../shared/model-routing";
import { officiallyAllowsModelSwitchWithinSession } from "../../../shared/continuation-policy";
import type { ModelChooserSelectionCompatibility } from "../components/ModelChooserRow";
import { modelRouteIdentityKey } from "./modelFavorites";
import type { ModelSearchRoute } from "./modelSearch";

type RouteCompatibility = Pick<
  HarnessBackendCompatibility,
  "state" | "allowsModelSwitchWithinSession"
>;

export interface ComposerModelRoute extends ModelSearchRoute {
  selection: ModelSelection;
  continuationIdentity: ContinuationIdentity;
  compatibility: RouteCompatibility;
  rowCompatibility: ModelChooserSelectionCompatibility | null;
  providerId: ProviderId | null;
  reasoningEffort: string | null;
  reasoningOptions: readonly string[];
}

const harnessLabels: Readonly<Record<ProviderId, string>> = {
  codex: "Codex harness",
  claude: "Claude harness",
  cursor: "Cursor",
  opencode: "OpenCode",
};

export function modelChooserHarnessLabel(harnessId: string): string {
  const providerId = legacyProviderIdForHarness(harnessId);
  if (providerId) return harnessLabels[providerId];
  return harnessId;
}

function sameRoute(
  left: Pick<
    ModelSelection,
    | "harnessId"
    | "backendProfileId"
    | "backendConfigurationRevision"
    | "modelId"
  >,
  right: Pick<
    ModelSelection,
    | "harnessId"
    | "backendProfileId"
    | "backendConfigurationRevision"
    | "modelId"
  >,
): boolean {
  return left.harnessId === right.harnessId
    && left.backendProfileId === right.backendProfileId
    && left.backendConfigurationRevision
      === right.backendConfigurationRevision
    && left.modelId === right.modelId;
}

function compatibilityForRow(
  compatibility: HarnessBackendCompatibility,
): ModelChooserSelectionCompatibility | null {
  if (compatibility.state === "verified") return null;
  if (
    compatibility.state === "unknown"
    || compatibility.state === "unavailable"
  ) {
    return null;
  }
  return {
    affectsSelection: true,
    state: compatibility.state === "partially-compatible"
      ? "partial"
      : "unknown",
    explanation: compatibility.reason,
  };
}

function selectionForProfileModel(
  profile: ModelBackendProfileView,
  modelId: string,
): ModelSelection {
  const model = profile.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error("The selected backend model is unavailable.");
  return modelSelectionSchema.parse({
    harnessId: profile.harnessId,
    backendProfileId: profile.id,
    backendProfileDisplayName: profile.displayName,
    modelId: model.id,
    alias: profile.preset === "kimi-code" || model.id === "provider-default"
      ? null
      : model.displayName === model.id ? null : model.displayName,
    reasoningEffort: model.id === "provider-default"
      ? null
      : profile.preset === "kimi-code"
      ? "high"
      : model.reasoningOptions[0]?.value ?? null,
    contextWindowOverride: model.contextWindowTokens,
    providerOptions: {},
    capabilities: model.capabilities,
    backendConfigurationRevision: profile.configurationRevision,
  });
}

function profileRoute(
  profile: ModelBackendProfileView,
  modelId: string,
  providers: readonly ProviderInfo[],
  currentSelection: ModelSelection,
): ComposerModelRoute {
  const model = profile.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error("The selected backend model is unavailable.");
  const generatedSelection = selectionForProfileModel(profile, model.id);
  const selection = sameRoute(generatedSelection, currentSelection)
    ? currentSelection
    : generatedSelection;
  const providerId = legacyProviderIdForHarness(profile.harnessId);
  const provider = providers.find(({ id }) => id === providerId);
  const nativeCatalogCurrent = profile.preset !== "native"
    || model.id === "provider-default"
    || provider?.metadataState.models.freshness === "fresh";
  const selectable = profile.enabled
    && profile.compatibility.state !== "unknown"
    && profile.compatibility.state !== "unavailable"
    && nativeCatalogCurrent;
  return {
    key: modelRouteIdentityKey(selection),
    displayName: model.displayName,
    modelId: model.id,
    alias: selection.alias,
    harnessId: profile.harnessId,
    harnessLabel: modelChooserHarnessLabel(profile.harnessId),
    backendProfileId: profile.id,
    backendProfileName: profile.displayName,
    backendConfigurationRevision:
      selection.backendConfigurationRevision,
    providerLabel: provider?.label ?? profile.displayName,
    source: profile.source,
    routeTerms: [
      profile.preset,
      profile.protocol,
      ...(providerId ? [providerId] : []),
    ],
    reasoningEffort: selection.reasoningEffort,
    reasoningOptions: Array.from(new Set([
      ...(selection.reasoningEffort ? [selection.reasoningEffort] : []),
      ...model.reasoningOptions.map(({ value }) => value),
    ])),
    selectable,
    unavailableReason: selectable
      ? null
      : !nativeCatalogCurrent
        ? "Refresh provider models before selecting this exact route."
        : profile.compatibility.reason,
    selection,
    continuationIdentity: continuationIdentityForSelection(
      selection,
      profile.endpointIdentity,
      !officiallyAllowsModelSwitchWithinSession(profile.compatibility),
    ),
    compatibility: profile.compatibility,
    rowCompatibility: compatibilityForRow(profile.compatibility),
    providerId,
  };
}

function fallbackNativeRoutes(
  providers: readonly ProviderInfo[],
  currentSelection: ModelSelection,
): ComposerModelRoute[] {
  return providers.flatMap((provider) => {
    const defaultModel = provider.models.find(({ isDefault }) => isDefault)
      ?? provider.models[0];
    const models = [{
      id: "provider-default",
      label: "Provider default",
      defaultReasoningEffort: "",
      reasoningOptions: defaultModel?.reasoningOptions ?? [],
    }, ...provider.models.filter(({ id }) => id !== "provider-default")];
    const backend = nativeBackendProfile(provider.id);
    const harnessId = nativeHarnessId(provider.id);
    const compatibility = resolveHarnessBackendCompatibility(
      harnessId,
      backend,
    );
    return models.map((model) => {
      const generatedSelection = nativeModelSelection({
        providerId: provider.id,
        modelId: model.id,
        alias: model.id === "provider-default" ? null : model.label,
        reasoningEffort: model.id === "provider-default"
          ? null
          : model.defaultReasoningEffort || null,
      });
      const selection = sameRoute(generatedSelection, currentSelection)
        ? currentSelection
        : generatedSelection;
      const selectable = model.id === "provider-default"
        || provider.metadataState.models.freshness === "fresh";
      return {
        key: modelRouteIdentityKey(selection),
        displayName: model.label,
        modelId: model.id,
        alias: selection.alias,
        harnessId,
        harnessLabel: modelChooserHarnessLabel(harnessId),
        backendProfileId: backend.id,
        backendProfileName: backend.displayName,
        backendConfigurationRevision:
          selection.backendConfigurationRevision,
        providerLabel: provider.label,
        source: "built-in" as const,
        routeTerms: [provider.id],
        reasoningEffort: selection.reasoningEffort,
        reasoningOptions: Array.from(new Set([
          ...(selection.reasoningEffort ? [selection.reasoningEffort] : []),
          ...model.reasoningOptions.map(({ value }) => value),
        ])),
        selectable,
        unavailableReason: selectable
          ? null
          : "Refresh provider models before selecting this exact route.",
        selection,
        continuationIdentity: continuationIdentityForSelection(
          selection,
          null,
          !officiallyAllowsModelSwitchWithinSession(compatibility),
        ),
        compatibility,
        rowCompatibility: null,
        providerId: provider.id,
      };
    });
  });
}

function nativeProviderDefaultModel(
  provider: ProviderInfo | undefined,
): BackendModelDefinition {
  const currentDefault = provider?.models.find(({ isDefault }) => isDefault)
    ?? provider?.models[0];
  return {
    id: "provider-default",
    displayName: "Provider default",
    contextWindowTokens: null,
    reasoningOptions: currentDefault?.reasoningOptions.map((option) => ({
      ...option,
    })) ?? [],
    capabilities: [],
  };
}

function profileWithProviderDefault(
  profile: ModelBackendProfileView,
  providers: readonly ProviderInfo[],
): ModelBackendProfileView {
  if (
    profile.preset !== "native"
    || profile.models.some(({ id }) => id === "provider-default")
  ) return profile;
  const providerId = legacyProviderIdForHarness(profile.harnessId);
  return {
    ...profile,
    models: [
      nativeProviderDefaultModel(
        providers.find(({ id }) => id === providerId),
      ),
      ...profile.models,
    ],
  };
}

/**
 * Builds only safe chooser metadata. Endpoint hosts, URLs, credential state,
 * credential references, and provider sessions never enter this projection.
 */
export function buildComposerModelRoutes(
  providers: readonly ProviderInfo[],
  backendProfiles: readonly ModelBackendProfileView[],
  currentSelection: ModelSelection,
): ComposerModelRoute[] {
  if (backendProfiles.length === 0) {
    return fallbackNativeRoutes(providers, currentSelection);
  }
  const profileRoutes = backendProfiles.flatMap((sourceProfile) => {
    const profile = profileWithProviderDefault(sourceProfile, providers);
    return profile.models.map((model) =>
      profileRoute(profile, model.id, providers, currentSelection));
  });
  const nativeProvidersWithRoutes = new Set(
    profileRoutes.flatMap((route) =>
      route.source === "built-in" && route.providerId
        ? [route.providerId]
        : []),
  );
  const missingNativeRoutes = fallbackNativeRoutes(providers, currentSelection)
    .filter(({ providerId }) =>
      providerId !== null && !nativeProvidersWithRoutes.has(providerId));
  return [...profileRoutes, ...missingNativeRoutes];
}

export function selectedModelSearchRoute(
  routes: readonly ComposerModelRoute[],
  selection: ModelSelection,
): ModelSearchRoute {
  const selected = routes.find((route) => sameRoute(route.selection, selection));
  if (selected) return selected;
  const providerId = legacyProviderIdForHarness(selection.harnessId);
  return {
    key: modelRouteIdentityKey(selection),
    displayName: selection.alias ?? selection.modelId,
    modelId: selection.modelId,
    alias: selection.alias,
    harnessId: selection.harnessId,
    harnessLabel: modelChooserHarnessLabel(selection.harnessId),
    backendProfileId: selection.backendProfileId,
    backendProfileName: selection.backendProfileDisplayName,
    backendConfigurationRevision:
      selection.backendConfigurationRevision,
    providerLabel: providerId ?? selection.backendProfileDisplayName,
    source: selection.backendProfileId.startsWith("builtin:")
      ? "built-in"
      : "custom",
    routeTerms: [],
    reasoningEffort: selection.reasoningEffort,
    reasoningOptions: [],
    selectable: false,
    unavailableReason: "This saved model route is no longer available.",
  };
}
