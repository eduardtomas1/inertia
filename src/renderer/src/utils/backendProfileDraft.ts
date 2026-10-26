import type {
  BackendDiscoveredModel,
  BackendModelDefinition,
  BackendModelRouting,
  KnownHarnessId,
  ModelBackendProfileDetail,
  ModelBackendProfileDraft,
  ModelBackendProfilePreset,
  ModelBackendProfileView,
} from "@shared/contracts";
import { normalizeBackendBaseUrl } from "@shared/backend-presets";
import {
  validateBackendProfileDraft,
  type BackendProfileIssue,
} from "@shared/backend-profile-validation";
import type { BackendProfileUpdateInput } from "../lib/backendProfileCommands";
import { promptCacheTtlAllowed } from "@shared/compact-on-return";

export type BackendDraftModelField =
  | "id"
  | "displayName"
  | "contextWindowTokens";

export type BackendProfileEditDraft = Omit<ModelBackendProfileDraft, "preset" | "allowPrivateNetwork"> & {
  preset: ModelBackendProfilePreset;
  allowPrivateNetwork: boolean;
};

type ComparableDraft = Omit<BackendProfileEditDraft, "allowPrivateNetwork"> & {
  allowPrivateNetwork?: boolean;
};

export type BackendProfileSemanticUpdate = BackendProfileUpdateInput;

export type BackendCustomHarness = Extract<KnownHarnessId, "claude-agent-sdk" | "codex-app-server">;

type RoutedDraft = Pick<ModelBackendProfileDraft, "models" | "routing">;

function semanticallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function copiedModel(model: BackendModelDefinition): BackendModelDefinition {
  return {
    id: model.id,
    displayName: model.displayName,
    contextWindowTokens: model.contextWindowTokens,
    reasoningOptions: model.reasoningOptions.map((option) => ({ ...option })),
    capabilities: model.capabilities.map((capability) => ({ ...capability })),
  };
}

function trimmedModels(models: readonly BackendModelDefinition[]): BackendModelDefinition[] {
  return models.map((model) => ({
    ...copiedModel(model),
    id: model.id.trim(),
    displayName: model.displayName.trim(),
  }));
}

export function backendProfileSemanticUpdate(
  current: ComparableDraft,
  next: ComparableDraft,
): BackendProfileSemanticUpdate {
  return {
    ...(current.displayName !== next.displayName
      ? { displayName: next.displayName.trim() }
      : {}),
    ...(current.harnessId !== next.harnessId
      ? { harnessId: next.harnessId }
      : {}),
    ...(current.protocol !== next.protocol
      ? { protocol: next.protocol }
      : {}),
    ...(current.authenticationMode !== next.authenticationMode
      ? { authenticationMode: next.authenticationMode }
      : {}),
    ...(current.baseUrl !== next.baseUrl ? { baseUrl: next.baseUrl.trim() } : {}),
    ...(current.allowInsecureLocalhost !== next.allowInsecureLocalhost
      ? { allowInsecureLocalhost: next.allowInsecureLocalhost }
      : {}),
    ...((current.allowPrivateNetwork ?? false) !== (next.allowPrivateNetwork ?? false)
      ? { allowPrivateNetwork: next.allowPrivateNetwork ?? false }
      : {}),
    ...(!semanticallyEqual(current.models, next.models)
      ? { models: trimmedModels(next.models) }
      : {}),
    ...(!semanticallyEqual(current.routing, next.routing)
      ? { routing: next.routing }
      : {}),
    ...(!semanticallyEqual(current.capabilityHints, next.capabilityHints)
      ? { capabilityHints: next.capabilityHints }
      : {}),
    ...(next.promptCacheTtl !== undefined
      && current.promptCacheTtl !== next.promptCacheTtl
      && promptCacheTtlAllowed(next)
      ? { promptCacheTtl: next.promptCacheTtl }
      : {}),
  };
}

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
  routing: BackendModelRouting,
  previousId: string,
  nextId: string,
): BackendModelRouting {
  const replace = (current: string): string =>
    current === previousId ? nextId : current;
  if (routing.mode === "simple") {
    return {
      ...routing,
      primaryModelId: replace(routing.primaryModelId),
    };
  }
  return {
    ...routing,
    primaryModelId: replace(routing.primaryModelId),
    tierModels: Object.fromEntries(
      Object.entries(routing.tierModels)
        .map(([tier, modelId]) => [tier, replace(modelId)]),
    ) as typeof routing.tierModels,
    subagentModelId: replace(routing.subagentModelId),
  };
}

export function updateBackendDraftModel<Draft extends RoutedDraft>(
  draft: Draft,
  index: number,
  field: BackendDraftModelField,
  value: string,
  options: { nameFollowsId?: boolean } = {},
): Draft {
  const previous = draft.models[index];
  if (!previous) return draft;
  const nextModel: BackendModelDefinition = {
    ...previous,
    [field]: field === "contextWindowTokens"
      ? value.trim() ? Number(value) : null
      : value,
    ...(field === "id" && options.nameFollowsId ? { displayName: value } : {}),
  };
  return {
    ...draft,
    models: draft.models.map((model, modelIndex) =>
      modelIndex === index ? nextModel : model),
    routing: replaceRoutedModel(draft.routing, previous.id, nextModel.id),
  };
}

