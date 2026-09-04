import type {
  ModelBackendProfileView,
  ModelSelection,
  ProviderId,
  ProviderInfo,
  ProviderModel,
} from "@shared/contracts";
import {
  fastModeProviderValue,
  providerIdForHarness,
  providerNativeBackendProfile,
} from "../../../shared/model-routing";
import {
  composerRouteReadiness,
  type ComposerRouteReadiness,
} from "./composerReadiness";

export interface ComposerResolvedModel {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
  inputModalities: readonly ["text"] | ProviderModel["inputModalities"];
  reasoningOptions: ProviderModel["reasoningOptions"];
  defaultReasoningEffort: string;
  fastMode: ProviderModel["fastMode"];
}

export interface ComposerRouteState {
  providerId: ProviderId | null;
  provider: ProviderInfo | undefined;
  profile: ModelBackendProfileView | undefined;
  model: ComposerResolvedModel | undefined;
  readiness: ComposerRouteReadiness;
  exactIdentity: boolean;
  historical: boolean;
}

function unavailable(
  badge: string,
  title: string,
  detail: string,
  action: Exclude<ComposerRouteReadiness, { ready: true }>["action"],
): ComposerRouteReadiness {
  return {
    ready: false,
    transient: false,
    badge,
    title,
    detail,
    action,
  };
}

function providerModel(
  model: ProviderModel,
): ComposerResolvedModel {
  return {
    ...model,
    inputModalities: [...model.inputModalities],
    reasoningOptions: model.reasoningOptions.map((option) => ({ ...option })),
    fastMode: model.fastMode ?? null,
  };
}

function providerDefaultModel(
  provider: ProviderInfo,
): ComposerResolvedModel {
  const model = provider.models.find(({ isDefault }) => isDefault)
    ?? provider.models[0];
  return {
    id: "provider-default",
    label: "Provider default",
    description: model
      ? `Uses the current ${provider.label} default (${model.label}).`
      : `Uses the current ${provider.label} default.`,
    isDefault: true,
    inputModalities: model ? [...model.inputModalities] : ["text"],
    reasoningOptions: model?.reasoningOptions.map((option) => ({
      ...option,
    })) ?? [],
    defaultReasoningEffort: model?.defaultReasoningEffort ?? "",
    fastMode: model?.fastMode ?? null,
  };
}

function backendModel(
  profile: ModelBackendProfileView,
  modelId: string,
): ComposerResolvedModel | undefined {
  const model = profile.models.find(({ id }) => id === modelId);
  if (!model) return undefined;
  return {
    id: model.id,
    label: model.displayName,
    description: `${profile.displayName} model through ${profile.harnessId}`,
    isDefault: profile.routing.primaryModelId === model.id,
    inputModalities: ["text"],
    reasoningOptions: model.reasoningOptions.map((option) => ({ ...option })),
    defaultReasoningEffort: model.reasoningOptions[0]?.value ?? "",
    fastMode: null,
  };
}

function resolved(
  providerId: ProviderId | null,
  provider: ProviderInfo | undefined,
  profile: ModelBackendProfileView | undefined,
  model: ComposerResolvedModel | undefined,
  readiness: ComposerRouteReadiness,
  exactIdentity: boolean,
  historical: boolean,
): ComposerRouteState {
  return {
    providerId,
    provider,
    profile,
    model,
    readiness,
    exactIdentity,
    historical,
  };
}

