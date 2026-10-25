import { z } from "zod";

import {
  backendCompatibilityProbeResultSchema,
  type BackendCompatibilityProbeResult,
} from "./backend-probe";
import {
  API_KEY_BACKEND_PRESET_IDS,
  BACKEND_PRESETS,
  isApiKeyBackendPresetId,
  isBackendPresetId,
  normalizeBackendBaseUrl,
  type ApiKeyBackendPresetId,
  type BackendPresetDefinition,
} from "./backend-presets";
import {
  CURRENT_KNOWN_HARNESS_IDS,
  HARNESS_BACKEND_COMPATIBILITY_REASON_CODES,
  MODEL_CAPABILITY_IDS,
  MODEL_CAPABILITY_STATES,
  backendAuthenticationModeSchema,
  harnessIdSchema,
  modelBackendProfileIdSchema,
  modelBackendProfileSchema,
  modelBackendProtocolSchema,
  modelCapabilitySchema,
  modelSelectionSchema,
  providerIdForHarness,
  type BackendAuthenticationMode,
  type HarnessBackendCompatibility,
  type HarnessId,
  type KnownHarnessId,
  type ModelBackendProfile,
  type ModelBackendProtocol,
  type ModelCapability,
  type ModelSelection,
} from "./model-routing";
import type { ProviderId } from "./provider";
import {
  PROMPT_CACHE_TTLS,
  PROMPT_CACHE_TTL_UNAVAILABLE_MESSAGE,
  promptCacheTtlAllowed,
  type PromptCacheTtl,
} from "./compact-on-return";

export const MODEL_BACKEND_PROFILE_PRESETS = [
  "native",
  "kimi-code",
  "custom",
  "anthropic-api-key",
  "openai-api-key",
] as const;

export type ModelBackendProfilePreset =
  (typeof MODEL_BACKEND_PROFILE_PRESETS)[number];

export const MODEL_BACKEND_DRAFT_PRESETS = [
  ...API_KEY_BACKEND_PRESET_IDS,
  "custom",
] as const;

export type ModelBackendDraftPreset = (typeof MODEL_BACKEND_DRAFT_PRESETS)[number];

const PRESET_CATALOGUE: Readonly<Record<
  Exclude<ModelBackendProfilePreset, "native" | "custom">,
  BackendPresetDefinition
>> = BACKEND_PRESETS;

export const MODEL_BACKEND_CONNECTION_STATES = [
  "not-tested",
  "testing",
  "connected",
  "limited",
  "failed",
] as const;

export type ModelBackendConnectionState =
  (typeof MODEL_BACKEND_CONNECTION_STATES)[number];

export const MODEL_BACKEND_AUTH_STATES = [
  "harness-managed",
  "not-required",
  "configured",
  "missing",
  "unavailable",
  "checking",
] as const;

export type ModelBackendAuthState =
  (typeof MODEL_BACKEND_AUTH_STATES)[number];

export const BACKEND_ROUTE_KINDS = ["account", "api-key"] as const;

export type BackendRouteKind = (typeof BACKEND_ROUTE_KINDS)[number];

const BACKEND_PROVIDER_IDS = [
  "codex",
  "claude",
  "cursor",
  "kimi",
  "opencode",
  "antigravity",
] as const satisfies readonly ProviderId[];

export const CLAUDE_BACKEND_TIER_IDS = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
] as const;

export type ClaudeBackendTierId = (typeof CLAUDE_BACKEND_TIER_IDS)[number];

export const MAX_BACKEND_PROBE_MODELS = 16;
export const MAX_DISCOVERED_BACKEND_MODELS = 1_000;

export interface BackendReasoningOption {
  value: string;
  label: string;
  description: string;
}

export interface BackendModelDefinition {
  id: string;
  displayName: string;
  contextWindowTokens: number | null;
  reasoningOptions: readonly BackendReasoningOption[];
  capabilities: readonly ModelCapability[];
}

export type BackendModelRouting =
  | {
      mode: "simple";
      primaryModelId: string;
    }
  | {
      mode: "advanced";
      primaryModelId: string;
      tierModels: Readonly<Record<ClaudeBackendTierId, string>>;
      subagentModelId: string;
    };