export function setBackendDraftAdvancedRouting<Draft extends RoutedDraft>(
  draft: Draft,
  enabled: boolean,
): Draft {
  const primaryModelId = draft.models.some(({ id }) =>
    id === draft.routing.primaryModelId)
    ? draft.routing.primaryModelId
    : draft.models[0]?.id ?? "";
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

export function removeBackendDraftModel<Draft extends RoutedDraft>(
  draft: Draft,
  index: number,
): Draft {
  const removed = draft.models[index];
  if (!removed || draft.models.length <= 1) return draft;
  const remaining = draft.models.filter((_, modelIndex) => modelIndex !== index);
  return {
    ...draft,
    models: remaining,
    routing: replaceRoutedModel(draft.routing, removed.id, remaining[0]!.id),
  };
}

export function emptyBackendModel(): BackendModelDefinition {
  return {
    id: "",
    displayName: "",
    contextWindowTokens: null,
    reasoningOptions: [],
    capabilities: [],
  };
}

export function emptyCustomBackendDraft(
  harnessId: BackendCustomHarness = "claude-agent-sdk",
): BackendProfileEditDraft {
  return {
    displayName: "",
    harnessId,
    protocol: harnessId === "claude-agent-sdk" ? "anthropic-messages" : "openai-responses",
    authenticationMode: "api-key",
    preset: "custom",
    baseUrl: "",
    allowInsecureLocalhost: false,
    allowPrivateNetwork: false,
    models: [emptyBackendModel()],
    routing: { mode: "simple", primaryModelId: "" },
    capabilityHints: [],
  };
}

export function backendEditDraftFromDetail(
  profile: ModelBackendProfileDetail,
): BackendProfileEditDraft {
  return {
    displayName: profile.displayName,
    harnessId: profile.harnessId,
    protocol: profile.protocol,
    authenticationMode: profile.authenticationMode,
    preset: profile.preset,
    baseUrl: profile.baseUrl ?? "",
    allowInsecureLocalhost: profile.allowInsecureLocalhost,
    allowPrivateNetwork: profile.allowPrivateNetwork ?? false,
    models: profile.models.map(copiedModel),
    routing: profile.routing.mode === "simple"
      ? { ...profile.routing }
      : { ...profile.routing, tierModels: { ...profile.routing.tierModels } },
    capabilityHints: profile.capabilityHints.map((capability) => ({ ...capability })),
    ...(promptCacheTtlAllowed(profile) ? { promptCacheTtl: profile.promptCacheTtl ?? "5m" } : {}),
  };
}

export function customCreateDraft(draft: BackendProfileEditDraft): ModelBackendProfileDraft {
  return {
    displayName: draft.displayName.trim(),
    harnessId: draft.harnessId,
    protocol: draft.protocol,
    authenticationMode: draft.authenticationMode,
    preset: "custom",
    baseUrl: draft.baseUrl.trim(),
    allowInsecureLocalhost: draft.allowInsecureLocalhost,
    allowPrivateNetwork: draft.allowPrivateNetwork,
    models: trimmedModels(draft.models),
    routing: draft.routing,
    capabilityHints: draft.capabilityHints,
    ...(draft.promptCacheTtl === "1h" && promptCacheTtlAllowed(draft) ? { promptCacheTtl: draft.promptCacheTtl } : {}),
  };
}

export function backendEditDraftIssues(draft: BackendProfileEditDraft): BackendProfileIssue[] {
  if (draft.preset === "custom") return validateBackendProfileDraft(customCreateDraft(draft));
  if (draft.preset === "anthropic-api-key" || draft.preset === "openai-api-key") {
    return validateBackendProfileDraft({
      preset: draft.preset,
      displayName: draft.displayName.trim(),
      models: trimmedModels(draft.models),
      routing: draft.routing,
    });
  }
  return [];
}

export function backendIssueMessages(
  issues: readonly BackendProfileIssue[],
): ReadonlyMap<string, string> {
  const messages = new Map<string, string>();
  for (const issue of issues) {
    if (!messages.has(issue.field)) messages.set(issue.field, issue.message);
  }
  return messages;
}

export function normalizedBackendUrlPreview(
  protocol: ModelBackendProfileDraft["protocol"],
  value: string,
): string | null {
  if (!value.trim()) return null;
  try {
    return normalizeBackendBaseUrl(protocol, value);
  } catch {
    return null;
  }
}

export function mergeDiscoveredModels<Draft extends RoutedDraft>(
  draft: Draft,
  discovered: readonly BackendDiscoveredModel[],
): Draft {
  const existing = draft.models.filter(({ id }) => id.trim().length > 0);
  const known = new Set(existing.map(({ id }) => id));
  const added = discovered
    .filter(({ id }) => !known.has(id))
    .map(({ id, displayName }) => ({ ...emptyBackendModel(), id, displayName: displayName || id }));
  const models = [...existing, ...added];
  if (models.length === 0) return draft;
  const ids = new Set(models.map(({ id }) => id));
  const primaryModelId = ids.has(draft.routing.primaryModelId)
    ? draft.routing.primaryModelId
    : models[0]!.id;
  const simple: BackendModelRouting = { mode: "simple", primaryModelId };
  const routing = draft.routing.mode === "simple"
    ? simple
    : setBackendDraftAdvancedRouting({ models, routing: simple }, true).routing;
  return { ...draft, models, routing };
}
