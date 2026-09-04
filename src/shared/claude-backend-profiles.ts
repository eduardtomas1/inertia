import { z } from "zod";

import {
  backendEndpointIdentity,
  backendEndpointIdentityMatches,
} from "./backend-endpoint-identity";

import {
  type BackendAuthenticationMode,
  type HarnessBackendCompatibility,
  type HarnessBackendCompatibilityEvidence,
  type KnownHarnessId,
  type ModelBackendProfile,
  type ModelCapability,
  type ModelCapabilityProvenance,
  type ModelCapabilityState,
  type ModelSelection,
  modelBackendProfileSchema,
  modelCapabilitySchema,
  modelSelectionSchema,
  providerNativeBackendProfile,
  resolveHarnessBackendCompatibility,
} from "./model-routing";

export const CLAUDE_BACKEND_PROFILE_SCHEMA_VERSION = 1 as const;
export const NATIVE_ANTHROPIC_PROFILE_ID = "builtin:anthropic";
export const KIMI_CLAUDE_BUILTIN_PROFILE_ID = "builtin:kimi-code";
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/";
export const KIMI_CLAUDE_ENDPOINT_IDENTITY = "kimi-code:anthropic-messages-v1";

export const CLAUDE_INTERNAL_TIER_IDS = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
] as const;

export type ClaudeInternalTierId = (typeof CLAUDE_INTERNAL_TIER_IDS)[number];

export const CLAUDE_EFFORT_LEVELS = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export const KIMI_CODING_MODEL_IDS = [
  "k3",
  "k3-256k",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
] as const;

export type KimiCodingModelId = (typeof KIMI_CODING_MODEL_IDS)[number];
export type ClaudeBackendPreset = "anthropic" | "kimi-code" | "custom";

export interface ClaudeSimpleModelRouting {
  mode: "simple";
}

export interface ClaudeAdvancedModelRouting {
  mode: "advanced";
  tierModels: Readonly<Record<ClaudeInternalTierId, string>>;
  subagentModelId: string;
}

export type ClaudeModelRouting =
  | ClaudeSimpleModelRouting
  | ClaudeAdvancedModelRouting;

/**
 * Claude Code does not currently document a separate compaction-model
 * override. Keep that absence explicit so a profile cannot imply that a
 * separately selected model is being used.
 */
export interface ClaudeCompactionModelUnavailable {
  state: "unavailable";
  modelId: null;
  provenance: "harness";
  detail: string;
}

/**
 * Backend-specific process controls are deliberately typed. Arbitrary
 * environment keys could override credentials, hooks, executable lookup, or
 * unrelated harness policy and therefore do not belong in a profile.
 */
export interface ClaudeBackendRuntimeOptions {
  enableToolSearch: boolean;
  alwaysEnableEffort: boolean;
  enableThirdPartyStreamWatchdog: boolean;
  applyVendorContextTokenOverride: boolean;
}

export interface ClaudeCompatibleBackendProfile extends ModelBackendProfile {
  schemaVersion: typeof CLAUDE_BACKEND_PROFILE_SCHEMA_VERSION;
  preset: ClaudeBackendPreset;
  baseUrl: string | null;
  /** Explicit local-development exception retained through launch admission. */
  allowInsecureLocalhost: boolean;
  /**
   * Opaque privileged-store lookup only. Secret values never belong here.
   * Task 21 owns materializing this reference.
   */
  secretReference: string | null;
  primaryModelId: string;
  routing: ClaudeModelRouting;
  compactionModel: ClaudeCompactionModelUnavailable;
  contextWindowTokens: number | null;
  contextWindowProvenance: ModelCapabilityProvenance;
  autoCompactionWindowTokens: number | null;
  autoCompactionThresholdPercent: number | null;
  effortLevelMapping: Readonly<Record<ClaudeEffortLevel, ClaudeEffortLevel>>;
  runtimeOptions: ClaudeBackendRuntimeOptions;
  capabilityOverrides: readonly ModelCapability[];
}

export interface ResolvedClaudeModelRouting {
  primaryModelId: string;
  tierModels: Readonly<Record<ClaudeInternalTierId, string>>;
  subagentModelId: string;
  compactionModel: ClaudeCompactionModelUnavailable;
}

export interface KimiCodingModelDefinition {
  id: KimiCodingModelId;
  displayName: string;
  supportedContextWindows: readonly number[];
}