/**
 * Safe durable configuration. It deliberately cannot represent a credential
 * value or an opaque vault reference. The privileged process derives its
 * private reference from `id` only when probing or launching a child process.
 */
export interface PersistedModelBackendProfile extends ModelBackendProfile {
  harnessId: KnownHarnessId;
  preset: ModelBackendProfilePreset;
  baseUrl: string | null;
  allowInsecureLocalhost: boolean;
  allowPrivateNetwork: boolean;
  credentialGeneration: string | null;
  models: readonly BackendModelDefinition[];
  routing: BackendModelRouting;
  capabilityHints: readonly ModelCapability[];
  promptCacheTtl?: PromptCacheTtl;
  createdAt: string;
  updatedAt: string;
}

export interface ModelBackendProfileModelView extends BackendModelDefinition {
  compatibility: HarnessBackendCompatibility;
  latestProbe: BackendCompatibilityProbeResult | null;
}

export interface ModelBackendProfileView
  extends Omit<PersistedModelBackendProfile, "baseUrl" | "models"> {
  models: readonly ModelBackendProfileModelView[];
  routeKind: BackendRouteKind;
  providerId: ProviderId;
  endpointHost: string | null;
  authState: ModelBackendAuthState;
  connectionState: ModelBackendConnectionState;
  renewing?: boolean;
  keyVerified?: boolean;
  compatibility: HarnessBackendCompatibility;
  latestProbe: BackendCompatibilityProbeResult | null;
  canDelete: boolean;
  canDisable: boolean;
}

/** Scoped editor detail. Full URLs stay out of the global shell snapshot. */
export interface ModelBackendProfileDetail extends ModelBackendProfileView {
  baseUrl: string | null;
}

export interface ModelBackendDefault {
  scope: "global" | "project";
  projectId: string | null;
  selection: ModelSelection;
  updatedAt: string;
}

export interface ModelBackendProfileDraft {
  displayName: string;
  harnessId: KnownHarnessId;
  protocol: PersistedModelBackendProfile["protocol"];
  authenticationMode: PersistedModelBackendProfile["authenticationMode"];
  preset: "custom";
  baseUrl: string;
  allowInsecureLocalhost: boolean;
  allowPrivateNetwork?: boolean;
  models: readonly BackendModelDefinition[];
  routing: BackendModelRouting;
  capabilityHints: readonly ModelCapability[];
  promptCacheTtl?: PromptCacheTtl;
}

export interface ModelBackendPresetProfileDraft {
  preset: ApiKeyBackendPresetId;
  displayName?: string;
  harnessId?: KnownHarnessId;
  protocol?: PersistedModelBackendProfile["protocol"];
  authenticationMode?: PersistedModelBackendProfile["authenticationMode"];
  baseUrl?: string;
  allowInsecureLocalhost?: boolean;
  allowPrivateNetwork?: boolean;
  models?: readonly BackendModelDefinition[];
  routing?: BackendModelRouting;
  capabilityHints?: readonly ModelCapability[];
  promptCacheTtl?: PromptCacheTtl;
}

export type ModelBackendProfileCreateDraft =
  | ModelBackendProfileDraft
  | ModelBackendPresetProfileDraft;

export interface BackendDiscoveredModel {
  id: string;
  displayName: string;
}

export interface BackendProfileModelsResult {
  kind: "backend.profile.models";
  profileId: string;
  models: readonly BackendDiscoveredModel[];
}

export interface BackendProfileProbeResult {
  kind: "backend.profile.probe";
  profile: ModelBackendProfileDetail;
  skippedModelIds?: readonly string[];
}

const CONTROL_CHARACTERS = /[\0\r\n]/u;
const UNAUTHENTICATED_CLAUDE_BACKEND_MESSAGE =
  "Claude-compatible backends need an API key or bearer token. Without one, Claude Code would send your Anthropic account sign-in to this host.";

const labelSchema = z.string().trim().min(1).max(200)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "Labels cannot contain control characters.");
const modelIdSchema = z.string().trim().min(1).max(500)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "Model IDs cannot contain control characters.");
const timestampSchema = z.string().datetime({ offset: true });
const baseUrlSchema = z.string().trim().min(1).max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }, "Backend URLs cannot contain credentials, query parameters, or fragments.");

