import type {
  BackendModelDefinition,
  BackendModelRouting,
  ClientCommand,
  ModelBackendProfileCreateDraft,
  ModelBackendProfileDraft,
  ModelBackendProfileUpdate,
  ModelCapability,
} from "@shared/contracts";

export type BackendProfileUpdateInput = Partial<Omit<ModelBackendProfileDraft, "preset">> & {
  preset?: ModelBackendProfileUpdate["preset"];
  enabled?: boolean;
};

type BackendProfileCreatePayload = Extract<
  ClientCommand,
  { type: "backend.profile.create" }
>["payload"];
type BackendProfileUpdatePayload = Extract<
  ClientCommand,
  { type: "backend.profile.update" }
>["payload"]["update"];
type MutableModels = NonNullable<BackendProfileUpdatePayload["models"]>;
type MutableRouting = NonNullable<BackendProfileUpdatePayload["routing"]>;
type MutableCapabilities = NonNullable<BackendProfileUpdatePayload["capabilityHints"]>;

function mutableBackendRouting(routing: BackendModelRouting): MutableRouting {
  return routing.mode === "simple"
    ? { ...routing }
    : {
        ...routing,
        tierModels: { ...routing.tierModels },
      };
}

function mutableBackendModels(
  models: readonly BackendModelDefinition[],
): MutableModels {
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    contextWindowTokens: model.contextWindowTokens,
    reasoningOptions: model.reasoningOptions.map((option) => ({ ...option })),
    capabilities: model.capabilities.map((capability) => ({ ...capability })),
  }));
}

function mutableCapabilities(
  capabilities: readonly ModelCapability[],
): MutableCapabilities {
  return capabilities.map((capability) => ({ ...capability }));
}

export function backendProfileCreatePayload(
  draft: ModelBackendProfileCreateDraft,
): BackendProfileCreatePayload {
  if (draft.preset === "custom") {
    return {
      ...draft,
      models: mutableBackendModels(draft.models),
      routing: mutableBackendRouting(draft.routing),
      capabilityHints: mutableCapabilities(draft.capabilityHints),
    };
  }
  return {
    preset: draft.preset,
    ...(draft.displayName !== undefined ? { displayName: draft.displayName } : {}),
    ...(draft.harnessId !== undefined ? { harnessId: draft.harnessId } : {}),
    ...(draft.protocol !== undefined ? { protocol: draft.protocol } : {}),
    ...(draft.authenticationMode !== undefined
      ? { authenticationMode: draft.authenticationMode }
      : {}),
    ...(draft.baseUrl !== undefined ? { baseUrl: draft.baseUrl } : {}),
    ...(draft.allowInsecureLocalhost !== undefined
      ? { allowInsecureLocalhost: draft.allowInsecureLocalhost }
      : {}),
    ...(draft.allowPrivateNetwork !== undefined
      ? { allowPrivateNetwork: draft.allowPrivateNetwork }
      : {}),
    ...(draft.models !== undefined ? { models: mutableBackendModels(draft.models) } : {}),
    ...(draft.routing !== undefined ? { routing: mutableBackendRouting(draft.routing) } : {}),
    ...(draft.capabilityHints !== undefined
      ? { capabilityHints: mutableCapabilities(draft.capabilityHints) }
      : {}),
  };
}

export function backendProfileUpdatePayload(
  update: BackendProfileUpdateInput,
): BackendProfileUpdatePayload {
  return {
    ...(update.displayName !== undefined
      ? { displayName: update.displayName }
      : {}),
    ...(update.harnessId !== undefined ? { harnessId: update.harnessId } : {}),
    ...(update.protocol !== undefined ? { protocol: update.protocol } : {}),
    ...(update.authenticationMode !== undefined
      ? { authenticationMode: update.authenticationMode }
      : {}),
    ...(update.preset !== undefined ? { preset: update.preset } : {}),
    ...(update.baseUrl !== undefined ? { baseUrl: update.baseUrl } : {}),
    ...(update.allowInsecureLocalhost !== undefined
      ? { allowInsecureLocalhost: update.allowInsecureLocalhost }
      : {}),
    ...(update.allowPrivateNetwork !== undefined
      ? { allowPrivateNetwork: update.allowPrivateNetwork }
      : {}),
    ...(update.models !== undefined
      ? { models: mutableBackendModels(update.models) }
      : {}),
    ...(update.routing !== undefined
      ? { routing: mutableBackendRouting(update.routing) }
      : {}),
    ...(update.capabilityHints !== undefined
      ? { capabilityHints: mutableCapabilities(update.capabilityHints) }
      : {}),
    ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
  };
}
