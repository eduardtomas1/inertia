import type {
  AppSettings,
  AppSnapshot,
  ModelBackendDefault,
  ModelSelection,
  ProviderId,
  ProviderInfo,
} from "./contracts";
import {
  providerIdForHarness,
  providerNativeModelSelection,
} from "./model-routing";

export type NewChatDefaultSource = "project-backend" | "global-backend" | "settings" | "fallback";

export interface NewChatDefault {
  source: NewChatDefaultSource;
  providerId: ProviderId | null;
  modelId: string;
  reasoning: string | null;
  selection: ModelSelection;
}

export type NewChatDefaultSnapshot = Pick<AppSnapshot, "backendDefaults" | "backendProfiles" | "providers">;

export type NewChatDefaultSettings = Pick<AppSettings, "defaultProvider" | "defaultModel" | "defaultReasoningEffort">;

function cloneSelection(selection: ModelSelection): ModelSelection {
  return {
    ...selection,
    providerOptions: { ...selection.providerOptions },
    capabilities: selection.capabilities.map((capability) => ({ ...capability })),
  };
}

function validBackendDefault(
  snapshot: NewChatDefaultSnapshot,
  candidate: ModelBackendDefault | undefined,
): ModelSelection | null {
  if (!candidate) return null;
  const selection = candidate.selection;
  const nativeProviderId = providerIdForHarness(selection.harnessId);
  if (selection.backendProfileId.startsWith("builtin:") && nativeProviderId) {
    const provider = snapshot.providers.find(({ id }) => id === nativeProviderId);
    const knownRemoved = selection.modelId !== "provider-default"
      && provider?.metadataState.models.freshness === "fresh"
      && !provider.models.some(({ id }) => id === selection.modelId);
    return knownRemoved ? null : cloneSelection(selection);
  }
  const profile = snapshot.backendProfiles?.find(({ id }) => id === selection.backendProfileId);
  if (
    !profile
    || !profile.enabled
    || profile.harnessId !== selection.harnessId
    || profile.configurationRevision !== selection.backendConfigurationRevision
    || !profile.models.some(({ id }) => id === selection.modelId)
  ) return null;
  return cloneSelection(selection);
}

export function newChatDefaultProvider(
  settings: NewChatDefaultSettings,
  _providers: readonly ProviderInfo[],
): { providerId: ProviderId; fallback: boolean } {
  return { providerId: settings.defaultProvider, fallback: false };
}

function fromSelection(source: NewChatDefaultSource, selection: ModelSelection): NewChatDefault {
  return {
    source,
    providerId: providerIdForHarness(selection.harnessId),
    modelId: selection.modelId,
    reasoning: selection.reasoningEffort,
    selection,
  };
}

export function effectiveNewChatDefault(
  snapshot: NewChatDefaultSnapshot,
  settings: NewChatDefaultSettings,
  projectId: string | null = null,
): NewChatDefault {
  const projectDefault = projectId === null
    ? undefined
    : snapshot.backendDefaults?.find(({ scope, projectId: scoped }) => scope === "project" && scoped === projectId);
  const projectSelection = validBackendDefault(snapshot, projectDefault);
  if (projectSelection) return fromSelection("project-backend", projectSelection);
  const globalSelection = validBackendDefault(snapshot, snapshot.backendDefaults?.find(({ scope }) => scope === "global"));
  if (globalSelection) return fromSelection("global-backend", globalSelection);

  const { providerId, fallback } = newChatDefaultProvider(settings, snapshot.providers);
  const provider = snapshot.providers.find(({ id }) => id === providerId);
  const configuredModel = (!fallback && settings.defaultModel) || "provider-default";
  const configuredModelWasRemoved = configuredModel !== "provider-default"
    && provider?.metadataState.models.freshness === "fresh"
    && !provider.models.some(({ id }) => id === configuredModel);
  const modelId = configuredModelWasRemoved ? "provider-default" : configuredModel;
  return fromSelection(fallback ? "fallback" : "settings", providerNativeModelSelection({
    providerId,
    modelId,
    alias: modelId === "provider-default" ? null : modelId,
    reasoningEffort: configuredModelWasRemoved || fallback ? null : settings.defaultReasoningEffort || null,
  }));
}