const draftNameSchema = z.string().trim()
  .min(1, "Enter a name for this backend.")
  .max(200, "Names can be at most 200 characters.")
  .refine((value) => !CONTROL_CHARACTERS.test(value), "Names cannot contain line breaks.");
const draftModelIdSchema = z.string().trim()
  .min(1, "Enter a model ID.")
  .max(500, "Model IDs can be at most 500 characters.")
  .refine((value) => !CONTROL_CHARACTERS.test(value), "Model IDs cannot contain line breaks.");
const draftModelNameSchema = z.string().trim()
  .min(1, "Enter a display name for this model.")
  .max(200, "Model names can be at most 200 characters.")
  .refine((value) => !CONTROL_CHARACTERS.test(value), "Model names cannot contain line breaks.");

function draftBaseUrlProblem(value: string): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL, such as https://gateway.example.com/v1.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "Backend URLs must start with http:// or https://.";
  }
  if (url.username || url.password) {
    return "Backend URLs cannot contain a user name or password. Save the key separately.";
  }
  if (url.search || value.includes("?")) {
    return "Backend URLs cannot contain a query string.";
  }
  if (url.hash || value.includes("#")) {
    return "Backend URLs cannot contain a fragment.";
  }
  return null;
}

const draftBaseUrlSchema = z.string().trim()
  .min(1, "Enter the backend URL.")
  .max(2_048, "Backend URLs can be at most 2,048 characters.")
  .superRefine((value, context) => {
    const problem = draftBaseUrlProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

export const backendReasoningOptionSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: labelSchema,
  description: z.string().trim().max(500),
}).strict();

const contextWindowTokensSchema = z.number()
  .int("Enter the context window as a whole number of tokens.")
  .min(8_192, "Context windows must be at least 8,192 tokens.")
  .max(100_000_000, "Context windows can be at most 100,000,000 tokens.")
  .nullable();

const backendModelDefinitionShape = z.object({
  id: modelIdSchema,
  displayName: labelSchema,
  contextWindowTokens: contextWindowTokensSchema,
  reasoningOptions: z.array(backendReasoningOptionSchema).max(32),
  capabilities: z.array(modelCapabilitySchema).max(MODEL_CAPABILITY_IDS.length),
}).strict();

function validateModelDefinitionLists(
  model: Pick<BackendModelDefinition, "reasoningOptions" | "capabilities">,
  context: z.RefinementCtx,
): void {
  if (new Set(model.reasoningOptions.map(({ value }) => value)).size
    !== model.reasoningOptions.length) {
    context.addIssue({
      code: "custom",
      path: ["reasoningOptions"],
      message: "Reasoning option identifiers must be unique.",
    });
  }
  if (new Set(model.capabilities.map(({ id }) => id)).size
    !== model.capabilities.length) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "Model capability identifiers must be unique.",
    });
  }
}

export const backendModelDefinitionSchema =
  backendModelDefinitionShape.superRefine(validateModelDefinitionLists);

const draftModelDefinitionSchema = backendModelDefinitionShape.extend({
  id: draftModelIdSchema,
  displayName: draftModelNameSchema,
}).strict().superRefine(validateModelDefinitionLists);

function duplicateModelMessage(modelId: string): string {
  return `Model IDs must be unique. '${modelId}' is listed more than once.`;
}

const draftModelsSchema = z.array(draftModelDefinitionSchema)
  .min(1, "Add at least one model.")
  .max(128, "A backend can list at most 128 models.")
  .superRefine((models, context) => {
    const seen = new Set<string>();
    models.forEach((model, index) => {
      if (seen.has(model.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: duplicateModelMessage(model.id),
        });
      }
      seen.add(model.id);
    });
  });

export const backendModelRoutingSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("simple"),
    primaryModelId: modelIdSchema,
  }).strict(),
  z.object({
    mode: z.literal("advanced"),
    primaryModelId: modelIdSchema,
    tierModels: z.object({
      fable: modelIdSchema,
      opus: modelIdSchema,
      sonnet: modelIdSchema,
      haiku: modelIdSchema,
    }).strict(),
    subagentModelId: modelIdSchema,
  }).strict(),
]);

const capabilityHintsSchema =
  z.array(modelCapabilitySchema).max(MODEL_CAPABILITY_IDS.length);
const promptCacheTtlSchema = z.enum(PROMPT_CACHE_TTLS);