export const KIMI_CODING_MODELS: readonly KimiCodingModelDefinition[] = [
  {
    id: "k3",
    displayName: "K3",
    supportedContextWindows: [262_144, 1_048_576],
  },
  {
    id: "k3-256k",
    displayName: "K3 256K",
    supportedContextWindows: [262_144],
  },
  {
    id: "kimi-for-coding",
    displayName: "Kimi for Coding",
    supportedContextWindows: [262_144],
  },
  {
    id: "kimi-for-coding-highspeed",
    displayName: "Kimi for Coding High-speed",
    supportedContextWindows: [262_144],
  },
] as const;

export function kimiCodingModelDisplayName(modelId: string): string {
  return KIMI_CODING_MODELS.find((model) => model.id === modelId)?.displayName
    ?? modelId;
}

export function isKimiThroughClaudeSelection(selection: ModelSelection): boolean {
  return (
    (selection.harnessId === "claude-agent-sdk" || selection.harnessId === "claude-cli")
    && selection.backendProfileDisplayName === "Kimi"
    && isKimiCodingModelId(selection.modelId)
  );
}

/**
 * Historical identity label built only from the persisted selection. It
 * deliberately does not consult the current profile registry, so deleting or
 * renaming a profile cannot rewrite an old turn's visible identity.
 */
export function modelSelectionIdentityLabel(selection: ModelSelection): string {
  const harness = selection.harnessId === "claude-agent-sdk"
    || selection.harnessId === "claude-cli"
    ? "Claude harness"
    : `${selection.harnessId} harness`;
  const model = isKimiCodingModelId(selection.modelId)
    ? kimiCodingModelDisplayName(selection.modelId)
    : selection.alias ?? (
        selection.modelId === "provider-default"
          ? "Provider default"
          : selection.modelId
      );
  return `${harness} · ${selection.backendProfileDisplayName} · ${model}`;
}

const modelIdSchema = z.string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !/[\0\r\n]/u.test(value), "Model IDs cannot contain control characters.");
const backendSecretReferenceSchema = z.string()
  .min(8)
  .max(200)
  .regex(
    /^secret:[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    "Secret references must be opaque identifiers beginning with 'secret:'.",
  );
const contextWindowSchema = z.number().int().min(8_192).max(4_194_304);
const tierModelsSchema = z.object({
  fable: modelIdSchema,
  opus: modelIdSchema,
  sonnet: modelIdSchema,
  haiku: modelIdSchema,
}).strict();
const effortMappingSchema = z.object({
  auto: z.enum(CLAUDE_EFFORT_LEVELS),
  low: z.enum(CLAUDE_EFFORT_LEVELS),
  medium: z.enum(CLAUDE_EFFORT_LEVELS),
  high: z.enum(CLAUDE_EFFORT_LEVELS),
  xhigh: z.enum(CLAUDE_EFFORT_LEVELS),
  max: z.enum(CLAUDE_EFFORT_LEVELS),
}).strict();
const runtimeOptionsSchema = z.object({
  enableToolSearch: z.boolean(),
  alwaysEnableEffort: z.boolean(),
  enableThirdPartyStreamWatchdog: z.boolean(),
  applyVendorContextTokenOverride: z.boolean(),
}).strict();
const compactionModelSchema = z.object({
  state: z.literal("unavailable"),
  modelId: z.null(),
  provenance: z.literal("harness"),
  detail: z.string().min(1).max(500),
}).strict();

const claudeProfileShape = modelBackendProfileSchema.extend({
  schemaVersion: z.literal(CLAUDE_BACKEND_PROFILE_SCHEMA_VERSION),
  preset: z.enum(["anthropic", "kimi-code", "custom"]),
  baseUrl: z.string().url().max(2_048).nullable(),
  allowInsecureLocalhost: z.boolean().default(false),
  secretReference: backendSecretReferenceSchema.nullable(),
  primaryModelId: modelIdSchema,
  routing: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("simple") }).strict(),
    z.object({
      mode: z.literal("advanced"),
      tierModels: tierModelsSchema,
      subagentModelId: modelIdSchema,
    }).strict(),
  ]),
  compactionModel: compactionModelSchema,
  contextWindowTokens: contextWindowSchema.nullable(),
  contextWindowProvenance: z.enum([
    "provider",
    "harness",
    "probe",
    "user",
    "built-in",
    "unknown",
  ]),
  autoCompactionWindowTokens: contextWindowSchema.nullable(),
  autoCompactionThresholdPercent: z.number().int().min(1).max(100).nullable(),
  effortLevelMapping: effortMappingSchema,
  runtimeOptions: runtimeOptionsSchema,
  capabilityOverrides: z.array(modelCapabilitySchema).max(32),
});

