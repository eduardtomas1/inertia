import type {
  AppSettings,
  AppSnapshot,
  ModelBackendDefault,
  ModelSelection,
} from "@shared/contracts";
import {
  legacyProviderIdForHarness,
  nativeModelSelection,
} from "../../../shared/model-routing";
import {
  buildNewConversationPayload,
  type NewConversationLocation,
  type NewConversationPayload,
  withNewConversationModelSelection,
} from "../lib/newConversation";

function cloneSelection(selection: ModelSelection): ModelSelection {
  return {
    ...selection,
    providerOptions: { ...selection.providerOptions },
    capabilities: selection.capabilities.map((capability) => ({
      ...capability,
    })),
  };
}

function validBackendDefault(
  snapshot: Pick<AppSnapshot, "backendProfiles" | "providers">,
  candidate: ModelBackendDefault | undefined,
): ModelSelection | null {
  if (!candidate) return null;
  const selection = candidate.selection;
  const nativeProviderId = legacyProviderIdForHarness(selection.harnessId);
  if (selection.backendProfileId.startsWith("builtin:") && nativeProviderId) {
    const provider = snapshot.providers.find(({ id }) =>
      id === nativeProviderId);
    const knownRemoved = selection.modelId !== "provider-default"
      && provider?.metadataState.models.freshness === "fresh"
      && !provider.models.some(({ id }) => id === selection.modelId);
    return knownRemoved ? null : cloneSelection(selection);
  }
  const profile = snapshot.backendProfiles?.find(({ id }) =>
    id === selection.backendProfileId);
  if (
    !profile
    || !profile.enabled
    || profile.harnessId !== selection.harnessId
    || profile.configurationRevision
      !== selection.backendConfigurationRevision
    || !profile.models.some(({ id }) => id === selection.modelId)
  ) return null;
  return cloneSelection(selection);
}

export function defaultSelectionForProject(
  snapshot: Pick<
    AppSnapshot,
    "backendDefaults" | "backendProfiles" | "providers"
  >,
  settings: AppSettings,
  projectId: string,
): ModelSelection {
  const projectDefault = snapshot.backendDefaults?.find(
    ({ scope, projectId: scopedProjectId }) =>
      scope === "project" && scopedProjectId === projectId,
  );
  const globalDefault = snapshot.backendDefaults?.find(({ scope }) =>
    scope === "global");
  const configured = validBackendDefault(snapshot, projectDefault)
    ?? validBackendDefault(snapshot, globalDefault);
  if (configured) return configured;

  const provider = snapshot.providers.find(({ id }) =>
    id === settings.defaultProvider);
  const configuredModel = settings.defaultModel || "provider-default";
  const configuredModelWasRemoved = configuredModel !== "provider-default"
    && provider?.metadataState.models.freshness === "fresh"
    && !provider.models.some(({ id }) => id === configuredModel);
  const modelId = configuredModelWasRemoved
    ? "provider-default"
    : configuredModel;
  return nativeModelSelection({
    providerId: settings.defaultProvider,
    modelId,
    alias: modelId === "provider-default" ? null : modelId,
    reasoningEffort: configuredModelWasRemoved
      ? null
      : settings.defaultReasoningEffort || null,
  });
}

export function defaultConversationPayloadForProject(
  snapshot: Pick<
    AppSnapshot,
    "backendDefaults" | "backendProfiles" | "providers"
  >,
  settings: AppSettings,
  projectId: string,
  location: NewConversationLocation = { kind: "defaults" },
): NewConversationPayload {
  return withNewConversationModelSelection(
    buildNewConversationPayload(projectId, settings, location),
    defaultSelectionForProject(snapshot, settings, projectId),
  );
}
