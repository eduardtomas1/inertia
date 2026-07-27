import { z } from "zod";

import {
  backendCompatibilityProbeResultSchema,
  type BackendCompatibilityProbeResult,
} from "./backend-probe";
import {
  KNOWN_HARNESS_IDS,
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
  type HarnessBackendCompatibility,
  type KnownHarnessId,
  type ModelBackendProfile,
  type ModelCapability,
  type ModelSelection,
} from "./model-routing";

export const MODEL_BACKEND_PROFILE_PRESETS = [
  "native",
  "kimi-code",
  "custom",
] as const;

export type ModelBackendProfilePreset =
  (typeof MODEL_BACKEND_PROFILE_PRESETS)[number];

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

export const CLAUDE_BACKEND_TIER_IDS = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
] as const;

export type ClaudeBackendTierId = (typeof CLAUDE_BACKEND_TIER_IDS)[number];

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
  credentialGeneration: string | null;
  models: readonly BackendModelDefinition[];
  routing: BackendModelRouting;
  capabilityHints: readonly ModelCapability[];
  createdAt: string;
  updatedAt: string;
}

export interface ModelBackendProfileView
  extends Omit<PersistedModelBackendProfile, "baseUrl"> {
  endpointHost: string | null;
  authState: ModelBackendAuthState;
  connectionState: ModelBackendConnectionState;
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
  preset: Exclude<ModelBackendProfilePreset, "native">;
  baseUrl: string;
  allowInsecureLocalhost: boolean;
  models: readonly BackendModelDefinition[];
  routing: BackendModelRouting;
  capabilityHints: readonly ModelCapability[];
}

const labelSchema = z.string().trim().min(1).max(200)
  .refine((value) => !/[\0\r\n]/u.test(value), "Labels cannot contain control characters.");
const modelIdSchema = z.string().trim().min(1).max(500)
  .refine((value) => !/[\0\r\n]/u.test(value), "Model IDs cannot contain control characters.");
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

export const backendReasoningOptionSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: labelSchema,
  description: z.string().trim().max(500),
}).strict();