export function isKimiCodingModelId(value: string): value is KimiCodingModelId {
  return (KIMI_CODING_MODEL_IDS as readonly string[]).includes(value);
}

export function kimiModelSupportsContextWindow(
  modelId: string,
  contextWindowTokens: number | null,
): boolean {
  if (!isKimiCodingModelId(modelId) || contextWindowTokens === null) return false;
  return KIMI_CODING_MODELS
    .find((model) => model.id === modelId)
    ?.supportedContextWindows.includes(contextWindowTokens) === true;
}

function modelIdsForProfile(profile: {
  primaryModelId: string;
  routing: ClaudeModelRouting;
}): string[] {
  if (profile.routing.mode === "simple") return [profile.primaryModelId];
  const routing = profile.routing;
  return [
    profile.primaryModelId,
    ...CLAUDE_INTERNAL_TIER_IDS.map((tier) => routing.tierModels[tier]),
    routing.subagentModelId,
  ];
}

export const claudeCompatibleBackendProfileSchema = claudeProfileShape.superRefine((profile, context) => {
  if (profile.protocol !== "anthropic-messages") {
    context.addIssue({
      code: "custom",
      path: ["protocol"],
      message: "Claude-compatible profiles must use the Anthropic Messages protocol.",
    });
  }
  if (
    profile.autoCompactionWindowTokens !== null
    && profile.contextWindowTokens !== null
    && profile.autoCompactionWindowTokens > profile.contextWindowTokens
  ) {
    context.addIssue({
      code: "custom",
      path: ["autoCompactionWindowTokens"],
      message: "The auto-compaction window cannot exceed the declared context window.",
    });
  }

  const capabilityIds = new Set<string>();
  for (const [index, capability] of profile.capabilityOverrides.entries()) {
    if (capabilityIds.has(capability.id)) {
      context.addIssue({
        code: "custom",
        path: ["capabilityOverrides", index, "id"],
        message: "Capability overrides must have unique IDs.",
      });
    }
    capabilityIds.add(capability.id);
  }

  if (profile.preset === "anthropic") {
    if (
      profile.id !== NATIVE_ANTHROPIC_PROFILE_ID
      || profile.source !== "built-in"
      || profile.authenticationMode !== "harness-managed"
      || profile.baseUrl !== null
      || profile.secretReference !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "The native Anthropic profile must use the built-in harness-managed connection.",
      });
    }
    return;
  }

  if (profile.baseUrl === null) {
    context.addIssue({
      code: "custom",
      path: ["baseUrl"],
      message: "A non-native Claude-compatible profile requires a base URL.",
    });
  }
  if (
    profile.source === "custom"
    && !backendEndpointIdentityMatches(profile.baseUrl, profile.endpointIdentity)
  ) {
    context.addIssue({
      code: "custom",
      path: ["endpointIdentity"],
      message: "Custom Claude endpoint identity must match its canonical URL.",
    });
  }
  if (profile.authenticationMode === "harness-managed") {
    context.addIssue({
      code: "custom",
      path: ["authenticationMode"],
      message: "Custom Claude-compatible profiles cannot use harness-managed authentication.",
    });
  }
  const needsSecret = profile.authenticationMode === "api-key"
    || profile.authenticationMode === "bearer-token";
  if (needsSecret !== (profile.secretReference !== null)) {
    context.addIssue({
      code: "custom",
      path: ["secretReference"],
      message: needsSecret
        ? "The selected authentication mode requires an opaque secret reference."
        : "A no-auth profile cannot retain a secret reference.",
    });
  }

  if (profile.preset === "kimi-code") {
    if (
      profile.source !== "built-in"
      || profile.authenticationMode !== "api-key"
      || profile.baseUrl !== KIMI_CODING_BASE_URL
      || profile.endpointIdentity !== KIMI_CLAUDE_ENDPOINT_IDENTITY
      || profile.allowInsecureLocalhost
    ) {
      context.addIssue({
        code: "custom",
        message: "The Kimi preset must use its verified coding endpoint and API-key authentication.",
      });
    }
    for (const modelId of modelIdsForProfile(profile)) {
      if (!isKimiCodingModelId(modelId)) {
        context.addIssue({
          code: "custom",
          path: ["primaryModelId"],
          message: "The Kimi preset accepts only current Kimi Code model IDs.",
        });
        break;
      }
    }
    if (!kimiModelSupportsContextWindow(profile.primaryModelId, profile.contextWindowTokens)) {
      context.addIssue({
        code: "custom",
        path: ["contextWindowTokens"],
        message: "The selected context window is not documented for this Kimi Code model.",
      });
    }
  }

  if (profile.preset === "custom") {
    if (profile.source !== "custom") {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "Generic endpoint profiles must be marked as custom.",
      });
    }
    for (const [index, capability] of profile.capabilityOverrides.entries()) {
      if (!["user", "probe", "unknown"].includes(capability.provenance)) {
        context.addIssue({
          code: "custom",
          path: ["capabilityOverrides", index, "provenance"],
          message: "Custom capability claims must be user-declared, probed, or unknown.",
        });
      }
    }
  }
});