/** Resolve every composer surface from one exact persisted route identity. */
export function resolveComposerRouteState(input: {
  conversationProviderId: ProviderId;
  selection: ModelSelection;
  providers: readonly ProviderInfo[];
  profiles: readonly ModelBackendProfileView[];
}): ComposerRouteState {
  const providerId = providerIdForHarness(input.selection.harnessId);
  const provider = input.providers.find(({ id }) => id === providerId);
  const profile = input.profiles.find(({ id }) =>
    id === input.selection.backendProfileId);
  if (!providerId || providerId !== input.conversationProviderId) {
    return resolved(
      providerId,
      provider,
      profile,
      undefined,
      unavailable(
        "Route mismatch",
        "Saved provider route is inconsistent",
        "Choose the intended model route again before sending.",
        null,
      ),
      false,
      true,
    );
  }

  const native = providerNativeBackendProfile(providerId);
  const nativeRoute = input.selection.backendProfileId === native.id;
  if (!nativeRoute && !profile) {
    return resolved(
      providerId,
      provider,
      undefined,
      undefined,
      unavailable(
        "Unavailable",
        `${input.selection.backendProfileDisplayName} is unavailable`,
        "Open Model Backends or choose another exact route.",
        null,
      ),
      false,
      true,
    );
  }
  if (
    profile
    && (
      profile.harnessId !== input.selection.harnessId
      || profile.configurationRevision
        !== input.selection.backendConfigurationRevision
    )
  ) {
    return resolved(
      providerId,
      provider,
      profile,
      undefined,
      unavailable(
        "Route changed",
        `${profile.displayName} was reconfigured`,
        "Open Model Backends or choose a route from the current revision.",
        null,
      ),
      false,
      true,
    );
  }
  if (
    nativeRoute
    && input.selection.backendConfigurationRevision
      !== native.configurationRevision
  ) {
    return resolved(
      providerId,
      provider,
      profile,
      undefined,
      unavailable(
        "Route changed",
        `${native.displayName} route identity changed`,
        "Refresh provider models and choose the route again.",
        null,
      ),
      false,
      true,
    );
  }

  let model: ComposerResolvedModel | undefined;
  if (nativeRoute) {
    if (!provider) {
      return resolved(
        providerId,
        undefined,
        profile,
        undefined,
        unavailable(
          "Unavailable",
          "Selected provider is unavailable",
          "Refresh agent status before sending.",
          "refresh",
        ),
        false,
        true,
      );
    }
    if (input.selection.modelId === "provider-default") {
      model = providerDefaultModel(provider);
    } else {
      const catalogFreshness = provider.metadataState.models.freshness;
      const catalogModel = provider.models.find(({ id }) =>
        id === input.selection.modelId);
      model = catalogModel ? providerModel(catalogModel) : undefined;
      if (!model && catalogFreshness !== "fresh") {
        return resolved(
          providerId,
          provider,
          profile,
          model,
          unavailable(
            "Refresh needed",
            "Saved model availability is not current",
            "Refresh provider models before sending on this exact route.",
            "refresh",
          ),
          true,
          true,
        );
      }
      if (!model) {
        return resolved(
          providerId,
          provider,
          profile,
          undefined,
          unavailable(
            "Model removed",
            `${input.selection.alias ?? input.selection.modelId} is unavailable`,
            "The fresh provider catalog no longer contains this model. Choose another route.",
            null,
          ),
          true,
          true,
        );
      }
    }
  } else {
    model = backendModel(profile!, input.selection.modelId);
    if (!model) {
      return resolved(
        providerId,
        provider,
        profile,
        undefined,
        unavailable(
          "Model removed",
          `${input.selection.alias ?? input.selection.modelId} is unavailable`,
          "This backend revision no longer contains the saved model. Choose another route.",
          null,
        ),
        false,
        true,
      );
    }
  }

  const expectedFastModeValue = providerId === "codex"
    ? "priority"
    : providerId === "claude"
      ? "fast"
      : null;
  if (
    model.fastMode?.providerValue !== expectedFastModeValue
    || !nativeRoute
  ) {
    model = { ...model, fastMode: null };
  }

  if (
    input.selection.reasoningEffort !== null
    && !model.reasoningOptions.some(({ value }) =>
      value === input.selection.reasoningEffort)
  ) {
    return resolved(
      providerId,
      provider,
      profile,
      model,
      unavailable(
        "Reasoning unavailable",
        "Saved reasoning level is not supported",
        "Choose a supported reasoning level or another exact model route.",
        null,
      ),
      true,
      true,
    );
  }

  const providerOptionKeys = Object.keys(input.selection.providerOptions);
  const fastMode = fastModeProviderValue(input.selection);
  if (
    providerOptionKeys.length > (fastMode ? 1 : 0)
    || (providerOptionKeys.length === 1 && !fastMode)
  ) {
    return resolved(
      providerId,
      provider,
      profile,
      model,
      unavailable(
        "Route option invalid",
        "Unsupported option",
        "Reselect the route.",
        null,
      ),
      true,
      true,
    );
  }
  if (
    fastMode
    && (
      !nativeRoute
      || model.fastMode?.providerValue !== fastMode
    )
  ) {
    return resolved(
      providerId,
      provider,
      profile,
      model,
      unavailable(
        "Fast unavailable",
        "Fast is unavailable",
        "Use Standard or refresh.",
        nativeRoute ? "refresh" : null,
      ),
      true,
      true,
    );
  }

  const readiness = composerRouteReadiness({
    provider,
    profile: nativeRoute ? undefined : profile,
    selection: input.selection,
  });
  return resolved(
    providerId,
    provider,
    nativeRoute ? profile : profile!,
    model,
    readiness,
    true,
    false,
  );
}
