import {
  ANTHROPIC_API_KEY_TIER_MODEL_IDS,
  API_KEY_BACKEND_PRESET_IDS,
  BACKEND_PRESETS,
  backendPresetDefinition,
  isApiKeyBackendPresetId,
  normalizeBackendBaseUrl,
  type ApiKeyBackendPresetId,
} from "../../../shared/backend-presets";
import { backendEndpointIdentity } from "../../../shared/backend-endpoint-identity";
import type { ModelBackendProfile } from "../../../shared/model-routing";
import {
  MAX_BACKEND_PROBE_MODELS,
  type BackendModelDefinition,
  type BackendModelRouting,
  type BackendReasoningOption,
  type ModelBackendDraftPreset,
  type ModelBackendPresetProfileDraft,
  type ModelBackendProfileDraft,
  type PersistedModelBackendProfile,
} from "../../../shared/backend-profile-settings";
import type { ProviderInfo } from "../../../shared/contracts";

const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_EXTENDED_EFFORTS: ReadonlySet<string> = new Set(["xhigh", "max"]);
const CLAUDE_TIER_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;
const MAX_REASONING_OPTIONS = 32;

const OFFICIAL_PRESET_ENDPOINTS = API_KEY_BACKEND_PRESET_IDS.map((presetId) => {
  const preset = BACKEND_PRESETS[presetId];
  return {
    protocol: preset.protocol,
    endpointIdentity: backendEndpointIdentity(
      normalizeBackendBaseUrl(preset.protocol, preset.baseUrl),
    ),
  };
});

export function officialPresetEndpoint(
  profile: Pick<ModelBackendProfile, "protocol" | "source" | "endpointIdentity">,
): boolean {
  return profile.source === "custom"
    && OFFICIAL_PRESET_ENDPOINTS.some((endpoint) =>
      endpoint.protocol === profile.protocol
      && endpoint.endpointIdentity === profile.endpointIdentity);
}

export interface BackendConnectionValues {
  displayName: string;
  harnessId: PersistedModelBackendProfile["harnessId"];
  protocol: PersistedModelBackendProfile["protocol"];
  authenticationMode: PersistedModelBackendProfile["authenticationMode"];
  preset: ModelBackendDraftPreset;
  baseUrl: string;
  allowInsecureLocalhost: boolean;
  allowPrivateNetwork: boolean;
  models: readonly BackendModelDefinition[];
  routing: BackendModelRouting;
  capabilityHints: PersistedModelBackendProfile["capabilityHints"];
}