const IDENTITY_EFFORT_MAPPING = Object.freeze({
  auto: "auto",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} satisfies Record<ClaudeEffortLevel, ClaudeEffortLevel>);

export const KIMI_EFFORT_LEVEL_MAPPING = Object.freeze({
  auto: "high",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} satisfies Record<ClaudeEffortLevel, ClaudeEffortLevel>);

export const KIMI_CLAUDE_REASONING_OPTIONS = [
  { value: "auto", label: "Auto", description: "Uses K3 high effort" },
  { value: "low", label: "Low", description: "Uses K3 low effort" },
  { value: "medium", label: "Medium", description: "Maps to K3 high effort" },
  { value: "high", label: "High", description: "Uses K3 high effort" },
  { value: "xhigh", label: "Extra high", description: "Maps to K3 max effort" },
  { value: "max", label: "Max", description: "Uses K3 max effort" },
] as const;

const COMPACTION_MODEL_UNAVAILABLE = Object.freeze({
  state: "unavailable",
  modelId: null,
  provenance: "harness",
  detail: "Claude Code does not document a separate compaction-model override.",
} satisfies ClaudeCompactionModelUnavailable);

function capability(
  id: ModelCapability["id"],
  state: ModelCapabilityState,
  provenance: ModelCapabilityProvenance,
  detail: string | null,
): ModelCapability {
  return { id, state, provenance, detail };
}

const NATIVE_ANTHROPIC_CAPABILITIES: readonly ModelCapability[] = [
  capability("streaming", "verified", "built-in", null),
  capability("tools", "verified", "built-in", null),
  capability("images", "verified", "built-in", null),
  capability("reasoning", "verified", "built-in", null),
  capability("prompt-caching", "verified", "built-in", null),
  capability("usage", "verified", "built-in", null),
  capability("subagents", "verified", "built-in", null),
  capability("compaction", "verified", "built-in", null),
  capability("web-fetch", "verified", "built-in", null),
  capability("tool-search", "verified", "built-in", null),
  capability("session-continuation", "verified", "built-in", null),
];

const KIMI_CAPABILITIES: readonly ModelCapability[] = [
  capability("streaming", "partially-compatible", "provider", "Documented through the Kimi Code Claude Code integration."),
  capability("tools", "partially-compatible", "provider", "Kimi documents Claude Code as a supported coding client; probing remains separate."),
  capability("reasoning", "verified", "provider", "Kimi documents Claude Code effort-level behavior for K3."),
  capability("subagents", "partially-compatible", "provider", "Kimi documents routing Claude Code subagents to Kimi models."),
  capability("compaction", "partially-compatible", "provider", "Kimi documents context and auto-compaction windows, but not a separate compaction model."),
  capability("images", "unknown", "unknown", null),
  capability("prompt-caching", "unknown", "unknown", null),
  capability("structured-output", "unavailable", "harness", "The current Inertia Claude harness does not request structured output."),
  capability("usage", "partially-compatible", "harness", "Turn token usage may be reported; native Anthropic quota and reset windows are unavailable."),
  capability("web-fetch", "unknown", "unknown", null),
  capability("tool-search", "unknown", "unknown", null),
  capability("session-continuation", "unknown", "unknown", null),
];

function defaultRuntimeOptions(preset: ClaudeBackendPreset): ClaudeBackendRuntimeOptions {
  return {
    enableToolSearch: preset === "anthropic",
    alwaysEnableEffort: preset === "kimi-code",
    enableThirdPartyStreamWatchdog: false,
    applyVendorContextTokenOverride: preset === "kimi-code",
  };
}