export const backendModelDefinitionSchema = z.object({
  id: modelIdSchema,
  displayName: labelSchema,
  contextWindowTokens: z.number().int().min(8_192).max(100_000_000).nullable(),
  reasoningOptions: z.array(backendReasoningOptionSchema).max(32),
  capabilities: z.array(modelCapabilitySchema).max(MODEL_CAPABILITY_IDS.length),
}).strict().superRefine((model, context) => {
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

const persistedModelBackendProfileShape = modelBackendProfileSchema.extend({
  harnessId: z.enum(KNOWN_HARNESS_IDS),
  preset: z.enum(MODEL_BACKEND_PROFILE_PRESETS),
  baseUrl: baseUrlSchema.nullable(),
  allowInsecureLocalhost: z.boolean(),
  credentialGeneration: z.string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
    .nullable(),
  models: z.array(backendModelDefinitionSchema).min(1).max(128),
  routing: backendModelRoutingSchema,
  capabilityHints: z.array(modelCapabilitySchema).max(MODEL_CAPABILITY_IDS.length),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

function validateProfileRelationships(
  profile: z.infer<typeof persistedModelBackendProfileShape>,
  context: z.RefinementCtx,
): void {
  const modelIds = new Set(profile.models.map(({ id }) => id));
  const routedModels = profile.routing.mode === "simple"
    ? [profile.routing.primaryModelId]
    : [
        profile.routing.primaryModelId,
        ...Object.values(profile.routing.tierModels),
        profile.routing.subagentModelId,
      ];
  for (const modelId of routedModels) {
    if (!modelIds.has(modelId)) {
      context.addIssue({
        code: "custom",
        path: ["routing"],
        message: `Routing references unknown model '${modelId}'.`,
      });
    }
  }
  if (modelIds.size !== profile.models.length) {
    context.addIssue({
      code: "custom",
      path: ["models"],
      message: "Model identifiers must be unique within a backend profile.",
    });
  }
  if (new Set(profile.capabilityHints.map(({ id }) => id)).size
    !== profile.capabilityHints.length) {
    context.addIssue({
      code: "custom",
      path: ["capabilityHints"],
      message: "Capability hint identifiers must be unique.",
    });
  }
  if (profile.source === "custom" && profile.preset !== "custom") {
    context.addIssue({
      code: "custom",
      path: ["preset"],
      message: "Custom sources require the Custom preset.",
    });
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
  if (
    profile.routing.mode === "advanced"
    && profile.protocol !== "anthropic-messages"
  ) {
    context.addIssue({
      code: "custom",
      path: ["routing"],
      message: "Advanced tier mappings are available only to Claude harness profiles.",
    });
  }
}

export const persistedModelBackendProfileSchema =
  persistedModelBackendProfileShape.strict().superRefine(validateProfileRelationships);

const modelBackendProfileViewShape =
  persistedModelBackendProfileShape.omit({ baseUrl: true }).extend({
    endpointHost: z.string().max(255).nullable(),
    authState: z.enum(MODEL_BACKEND_AUTH_STATES),
    connectionState: z.enum(MODEL_BACKEND_CONNECTION_STATES),
    compatibility: z.object({
      harnessId: harnessIdSchema,
      backendProfileId: modelBackendProfileIdSchema,
      backendProtocol: modelBackendProtocolSchema,
      state: z.enum(MODEL_CAPABILITY_STATES),
      provenance: z.enum(["built-in", "probe", "user", "unknown"]),
      allowsModelSwitchWithinSession: z.boolean(),
      reasonCode: z.enum(HARNESS_BACKEND_COMPATIBILITY_REASON_CODES),
      reason: z.string().min(1).max(1_000),
    }).strict(),
    latestProbe: backendCompatibilityProbeResultSchema.nullable(),
    canDelete: z.boolean(),
    canDisable: z.boolean(),
  });

export const modelBackendProfileViewSchema =
  modelBackendProfileViewShape.strict();

export const modelBackendProfileDetailSchema =
  modelBackendProfileViewShape.extend({
    baseUrl: baseUrlSchema.nullable(),
  }).strict().superRefine(validateProfileRelationships);

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

const draftShape = z.object({
  displayName: labelSchema,
  harnessId: z.enum(KNOWN_HARNESS_IDS),
  protocol: modelBackendProtocolSchema,
  authenticationMode: backendAuthenticationModeSchema,
  preset: z.enum(["kimi-code", "custom"]),
  baseUrl: baseUrlSchema,
  allowInsecureLocalhost: z.boolean(),
  models: z.array(backendModelDefinitionSchema).min(1).max(128),
  routing: backendModelRoutingSchema,
  capabilityHints: z.array(modelCapabilitySchema).max(MODEL_CAPABILITY_IDS.length),
}).strict();

export const modelBackendProfileDraftSchema = draftShape.superRefine((draft, context) => {
  validateProfileRelationships({
    id: "custom:validation",
    displayName: draft.displayName,
    harnessId: draft.harnessId,
    protocol: draft.protocol,
    authenticationMode: draft.authenticationMode,
    source: draft.preset === "custom" ? "custom" : "built-in",
    enabled: false,
    configurationRevision: 1,
    endpointIdentity: "validation",
    preset: draft.preset,
    baseUrl: draft.baseUrl,
    allowInsecureLocalhost: draft.allowInsecureLocalhost,
    credentialGeneration: null,
    models: draft.models,
    routing: draft.routing,
    capabilityHints: draft.capabilityHints,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }, context);
});

export const modelBackendProfileUpdateSchema = draftShape.partial().extend({
  enabled: z.boolean().optional(),
}).strict();

export const modelBackendCredentialRevisionSchema = z.object({
  profileId: modelBackendProfileIdSchema,
  credentialGeneration: z.string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
}).strict();

export const modelBackendProfileProbeSchema = z.object({
  profileId: modelBackendProfileIdSchema,
  modelId: modelIdSchema,
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