const persistedModelBackendProfileShape = modelBackendProfileSchema.extend({
  harnessId: z.enum(CURRENT_KNOWN_HARNESS_IDS),
  preset: z.enum(MODEL_BACKEND_PROFILE_PRESETS),
  baseUrl: baseUrlSchema.nullable(),
  allowInsecureLocalhost: z.boolean(),
  allowPrivateNetwork: z.boolean().default(false),
  credentialGeneration: z.string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
    .nullable(),
  models: z.array(backendModelDefinitionSchema).min(1).max(128),
  routing: backendModelRoutingSchema,
  capabilityHints: capabilityHintsSchema,
  promptCacheTtl: promptCacheTtlSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

function validateRouting(
  routing: BackendModelRouting,
  modelIds: ReadonlySet<string>,
  protocol: ModelBackendProtocol,
  context: z.RefinementCtx,
): void {
  const routedModels = routing.mode === "simple"
    ? [routing.primaryModelId]
    : [
        routing.primaryModelId,
        ...Object.values(routing.tierModels),
        routing.subagentModelId,
      ];
  for (const modelId of new Set(routedModels)) {
    if (modelIds.size > 0 && !modelIds.has(modelId)) {
      context.addIssue({
        code: "custom",
        path: ["routing"],
        message: `Routing references unknown model '${modelId}'.`,
      });
    }
  }
  if (routing.mode === "advanced" && protocol !== "anthropic-messages") {
    context.addIssue({
      code: "custom",
      path: ["routing"],
      message: "Advanced tier mappings are available only to Claude harness profiles.",
    });
  }
}

function validatePromptCacheTtl(
  values: { promptCacheTtl?: PromptCacheTtl | undefined; harnessId: string; protocol: string; preset?: string | null },
  context: z.RefinementCtx,
): void {
  if (values.promptCacheTtl !== undefined && !promptCacheTtlAllowed(values)) {
    context.addIssue({
      code: "custom",
      path: ["promptCacheTtl"],
      message: PROMPT_CACHE_TTL_UNAVAILABLE_MESSAGE,
    });
  }
}

function validateUniqueCapabilityHints(
  capabilityHints: readonly ModelCapability[],
  context: z.RefinementCtx,
): void {
  if (new Set(capabilityHints.map(({ id }) => id)).size !== capabilityHints.length) {
    context.addIssue({
      code: "custom",
      path: ["capabilityHints"],
      message: "Capability hint identifiers must be unique.",
    });
  }
}

const PROTOCOL_LABELS: Readonly<Partial<Record<ModelBackendProtocol, string>>> = {
  "anthropic-messages": "Anthropic Messages",
  "openai-responses": "OpenAI Responses",
};

const AUTHENTICATION_LABELS: Readonly<Record<BackendAuthenticationMode, string>> = {
  "harness-managed": "harness-managed",
  "api-key": "API key",
  "bearer-token": "bearer token",
  none: "no",
};

function harnessLabel(harnessId: KnownHarnessId): string {
  if (harnessId.startsWith("claude-")) return "Claude";
  if (harnessId.startsWith("codex-")) return "Codex";
  return harnessId;
}

function sameBackendBaseUrl(
  protocol: ModelBackendProtocol,
  left: string,
  right: string,
): boolean {
  try {
    return normalizeBackendBaseUrl(protocol, left) === normalizeBackendBaseUrl(protocol, right);
  } catch {
    return false;
  }
}

interface PresetConnectionValues {
  harnessId?: KnownHarnessId | undefined;
  protocol?: ModelBackendProtocol | undefined;
  authenticationMode?: BackendAuthenticationMode | undefined;
  baseUrl?: string | null | undefined;
  allowInsecureLocalhost?: boolean | undefined;
  allowPrivateNetwork?: boolean | undefined;
}

function validatePresetConnection(
  preset: BackendPresetDefinition,
  values: PresetConnectionValues,
  context: z.RefinementCtx,
): void {
  if (values.harnessId !== undefined && values.harnessId !== preset.harnessId) {
    context.addIssue({
      code: "custom",
      path: ["harnessId"],
      message: `${preset.displayName} runs on the ${harnessLabel(preset.harnessId)} harness.`,
    });
  }
  if (values.protocol !== undefined && values.protocol !== preset.protocol) {
    context.addIssue({
      code: "custom",
      path: ["protocol"],
      message: `${preset.displayName} uses the ${PROTOCOL_LABELS[preset.protocol] ?? preset.protocol} protocol.`,
    });
  }
  if (
    values.authenticationMode !== undefined
    && values.authenticationMode !== preset.authenticationMode
  ) {
    context.addIssue({
      code: "custom",
      path: ["authenticationMode"],
      message: `${preset.displayName} uses ${AUTHENTICATION_LABELS[preset.authenticationMode]} authentication.`,
    });
  }
  if (
    values.baseUrl !== undefined
    && (values.baseUrl === null || !sameBackendBaseUrl(preset.protocol, values.baseUrl, preset.baseUrl))
  ) {
    context.addIssue({
      code: "custom",
      path: ["baseUrl"],
      message: `${preset.displayName} always connects to ${preset.baseUrl}.`,
    });
  }
  for (const field of ["allowInsecureLocalhost", "allowPrivateNetwork"] as const) {
    if (values[field] === true) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${preset.displayName} connects only to its public endpoint.`,
      });
    }
  }
}

function validateProfileRelationships(
  profile: z.infer<typeof persistedModelBackendProfileShape>,
  context: z.RefinementCtx,
): void {
  const modelIds = new Set<string>();
  profile.models.forEach((model, index) => {
    if (modelIds.has(model.id)) {
      context.addIssue({
        code: "custom",
        path: ["models", index, "id"],
        message: duplicateModelMessage(model.id),
      });
    }
    modelIds.add(model.id);
  });
  validateRouting(profile.routing, modelIds, profile.protocol, context);
  validateUniqueCapabilityHints(profile.capabilityHints, context);
  validatePromptCacheTtl({ promptCacheTtl: profile.promptCacheTtl, harnessId: profile.harnessId, protocol: profile.protocol }, context);
  if (
    profile.source === "custom"
    && profile.preset !== "custom"
    && !isApiKeyBackendPresetId(profile.preset)
  ) {
    context.addIssue({
      code: "custom",
      path: ["preset"],
      message: "Custom sources require the Custom preset or an API key preset.",
    });
  }
  if (isApiKeyBackendPresetId(profile.preset)) {
    if (profile.source !== "custom") {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "API key presets are created by the person and stored as custom profiles.",
      });
    }
    validatePresetConnection(PRESET_CATALOGUE[profile.preset], profile, context);
  }
  if (profile.preset === "native" && profile.source !== "built-in") {
    context.addIssue({
      code: "custom",
      path: ["source"],
      message: "Native profiles must be built in.",
    });
  }
  if (profile.preset === "native") {
    if (
      profile.baseUrl !== null
      || profile.endpointIdentity !== null
      || profile.authenticationMode !== "harness-managed"
    ) {
      context.addIssue({
        code: "custom",
        path: ["preset"],
        message: "Native profiles use harness-managed connection settings.",
      });
    }
  } else if (profile.baseUrl === null || profile.endpointIdentity === null) {
    context.addIssue({
      code: "custom",
      path: ["baseUrl"],
      message: "Non-native profiles require an endpoint URL and identity.",
    });
  }
  if (profile.protocol === "anthropic-messages") {
    if (profile.harnessId !== "claude-agent-sdk" && profile.harnessId !== "claude-cli") {
      context.addIssue({
        code: "custom",
        path: ["harnessId"],
        message: "Anthropic Messages profiles require a Claude harness.",
      });
    }
  } else if (profile.protocol === "openai-responses") {
    if (profile.harnessId !== "codex-app-server" && profile.harnessId !== "codex-cli") {
      context.addIssue({
        code: "custom",
        path: ["harnessId"],
        message: "OpenAI Responses profiles require a Codex harness.",
      });
    }
  }
}

export const persistedModelBackendProfileSchema =
  persistedModelBackendProfileShape.strict().superRefine(validateProfileRelationships);

export function backendProfileRouteKind(
  profile: Pick<ModelBackendProfile, "authenticationMode">,
): BackendRouteKind {
  return profile.authenticationMode === "harness-managed" ? "account" : "api-key";
}

export function backendProfileProviderId(profile: {
  harnessId: HarnessId;
  preset: ModelBackendProfilePreset;
}): ProviderId {
  if (isBackendPresetId(profile.preset)) return PRESET_CATALOGUE[profile.preset].providerId;
  const providerId = providerIdForHarness(profile.harnessId);
  if (!providerId) throw new Error("The backend harness does not belong to a provider.");
  return providerId;
}

const harnessBackendCompatibilitySchema = z.object({
  harnessId: harnessIdSchema,
  backendProfileId: modelBackendProfileIdSchema,
  backendProtocol: modelBackendProtocolSchema,
  state: z.enum(MODEL_CAPABILITY_STATES),
  provenance: z.enum(["built-in", "probe", "user", "unknown"]),
  allowsModelSwitchWithinSession: z.boolean(),
  reasonCode: z.enum(HARNESS_BACKEND_COMPATIBILITY_REASON_CODES),
  reason: z.string().min(1).max(1_000),
}).strict();

const modelBackendProfileModelViewSchema = backendModelDefinitionShape.extend({
  compatibility: harnessBackendCompatibilitySchema,
  latestProbe: backendCompatibilityProbeResultSchema.nullable(),
}).strict().superRefine(validateModelDefinitionLists);

const modelBackendProfileViewShape =
  persistedModelBackendProfileShape.omit({ baseUrl: true }).extend({
    allowPrivateNetwork: z.boolean(),
    models: z.array(modelBackendProfileModelViewSchema).min(1).max(128),
    routeKind: z.enum(BACKEND_ROUTE_KINDS),
    providerId: z.enum(BACKEND_PROVIDER_IDS),
    endpointHost: z.string().max(255).nullable(),
    authState: z.enum(MODEL_BACKEND_AUTH_STATES),
    connectionState: z.enum(MODEL_BACKEND_CONNECTION_STATES),
    renewing: z.boolean().optional(),
    keyVerified: z.boolean().optional(),
    compatibility: harnessBackendCompatibilitySchema,
    latestProbe: backendCompatibilityProbeResultSchema.nullable(),
    canDelete: z.boolean(),
    canDisable: z.boolean(),
  });

function validateViewProjection(
  view: z.infer<typeof modelBackendProfileViewShape>,
  context: z.RefinementCtx,
): void {
  if (view.routeKind !== backendProfileRouteKind(view)) {
    context.addIssue({
      code: "custom",
      path: ["routeKind"],
      message: "The route kind does not match this profile's authentication.",
    });
  }
  if (view.providerId !== backendProfileProviderId(view)) {
    context.addIssue({
      code: "custom",
      path: ["providerId"],
      message: "The provider does not match this profile's harness and preset.",
    });
  }
  view.models.forEach((model, index) => {
    if (
      model.compatibility.backendProfileId !== view.id
      || model.compatibility.harnessId !== view.harnessId
    ) {
      context.addIssue({
        code: "custom",
        path: ["models", index, "compatibility"],
        message: "Model compatibility must describe this profile.",
      });
    }
    if (
      model.latestProbe
      && (model.latestProbe.profileId !== view.id || model.latestProbe.modelId !== model.id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["models", index, "latestProbe"],
        message: "Model probe evidence must belong to this model.",
      });
    }
  });
}

export const modelBackendProfileViewSchema =
  modelBackendProfileViewShape.strict().superRefine(validateViewProjection);

export const modelBackendProfileDetailSchema =
  modelBackendProfileViewShape.extend({
    baseUrl: baseUrlSchema.nullable(),
  }).strict().superRefine((profile, context) => {
    validateProfileRelationships(profile, context);
    validateViewProjection(profile, context);
  });

export const modelBackendDefaultSchema = z.object({
  scope: z.enum(["global", "project"]),
  projectId: z.string().uuid().nullable(),
  selection: modelSelectionSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.scope === "global") !== (value.projectId === null)) {
    context.addIssue({
      code: "custom",
      path: ["projectId"],
      message: "Global defaults cannot name a project; project defaults must name one.",
    });
  }
});

const customDraftShape = z.object({
  displayName: draftNameSchema,
  harnessId: z.enum(CURRENT_KNOWN_HARNESS_IDS),
  protocol: modelBackendProtocolSchema,
  authenticationMode: backendAuthenticationModeSchema,
  preset: z.literal("custom"),
  baseUrl: draftBaseUrlSchema,
  allowInsecureLocalhost: z.boolean(),
  allowPrivateNetwork: z.boolean().optional(),
  models: draftModelsSchema,
  routing: backendModelRoutingSchema,
  capabilityHints: capabilityHintsSchema,
  promptCacheTtl: promptCacheTtlSchema.optional(),
}).strict();

const presetDraftShape = z.object({
  preset: z.enum(API_KEY_BACKEND_PRESET_IDS),
  displayName: draftNameSchema.optional(),
  harnessId: z.enum(CURRENT_KNOWN_HARNESS_IDS).optional(),
  protocol: modelBackendProtocolSchema.optional(),
  authenticationMode: backendAuthenticationModeSchema.optional(),
  baseUrl: draftBaseUrlSchema.optional(),
  allowInsecureLocalhost: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  models: draftModelsSchema.optional(),
  routing: backendModelRoutingSchema.optional(),
  capabilityHints: capabilityHintsSchema.optional(),
  promptCacheTtl: promptCacheTtlSchema.optional(),
}).strict();

function validateCustomDraft(
  draft: z.infer<typeof customDraftShape>,
  context: z.RefinementCtx,
): void {
  if (draft.authenticationMode === "harness-managed") {
    context.addIssue({
      code: "custom",
      path: ["authenticationMode"],
      message: "Custom backends need an API key, a bearer token, or no authentication.",
    });
  } else if (
    draft.protocol === "anthropic-messages"
    && draft.authenticationMode === "none"
  ) {
    context.addIssue({
      code: "custom",
      path: ["authenticationMode"],
      message: UNAUTHENTICATED_CLAUDE_BACKEND_MESSAGE,
    });
  }
  validateProfileRelationships({
    id: "custom:validation",
    displayName: draft.displayName,
    harnessId: draft.harnessId,
    protocol: draft.protocol,
    authenticationMode: draft.authenticationMode,
    source: "custom",
    enabled: false,
    configurationRevision: 1,
    endpointIdentity: "validation",
    preset: draft.preset,
    baseUrl: draft.baseUrl,
    allowInsecureLocalhost: draft.allowInsecureLocalhost,
    allowPrivateNetwork: draft.allowPrivateNetwork ?? false,
    credentialGeneration: null,
    models: draft.models,
    routing: draft.routing,
    capabilityHints: draft.capabilityHints,
    promptCacheTtl: draft.promptCacheTtl,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }, context);
}

function validatePresetDraft(
  draft: z.infer<typeof presetDraftShape>,
  context: z.RefinementCtx,
): void {
  const preset = PRESET_CATALOGUE[draft.preset];
  validatePresetConnection(preset, draft, context);
  if (draft.routing) {
    validateRouting(
      draft.routing,
      new Set((draft.models ?? preset.defaultModels).map(({ id }) => id)),
      preset.protocol,
      context,
    );
  }
  if (draft.capabilityHints) validateUniqueCapabilityHints(draft.capabilityHints, context);
  validatePromptCacheTtl({
    promptCacheTtl: draft.promptCacheTtl,
    harnessId: draft.harnessId ?? preset.harnessId,
    protocol: draft.protocol ?? preset.protocol,
    preset: draft.preset,
  }, context);
}

export const modelBackendProfileDraftSchema = z.discriminatedUnion("preset", [
  customDraftShape,
  presetDraftShape,
]).superRefine((draft, context) => {
  if (draft.preset === "custom") validateCustomDraft(draft, context);
  else validatePresetDraft(draft, context);
});

export const modelBackendProfileUpdateSchema = z.object({
  displayName: draftNameSchema,
  harnessId: z.enum(CURRENT_KNOWN_HARNESS_IDS),
  protocol: modelBackendProtocolSchema,
  authenticationMode: backendAuthenticationModeSchema,
  preset: z.enum(MODEL_BACKEND_DRAFT_PRESETS),
  baseUrl: draftBaseUrlSchema,
  allowInsecureLocalhost: z.boolean(),
  allowPrivateNetwork: z.boolean(),
  models: draftModelsSchema,
  routing: backendModelRoutingSchema,
  capabilityHints: capabilityHintsSchema,
  promptCacheTtl: promptCacheTtlSchema.nullable(),
  enabled: z.boolean(),
}).partial().strict().superRefine((update, context) => {
  validatePromptCacheTtl({
    promptCacheTtl: update.promptCacheTtl ?? undefined,
    harnessId: update.harnessId ?? "claude-agent-sdk",
    protocol: update.protocol ?? "anthropic-messages",
    preset: update.preset ?? null,
  }, context);
});

export type ModelBackendProfileUpdate = z.infer<typeof modelBackendProfileUpdateSchema>;

export const modelBackendCredentialRevisionSchema = z.object({
  profileId: modelBackendProfileIdSchema,
  credentialGeneration: z.string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
}).strict();

export const modelBackendProfileProbeSchema = z.object({
  profileId: modelBackendProfileIdSchema,
  modelIds: z.array(modelIdSchema)
    .max(MAX_BACKEND_PROBE_MODELS)
    .refine((modelIds) => new Set(modelIds).size === modelIds.length, "Each model can be probed once per request.")
    .optional(),
}).strict();

export const backendProfileProbeSkippedModelIdsSchema = z.array(modelIdSchema)
  .max(MAX_BACKEND_PROBE_MODELS)
  .refine((modelIds) => new Set(modelIds).size === modelIds.length, "Each skipped model is listed once.");

export const modelBackendProfileDiscoverModelsSchema = z.object({
  profileId: modelBackendProfileIdSchema,
}).strict();

export const backendProfileModelsResultSchema = z.object({
  kind: z.literal("backend.profile.models"),
  profileId: modelBackendProfileIdSchema,
  models: z.array(z.object({
    id: modelIdSchema,
    displayName: labelSchema,
  }).strict())
    .max(MAX_DISCOVERED_BACKEND_MODELS)
    .refine(
      (models) => new Set(models.map(({ id }) => id)).size === models.length,
      "Discovered model IDs must be unique.",
    ),
}).strict();

export const modelBackendDefaultInputSchema = z.object({
  projectId: z.string().uuid().nullable(),
  selection: modelSelectionSchema,
}).strict();

export function safeEndpointHost(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return null;
  }
}

export function backendProfileUsesCredential(
  profile: Pick<ModelBackendProfile, "authenticationMode">,
): boolean {
  return profile.authenticationMode === "api-key"
    || profile.authenticationMode === "bearer-token";
}

export function redactBackendProfileForTransport(
  profile: PersistedModelBackendProfile,
): PersistedModelBackendProfile {
  return persistedModelBackendProfileSchema.parse(profile);
}

export function backendProfilePrimaryModel(
  profile: Pick<PersistedModelBackendProfile, "models" | "routing">,
): BackendModelDefinition {
  const model = profile.models.find(({ id }) => id === profile.routing.primaryModelId);
  if (!model) throw new Error("The backend profile primary model is unavailable.");
  return model;
}

export function modelSelectionForBackendProfile(
  profileInput: PersistedModelBackendProfile,
  modelId: string,
  reasoningEffort: string | null = null,
): ModelSelection {
  const profile = persistedModelBackendProfileSchema.parse(profileInput);
  const model = profile.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error("The selected model is unavailable on this backend.");
  return modelSelectionSchema.parse({
    harnessId: profile.harnessId,
    backendProfileId: profile.id,
    backendProfileDisplayName: profile.displayName,
    modelId: model.id,
    alias: model.displayName === model.id ? null : model.displayName,
    reasoningEffort,
    contextWindowOverride: model.contextWindowTokens,
    providerOptions: {},
    capabilities: model.capabilities,
    backendConfigurationRevision: profile.configurationRevision,
  });
}

/**
 * Defensive assertion used by persistence and transport tests. It catches
 * accidental contract expansion even when a value has not passed through
 * Zod yet.
 */
const SECRET_BEARING_KEYS = new Set([
  "secret",
  "secretreference",
  "secretvalue",
  "apikey",
  "authorization",
  "authorizationheader",
  "password",
  "credentialvalue",
  "token",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "cookie",
  "sessiontoken",
]);

export function containsBackendCredentialMaterial(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsBackendCredentialMaterial);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalizedKey = key.toLowerCase().replaceAll(/[-_.\s]/gu, "");
    return SECRET_BEARING_KEYS.has(normalizedKey)
      || containsBackendCredentialMaterial(child);
  });
}