export function nativeAnthropicBackendProfile(): ClaudeCompatibleBackendProfile {
  const native = providerNativeBackendProfile("claude");
  return claudeCompatibleBackendProfileSchema.parse({
    ...native,
    schemaVersion: CLAUDE_BACKEND_PROFILE_SCHEMA_VERSION,
    preset: "anthropic",
    baseUrl: null,
    allowInsecureLocalhost: false,
    secretReference: null,
    primaryModelId: "provider-default",
    routing: { mode: "simple" },
    compactionModel: COMPACTION_MODEL_UNAVAILABLE,
    contextWindowTokens: null,
    contextWindowProvenance: "harness",
    autoCompactionWindowTokens: null,
    autoCompactionThresholdPercent: null,
    effortLevelMapping: IDENTITY_EFFORT_MAPPING,
    runtimeOptions: defaultRuntimeOptions("anthropic"),
    capabilityOverrides: NATIVE_ANTHROPIC_CAPABILITIES,
  });
}

export function modelBackendProfileForClaudeProfile(
  profileInput: ClaudeCompatibleBackendProfile,
): ModelBackendProfile {
  const profile = claudeCompatibleBackendProfileSchema.parse(profileInput);
  return modelBackendProfileSchema.parse({
    id: profile.id,
    displayName: profile.displayName,
    protocol: profile.protocol,
    authenticationMode: profile.authenticationMode,
    source: profile.source,
    enabled: profile.enabled,
    configurationRevision: profile.configurationRevision,
    endpointIdentity: profile.endpointIdentity,
  });
}

export function claudeHarnessBackendCompatibility(
  profileInput: ClaudeCompatibleBackendProfile,
  harnessId: Extract<KnownHarnessId, "claude-agent-sdk" | "claude-cli"> = "claude-agent-sdk",
  evidence: HarnessBackendCompatibilityEvidence = {},
): HarnessBackendCompatibility {
  const profile = claudeCompatibleBackendProfileSchema.parse(profileInput);
  const safeProfile = modelBackendProfileForClaudeProfile(profile);
  if (profile.preset === "anthropic") {
    return resolveHarnessBackendCompatibility(harnessId, safeProfile);
  }
  if (profile.preset === "kimi-code") {
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: "anthropic-messages",
      state: "partially-compatible",
      provenance: "built-in",
      allowsModelSwitchWithinSession: false,
      reasonCode: "claude-provider-documented",
      reason: "Kimi documents its Anthropic-compatible coding endpoint for Claude Code.",
    };
  }
  return resolveHarnessBackendCompatibility(harnessId, safeProfile, evidence);
}

export interface CreateKimiClaudeBackendProfileInput {
  id: string;
  displayName?: string;
  secretReference: string;
  primaryModelId: KimiCodingModelId;
  configurationRevision?: number;
  enabled?: boolean;
  contextWindowTokens?: number;
  autoCompactionThresholdPercent?: number | null;
  routing?: ClaudeModelRouting;
  runtimeOptions?: Partial<ClaudeBackendRuntimeOptions>;
}

export function createKimiClaudeBackendProfile(
  input: CreateKimiClaudeBackendProfileInput,
): ClaudeCompatibleBackendProfile {
  const contextWindowTokens = input.contextWindowTokens ?? 262_144;
  return claudeCompatibleBackendProfileSchema.parse({
    id: input.id,
    displayName: input.displayName ?? "Kimi",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "built-in",
    enabled: input.enabled ?? true,
    configurationRevision: input.configurationRevision ?? 1,
    endpointIdentity: KIMI_CLAUDE_ENDPOINT_IDENTITY,
    schemaVersion: CLAUDE_BACKEND_PROFILE_SCHEMA_VERSION,
    preset: "kimi-code",
    baseUrl: KIMI_CODING_BASE_URL,
    allowInsecureLocalhost: false,
    secretReference: input.secretReference,
    primaryModelId: input.primaryModelId,
    routing: input.routing ?? { mode: "simple" },
    compactionModel: COMPACTION_MODEL_UNAVAILABLE,
    contextWindowTokens,
    contextWindowProvenance: "provider",
    autoCompactionWindowTokens: contextWindowTokens,
    autoCompactionThresholdPercent: input.autoCompactionThresholdPercent ?? null,
    effortLevelMapping: KIMI_EFFORT_LEVEL_MAPPING,
    runtimeOptions: {
      ...defaultRuntimeOptions("kimi-code"),
      ...input.runtimeOptions,
    },
    capabilityOverrides: KIMI_CAPABILITIES,
  });
}

/**
 * Canonical safe desktop preset. The secret reference is derived and supplied
 * by the privileged main-process vault; no credential value enters this
 * profile or the runtime startup protocol.
 */
export function builtInKimiClaudeBackendProfile(
  secretReference: string,
): ClaudeCompatibleBackendProfile {
  return createKimiClaudeBackendProfile({
    id: KIMI_CLAUDE_BUILTIN_PROFILE_ID,
    secretReference,
    primaryModelId: "k3",
    contextWindowTokens: 1_048_576,
  });
}

