import type {
  BackendModelDefinition,
  ModelBackendProfileDraft,
  ModelBackendProfileView,
} from "@shared/contracts";

export type BackendDraftModelField =
  | "id"
  | "displayName"
  | "contextWindowTokens";

export function backendProfileIsReady(
  profile: Pick<
    ModelBackendProfileView,
    "enabled" | "authState" | "connectionState"
  > & {
    compatibility: Pick<ModelBackendProfileView["compatibility"], "state">;
  },
): boolean {
  const authReady = profile.authState === "configured"
    || profile.authState === "harness-managed"
    || profile.authState === "not-required";
  const connectionReady = profile.connectionState === "connected"
    || profile.connectionState === "limited";
  return profile.enabled
    && authReady
    && connectionReady
    && profile.compatibility.state !== "unknown"
    && profile.compatibility.state !== "unavailable";
}

function replaceRoutedModel(
  draft: ModelBackendProfileDraft,
  previousId: string,
  nextId: string,
): ModelBackendProfileDraft["routing"] {
  const replace = (current: string): string =>
    current === previousId ? nextId : current;
  if (draft.routing.mode === "simple") {
    return {
      ...draft.routing,
      primaryModelId: replace(draft.routing.primaryModelId),
    };
  }
  return {
    ...draft.routing,
    primaryModelId: replace(draft.routing.primaryModelId),
    tierModels: Object.fromEntries(
      Object.entries(draft.routing.tierModels)
        .map(([tier, modelId]) => [tier, replace(modelId)]),
    ) as typeof draft.routing.tierModels,
    subagentModelId: replace(draft.routing.subagentModelId),
  };
}

export function updateBackendDraftModel(
  draft: ModelBackendProfileDraft,
  index: number,
  field: BackendDraftModelField,
  value: string,
): ModelBackendProfileDraft {
  const previous = draft.models[index];
  if (!previous) return draft;
  const nextModel: BackendModelDefinition = {
    ...previous,
    [field]: field === "contextWindowTokens"
      ? value.trim() ? Number(value) : null
      : value,
  };
  return {
    ...draft,
    models: draft.models.map((model, modelIndex) =>
      modelIndex === index ? nextModel : model),
    routing: replaceRoutedModel(draft, previous.id, nextModel.id),
  };
}

export function setBackendDraftAdvancedRouting(
  draft: ModelBackendProfileDraft,
  enabled: boolean,
): ModelBackendProfileDraft {
  const primaryModelId = draft.models.some(({ id }) =>
    id === draft.routing.primaryModelId)
    ? draft.routing.primaryModelId
    : draft.models[0]?.id ?? "custom-model";
  return {
    ...draft,
    routing: enabled
      ? {
          mode: "advanced",
          primaryModelId,
          tierModels: {
            fable: primaryModelId,
            opus: primaryModelId,
            sonnet: primaryModelId,
            haiku: primaryModelId,
          },
          subagentModelId: primaryModelId,
        }
      : { mode: "simple", primaryModelId },
  };
}
