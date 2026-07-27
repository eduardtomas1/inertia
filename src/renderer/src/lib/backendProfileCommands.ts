import type {
  ClientCommand,
  ModelBackendProfileDraft,
} from "@shared/contracts";

type BackendProfileCreatePayload = Extract<
  ClientCommand,
  { type: "backend.profile.create" }
>["payload"];
type BackendProfileUpdatePayload = Extract<
  ClientCommand,
  { type: "backend.profile.update" }
>["payload"]["update"];

function mutableBackendRouting(
  routing: ModelBackendProfileDraft["routing"],
): BackendProfileCreatePayload["routing"] {
  return routing.mode === "simple"
    ? { ...routing }
    : {
        ...routing,
        tierModels: { ...routing.tierModels },
      };
}

function mutableBackendModels(
  models: ModelBackendProfileDraft["models"],
): BackendProfileCreatePayload["models"] {
  return models.map((model) => ({
    ...model,
    reasoningOptions: model.reasoningOptions.map((option) => ({ ...option })),
    capabilities: model.capabilities.map((capability) => ({ ...capability })),
  }));
}

export function backendProfileCreatePayload(
  draft: ModelBackendProfileDraft,
): BackendProfileCreatePayload {
  return {
    ...draft,
    models: mutableBackendModels(draft.models),
    routing: mutableBackendRouting(draft.routing),
    capabilityHints: draft.capabilityHints.map((capability) => ({
      ...capability,
    })),
  };
}

export function backendProfileUpdatePayload(
  update: Partial<ModelBackendProfileDraft> & { enabled?: boolean },
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
    ...(update.models !== undefined
      ? { models: mutableBackendModels(update.models) }
      : {}),
    ...(update.routing !== undefined
      ? { routing: mutableBackendRouting(update.routing) }
      : {}),
    ...(update.capabilityHints !== undefined
      ? {
          capabilityHints: update.capabilityHints.map((capability) => ({
            ...capability,
          })),
        }
      : {}),
    ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
  };
}