export interface CreateKimiClaudeModelSelectionInput {
  profile: ClaudeCompatibleBackendProfile;
  modelId?: KimiCodingModelId;
  reasoningEffort?: ClaudeEffortLevel | null;
}

/**
 * Canonical safe selection for the verified Kimi-through-Claude route.
 * Process spelling such as `k3[1m]` is intentionally deferred to the
 * privileged launch adapter; persisted identity remains the API model `k3`.
 */
export function createKimiClaudeModelSelection(
  input: CreateKimiClaudeModelSelectionInput,
): ModelSelection {
  const profile = claudeCompatibleBackendProfileSchema.parse(input.profile);
  if (profile.preset !== "kimi-code") {
    throw new Error("A Kimi Claude selection requires the verified Kimi preset.");
  }
  const modelId = input.modelId ?? profile.primaryModelId;
  if (!isKimiCodingModelId(modelId)) {
    throw new Error("The selected Kimi coding model ID is not currently supported.");
  }
  if (!kimiModelSupportsContextWindow(modelId, profile.contextWindowTokens)) {
    throw new Error("The selected Kimi model does not support this profile's context window.");
  }
  return modelSelectionSchema.parse({
    harnessId: "claude-agent-sdk",
    backendProfileId: profile.id,
    backendProfileDisplayName: profile.displayName,
    modelId,
    alias: null,
    reasoningEffort: input.reasoningEffort === undefined
      ? "high"
      : input.reasoningEffort,
    contextWindowOverride: profile.contextWindowTokens,
    providerOptions: {},
    capabilities: profile.capabilityOverrides,
    backendConfigurationRevision: profile.configurationRevision,
  });
}

export function validateKimiClaudeModelSelection(
  profileInput: ClaudeCompatibleBackendProfile,
  selectionInput: ModelSelection,
): ModelSelection {
  const profile = claudeCompatibleBackendProfileSchema.parse(profileInput);
  const selection = modelSelectionSchema.parse(selectionInput);
  if (profile.preset !== "kimi-code") {
    throw new Error("The selected backend is not the verified Kimi preset.");
  }
  if (!isKimiCodingModelId(selection.modelId)) {
    throw new Error("The selected Kimi coding model ID is not currently supported.");
  }
  const effort = selection.reasoningEffort === null
    ? null
    : z.enum(CLAUDE_EFFORT_LEVELS).parse(selection.reasoningEffort);
  const canonical = createKimiClaudeModelSelection({
    profile,
    modelId: selection.modelId,
    reasoningEffort: effort,
  });
  if (
    selection.harnessId !== canonical.harnessId
    || selection.backendProfileId !== canonical.backendProfileId
    || selection.backendProfileDisplayName !== canonical.backendProfileDisplayName
    || selection.alias !== canonical.alias
    || selection.contextWindowOverride !== canonical.contextWindowOverride
    || selection.backendConfigurationRevision !== canonical.backendConfigurationRevision
    || JSON.stringify(selection.providerOptions) !== JSON.stringify(canonical.providerOptions)
    || JSON.stringify(selection.capabilities) !== JSON.stringify(canonical.capabilities)
  ) {
    throw new Error("The Kimi model selection does not match its configured backend profile.");
  }
  return selection;
}

export interface CreateCustomClaudeBackendProfileInput {
  id: string;
  displayName: string;
  baseUrl: string;
  authenticationMode: Exclude<BackendAuthenticationMode, "harness-managed">;
  secretReference: string | null;
  primaryModelId: string;
  configurationRevision?: number;
  enabled?: boolean;
  allowInsecureLocalhost?: boolean;
  routing?: ClaudeModelRouting;
  contextWindowTokens?: number | null;
  autoCompactionWindowTokens?: number | null;
  autoCompactionThresholdPercent?: number | null;
  effortLevelMapping?: Readonly<Record<ClaudeEffortLevel, ClaudeEffortLevel>>;
  runtimeOptions?: Partial<ClaudeBackendRuntimeOptions>;
  capabilityOverrides?: readonly ModelCapability[];
}