function claudeReasoningOption(effort: string): BackendReasoningOption {
  return {
    value: effort,
    label: effort === "xhigh"
      ? "Extra high"
      : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`,
    description: `${effort === "xhigh" ? "Extra-high" : effort} reasoning effort`,
  };
}

function openAiModelFamily(modelId: string): string {
  const segments = modelId.toLowerCase().split("-");
  return segments[0] === "gpt" ? segments.slice(0, 2).join("-") : segments[0] ?? "";
}

function boundedText(value: string, maximum: number): string {
  return value.replace(/[\0\r\n]+/gu, " ").trim().slice(0, maximum).trim();
}

function catalogReasoningOptions(
  model: ProviderInfo["models"][number] | undefined,
): BackendReasoningOption[] {
  if (!model) return [];
  const seen = new Set<string>();
  const options: BackendReasoningOption[] = [];
  for (const option of model.reasoningOptions) {
    const value = boundedText(option.value, 100);
    const label = boundedText(option.label, 200) || value;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label, description: boundedText(option.description, 500) });
    if (options.length >= MAX_REASONING_OPTIONS) break;
  }
  return options;
}

export function presetReasoningOptions(
  preset: ApiKeyBackendPresetId,
  modelId: string,
  catalog: readonly ProviderInfo["models"][number][],
): BackendReasoningOption[] {
  if (preset === "anthropic-api-key") {
    const native = catalog.find(({ id }) => id === modelId)
      ?? catalog.find(({ id }) =>
        (CLAUDE_TIER_ALIASES as readonly string[]).includes(id) && modelId.split("-").includes(id));
    const supported = new Set(native?.reasoningOptions.map(({ value }) => value) ?? []);
    return CLAUDE_REASONING_EFFORTS
      .filter((effort) => !CLAUDE_EXTENDED_EFFORTS.has(effort) || supported.has(effort))
      .map(claudeReasoningOption);
  }
  const native = catalogReasoningOptions(catalog.find(({ id }) => id === modelId));
  if (native.length > 0) return native;
  const nativeDefault = catalog.find(({ isDefault }) => isDefault) ?? catalog[0];
  return nativeDefault && openAiModelFamily(nativeDefault.id) === openAiModelFamily(modelId)
    ? catalogReasoningOptions(nativeDefault)
    : [];
}

export function withPresetReasoning(
  preset: PersistedModelBackendProfile["preset"],
  models: readonly BackendModelDefinition[],
  catalog: readonly ProviderInfo["models"][number][],
): BackendModelDefinition[] {
  if (!isApiKeyBackendPresetId(preset)) return [...models];
  return models.map((model) => model.reasoningOptions.length > 0
    ? model
    : { ...model, reasoningOptions: presetReasoningOptions(preset, model.id, catalog) });
}

function defaultPresetRouting(
  preset: ApiKeyBackendPresetId,
  models: readonly BackendModelDefinition[],
): BackendModelRouting {
  const modelIds = new Set(models.map(({ id }) => id));
  const tiers = ANTHROPIC_API_KEY_TIER_MODEL_IDS;
  if (
    preset === "anthropic-api-key"
    && Object.values(tiers).every((modelId) => modelIds.has(modelId))
  ) {
    return {
      mode: "advanced",
      primaryModelId: tiers.opus,
      tierModels: { ...tiers },
      subagentModelId: tiers.sonnet,
    };
  }
  return { mode: "simple", primaryModelId: models[0]!.id };
}

export function presetConnectionValues(
  draft: ModelBackendPresetProfileDraft,
): BackendConnectionValues {
  const preset = backendPresetDefinition(draft.preset);
  const models = draft.models ?? preset.defaultModels.map(({ id, displayName }) => ({
    id,
    displayName,
    contextWindowTokens: null,
    reasoningOptions: [],
    capabilities: [],
  }));
  return {
    displayName: draft.displayName ?? preset.displayName,
    harnessId: preset.harnessId,
    protocol: preset.protocol,
    authenticationMode: preset.authenticationMode,
    preset: draft.preset,
    baseUrl: preset.baseUrl,
    allowInsecureLocalhost: false,
    allowPrivateNetwork: false,
    models,
    routing: draft.routing ?? defaultPresetRouting(draft.preset, models),
    capabilityHints: draft.capabilityHints ?? [],
  };
}

export function customConnectionValues(
  draft: ModelBackendProfileDraft,
): BackendConnectionValues {
  return {
    displayName: draft.displayName,
    harnessId: draft.harnessId,
    protocol: draft.protocol,
    authenticationMode: draft.authenticationMode,
    preset: "custom",
    baseUrl: draft.baseUrl,
    allowInsecureLocalhost: draft.allowInsecureLocalhost,
    allowPrivateNetwork: draft.allowPrivateNetwork ?? false,
    models: draft.models,
    routing: draft.routing,
    capabilityHints: draft.capabilityHints,
  };
}

export function defaultProbeModelIds(
  profile: Pick<PersistedModelBackendProfile, "models" | "routing">,
): string[] {
  const primary = profile.routing.primaryModelId;
  const ordered = [
    ...profile.models.filter(({ id }) => id === primary),
    ...profile.models.filter(({ id }) => id !== primary),
  ];
  return ordered.slice(0, MAX_BACKEND_PROBE_MODELS).map(({ id }) => id);
}