export function createCustomClaudeBackendProfile(
  input: CreateCustomClaudeBackendProfileInput,
): ClaudeCompatibleBackendProfile {
  const configurationRevision = input.configurationRevision ?? 1;
  const baseUrl = normalizeClaudeCompatibleBaseUrl(
    input.baseUrl,
    input.allowInsecureLocalhost ?? false,
  );
  return claudeCompatibleBackendProfileSchema.parse({
    id: input.id,
    displayName: input.displayName,
    protocol: "anthropic-messages",
    authenticationMode: input.authenticationMode,
    source: "custom",
    enabled: input.enabled ?? true,
    configurationRevision,
    endpointIdentity: backendEndpointIdentity(baseUrl),
    schemaVersion: CLAUDE_BACKEND_PROFILE_SCHEMA_VERSION,
    preset: "custom",
    baseUrl,
    allowInsecureLocalhost: input.allowInsecureLocalhost ?? false,
    secretReference: input.secretReference,
    primaryModelId: input.primaryModelId,
    routing: input.routing ?? { mode: "simple" },
    compactionModel: COMPACTION_MODEL_UNAVAILABLE,
    contextWindowTokens: input.contextWindowTokens ?? null,
    contextWindowProvenance: input.contextWindowTokens ? "user" : "unknown",
    autoCompactionWindowTokens: input.autoCompactionWindowTokens ?? null,
    autoCompactionThresholdPercent: input.autoCompactionThresholdPercent ?? null,
    effortLevelMapping: input.effortLevelMapping ?? IDENTITY_EFFORT_MAPPING,
    runtimeOptions: {
      ...defaultRuntimeOptions("custom"),
      ...input.runtimeOptions,
    },
    capabilityOverrides: input.capabilityOverrides ?? [],
  });
}

export function normalizeClaudeCompatibleBaseUrl(
  value: string,
  allowInsecureLocalhost = false,
): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The Claude-compatible endpoint URL is invalid.");
  }
  if (url.username || url.password) {
    throw new Error("The Claude-compatible endpoint URL cannot contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("The Claude-compatible endpoint URL cannot contain a query or fragment.");
  }
  const isLocalhost = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && isLocalhost && url.protocol === "http:")) {
    throw new Error("Claude-compatible endpoints require HTTPS.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url.toString();
}

export function safeClaudeBackendBaseUrl(
  profile: ClaudeCompatibleBackendProfile,
): string | null {
  if (profile.baseUrl === null) return null;
  const url = new URL(profile.baseUrl);
  return `${url.origin}${url.pathname}`;
}

export function resolveClaudeModelRouting(
  profile: ClaudeCompatibleBackendProfile,
  selectedModelId = profile.primaryModelId,
): ResolvedClaudeModelRouting {
  const primaryModelId = modelIdSchema.parse(selectedModelId);
  if (profile.routing.mode === "simple") {
    const tierModels = Object.fromEntries(
      CLAUDE_INTERNAL_TIER_IDS.map((tier) => [tier, primaryModelId]),
    ) as Record<ClaudeInternalTierId, string>;
    return {
      primaryModelId,
      tierModels,
      subagentModelId: primaryModelId,
      compactionModel: profile.compactionModel,
    };
  }
  return {
    primaryModelId,
    tierModels: { ...profile.routing.tierModels },
    subagentModelId: profile.routing.subagentModelId,
    compactionModel: profile.compactionModel,
  };
}

export function claudeCodeModelIdentifier(
  profile: ClaudeCompatibleBackendProfile,
  modelId: string,
): string {
  if (
    profile.preset === "kimi-code"
    && modelId === "k3"
    && profile.contextWindowTokens === 1_048_576
  ) {
    return "k3[1m]";
  }
  return modelId;
}

export function mappedClaudeEffortLevel(
  profile: ClaudeCompatibleBackendProfile,
  effort: string | null | undefined,
): ClaudeEffortLevel | null {
  if (!effort) return null;
  const parsed = z.enum(CLAUDE_EFFORT_LEVELS).safeParse(effort);
  if (!parsed.success) return null;
  return profile.effortLevelMapping[parsed.data];
}

interface LegacyClaudeBackendProfileV0 extends ModelBackendProfile {
  schemaVersion?: 0;
  preset: ClaudeBackendPreset;
  baseUrl: string | null;
  allowInsecureLocalhost?: boolean;
  secretReference: string | null;
  primaryModelId: string;
  routingMode?: "simple" | "advanced";
  tierModels?: Partial<Record<ClaudeInternalTierId, string>>;
  subagentModelId?: string;
  contextWindowTokens?: number | null;
  autoCompactionWindowTokens?: number | null;
  autoCompactionThresholdPercent?: number | null;
  effortLevelMapping?: Partial<Record<ClaudeEffortLevel, ClaudeEffortLevel>>;
  runtimeOptions?: Partial<ClaudeBackendRuntimeOptions>;
  capabilityOverrides?: readonly ModelCapability[];
}

function legacyProfileSchema(): z.ZodType<LegacyClaudeBackendProfileV0> {
  return modelBackendProfileSchema.extend({
    endpointIdentity: z.string().min(1).max(256).nullable().optional(),
    schemaVersion: z.literal(0).optional(),
    preset: z.enum(["anthropic", "kimi-code", "custom"]),
    baseUrl: z.string().url().max(2_048).nullable(),
    allowInsecureLocalhost: z.boolean().optional(),
    secretReference: backendSecretReferenceSchema.nullable(),
    primaryModelId: modelIdSchema,
    routingMode: z.enum(["simple", "advanced"]).optional(),
    tierModels: tierModelsSchema.partial().optional(),
    subagentModelId: modelIdSchema.optional(),
    contextWindowTokens: contextWindowSchema.nullable().optional(),
    autoCompactionWindowTokens: contextWindowSchema.nullable().optional(),
    autoCompactionThresholdPercent: z.number().int().min(1).max(100).nullable().optional(),
    effortLevelMapping: effortMappingSchema.partial().optional(),
    runtimeOptions: runtimeOptionsSchema.partial().optional(),
    capabilityOverrides: z.array(modelCapabilitySchema).max(32).optional(),
  }).strict() as z.ZodType<LegacyClaudeBackendProfileV0>;
}

/**
 * Upgrade the pre-schema draft shape without ever accepting inline API keys.
 * Missing advanced tiers are deliberately mapped to the visible primary
 * model so migration cannot leave an implicit native Anthropic fallback.
 */
export function migrateClaudeCompatibleBackendProfile(
  value: unknown,
): ClaudeCompatibleBackendProfile {
  const current = claudeCompatibleBackendProfileSchema.safeParse(value);
  if (current.success) return current.data;

  const legacy = legacyProfileSchema().parse(value);
  const routing: ClaudeModelRouting = legacy.routingMode === "advanced"
    ? {
        mode: "advanced",
        tierModels: Object.fromEntries(
          CLAUDE_INTERNAL_TIER_IDS.map((tier) => [
            tier,
            legacy.tierModels?.[tier] ?? legacy.primaryModelId,
          ]),
        ) as Record<ClaudeInternalTierId, string>,
        subagentModelId: legacy.subagentModelId ?? legacy.primaryModelId,
      }
    : { mode: "simple" };
  const effortLevelMapping = Object.fromEntries(
    CLAUDE_EFFORT_LEVELS.map((effort) => [
      effort,
      legacy.effortLevelMapping?.[effort] ?? (
        legacy.preset === "kimi-code"
          ? KIMI_EFFORT_LEVEL_MAPPING[effort]
          : IDENTITY_EFFORT_MAPPING[effort]
      ),
    ]),
  ) as Record<ClaudeEffortLevel, ClaudeEffortLevel>;
  const {
    routingMode: _routingMode,
    tierModels: _tierModels,
    subagentModelId: _subagentModelId,
    ...profileEnvelope
  } = legacy;

  return claudeCompatibleBackendProfileSchema.parse({
    ...profileEnvelope,
    schemaVersion: CLAUDE_BACKEND_PROFILE_SCHEMA_VERSION,
    configurationRevision: legacy.preset === "anthropic"
      ? legacy.configurationRevision
      : legacy.configurationRevision + 1,
    endpointIdentity: legacy.preset === "anthropic"
      ? null
      : legacy.preset === "kimi-code"
        ? KIMI_CLAUDE_ENDPOINT_IDENTITY
        : backendEndpointIdentity(legacy.baseUrl!),
    allowInsecureLocalhost: legacy.allowInsecureLocalhost ?? false,
    routing,
    compactionModel: COMPACTION_MODEL_UNAVAILABLE,
    contextWindowTokens: legacy.contextWindowTokens ?? null,
    contextWindowProvenance: legacy.preset === "kimi-code"
      ? "provider"
      : legacy.contextWindowTokens ? "user" : "unknown",
    autoCompactionWindowTokens: legacy.autoCompactionWindowTokens ?? null,
    autoCompactionThresholdPercent: legacy.autoCompactionThresholdPercent ?? null,
    effortLevelMapping,
    runtimeOptions: {
      ...defaultRuntimeOptions(legacy.preset),
      ...legacy.runtimeOptions,
    },
    capabilityOverrides: legacy.capabilityOverrides ?? (
      legacy.preset === "kimi-code"
        ? KIMI_CAPABILITIES
        : legacy.preset === "anthropic"
          ? NATIVE_ANTHROPIC_CAPABILITIES
          : []
    ),
  });
}
