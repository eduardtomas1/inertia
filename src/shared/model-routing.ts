import { z } from "zod";

import type { ProviderId } from "./contracts";
import type { BackendCompatibilityProbeResult } from "./backend-probe";

export const KNOWN_HARNESS_IDS = [
  "codex-app-server",
  "codex-cli",
  "claude-agent-sdk",
  "claude-cli",
  "cursor-acp",
  "cursor-cli",
  "opencode-sdk",
  "opencode-cli",
] as const;

export type KnownHarnessId = (typeof KNOWN_HARNESS_IDS)[number];
/** Open persisted identity; unknown historical harnesses remain renderable. */
export type HarnessId = string;

export const MODEL_BACKEND_PROTOCOLS = [
  "openai-responses",
  "anthropic-messages",
  "cursor-managed",
  "opencode-native",
] as const;

export type ModelBackendProtocol = (typeof MODEL_BACKEND_PROTOCOLS)[number];

export const BACKEND_AUTHENTICATION_MODES = [
  "harness-managed",
  "api-key",
  "bearer-token",
  "none",
] as const;

export type BackendAuthenticationMode = (typeof BACKEND_AUTHENTICATION_MODES)[number];

export const MODEL_CAPABILITY_IDS = [
  "streaming",
  "tools",
  "images",
  "reasoning",
  "prompt-caching",
  "structured-output",
  "usage",
  "subagents",
  "compaction",
  "web-fetch",
  "tool-search",
  "session-continuation",
] as const;

export type ModelCapabilityId = (typeof MODEL_CAPABILITY_IDS)[number];

export const MODEL_CAPABILITY_STATES = [
  "verified",
  "partially-compatible",
  "user-declared",
  "unavailable",
  "unknown",
] as const;

export type ModelCapabilityState = (typeof MODEL_CAPABILITY_STATES)[number];
export type ModelCapabilityProvenance =
  | "provider"
  | "harness"
  | "probe"
  | "user"
  | "built-in"
  | "unknown";

export interface ModelCapability {
  id: ModelCapabilityId;
  state: ModelCapabilityState;
  provenance: ModelCapabilityProvenance;
  detail: string | null;
}

export type ModelBackendProfileId = string;

/**
 * Safe backend metadata. Credentials and mutable endpoint configuration do
 * not belong in this contract or in historical turn snapshots.
 */
export interface ModelBackendProfile {
  id: ModelBackendProfileId;
  displayName: string;
  protocol: ModelBackendProtocol;
  authenticationMode: BackendAuthenticationMode;
  source: "built-in" | "custom";
  enabled: boolean;
  configurationRevision: number;
  /** Opaque non-secret identity used to invalidate session continuation. */
  endpointIdentity: string | null;
}

export interface HarnessBackendCompatibility {
  harnessId: HarnessId;
  backendProfileId: ModelBackendProfileId;
  backendProtocol: ModelBackendProtocol;
  state: ModelCapabilityState;
  provenance: "built-in" | "probe" | "user" | "unknown";
  allowsModelSwitchWithinSession: boolean;
  reasonCode: HarnessBackendCompatibilityReasonCode;
  reason: string;
}

export const HARNESS_BACKEND_COMPATIBILITY_REASON_CODES = [
  "native-backend",
  "profile-disabled",
  "protocol-mismatch",
  "probe-required",
  "probe-stale",
  "probe-failed",
  "probe-unverified",
  "responses-probe-verified",
  "anthropic-probe-verified",
  "claude-provider-documented",
  "cursor-managed",
  "opencode-native-catalog",
] as const;

export type HarnessBackendCompatibilityReasonCode =
  (typeof HARNESS_BACKEND_COMPATIBILITY_REASON_CODES)[number];
export const harnessBackendCompatibilityReasonCodeSchema = z.enum(
  HARNESS_BACKEND_COMPATIBILITY_REASON_CODES,
);

export interface HarnessBackendCompatibilityEvidence {
  modelId?: string | null;
  probe?: BackendCompatibilityProbeResult | null;
}

function probeMatchesBackendRoute(
  probe: BackendCompatibilityProbeResult,
  profile: ModelBackendProfile,
  modelId: string,
): boolean {
  return probe.profileId === profile.id
    && probe.backendConfigurationRevision === profile.configurationRevision
    && probe.endpointIdentity === profile.endpointIdentity
    && probe.protocol === profile.protocol
    && probe.modelId === modelId;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface ModelSelection {
  harnessId: HarnessId;
  backendProfileId: ModelBackendProfileId;
  /** Safe historical label retained even when the profile is later removed. */
  backendProfileDisplayName: string;
  modelId: string;
  alias: string | null;
  reasoningEffort: string | null;
  /** Present only when the value came from an authoritative source. */
  contextWindowOverride: number | null;
  providerOptions: Readonly<Record<string, JsonValue>>;
  capabilities: readonly ModelCapability[];
  backendConfigurationRevision: number;
}

/**
 * Provider sessions may resume only when this complete identity still
 * matches. Endpoint identity is an opaque, non-secret digest or stable id.
 */
export interface ContinuationIdentity {
  harnessId: HarnessId;
  backendProfileId: ModelBackendProfileId;
  backendConfigurationRevision: number;
  modelIdentity: string | null;
  endpointIdentity: string | null;
}

const boundedIdentitySchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z][A-Za-z0-9._:-]*$/u);
const opaqueIdentitySchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const boundedLabelSchema = z.string().min(1).max(200);
const boundedModelSchema = z.string().min(1).max(300);
const boundedOptionKeySchema = z.string().min(1).max(100);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(16_384),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema).max(100),
    z.record(boundedOptionKeySchema, jsonValueSchema),
  ]));

const SECRET_OPTION_KEY = /(^|[-_.])(api[-_.]?key|key|token|secret|password|authorization|credential|cookie|session)($|[-_.])/iu;

function containsSecretLikeOptionKey(value: JsonValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSecretLikeOptionKey);
  return Object.entries(value).some(
    ([key, child]) => SECRET_OPTION_KEY.test(key) || containsSecretLikeOptionKey(child),
  );
}

const safeProviderOptionsSchema = z.record(boundedOptionKeySchema, jsonValueSchema)
  .superRefine((value, context) => {
    if (containsSecretLikeOptionKey(value)) {
      context.addIssue({
        code: "custom",
        message: "Provider options cannot contain credentials or authentication material.",
      });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32_768) {
      context.addIssue({
        code: "custom",
        message: "Provider options cannot exceed 32768 bytes.",
      });
    }
  });

export const harnessIdSchema = boundedIdentitySchema;
export const knownHarnessIdSchema = z.enum(KNOWN_HARNESS_IDS);
export const modelBackendProfileIdSchema = boundedIdentitySchema;
export const modelBackendProtocolSchema = z.enum(MODEL_BACKEND_PROTOCOLS);
export const backendAuthenticationModeSchema = z.enum(BACKEND_AUTHENTICATION_MODES);
export const modelCapabilityStateSchema = z.enum(MODEL_CAPABILITY_STATES);

export const modelCapabilitySchema = z.object({
  id: z.enum(MODEL_CAPABILITY_IDS),
  state: modelCapabilityStateSchema,
  provenance: z.enum(["provider", "harness", "probe", "user", "built-in", "unknown"]),
  detail: z.string().max(1_000).nullable(),
}).strict();

export const modelBackendProfileSchema = z.object({
  id: modelBackendProfileIdSchema,
  displayName: boundedLabelSchema,
  protocol: modelBackendProtocolSchema,
  authenticationMode: backendAuthenticationModeSchema,
  source: z.enum(["built-in", "custom"]),
  enabled: z.boolean(),
  configurationRevision: z.number().int().nonnegative(),
  endpointIdentity: opaqueIdentitySchema.nullable(),
}).strict();

export const modelSelectionSchema = z.object({
  harnessId: harnessIdSchema,
  backendProfileId: modelBackendProfileIdSchema,
  backendProfileDisplayName: boundedLabelSchema,
  modelId: boundedModelSchema,
  alias: boundedModelSchema.nullable(),
  reasoningEffort: z.string().max(100).nullable(),
  contextWindowOverride: z.number().int().positive().max(100_000_000).nullable(),
  providerOptions: safeProviderOptionsSchema,
  capabilities: z.array(modelCapabilitySchema).max(MODEL_CAPABILITY_IDS.length),
  backendConfigurationRevision: z.number().int().nonnegative(),
}).strict();

export const continuationIdentitySchema = z.object({
  harnessId: harnessIdSchema,
  backendProfileId: modelBackendProfileIdSchema,
  backendConfigurationRevision: z.number().int().nonnegative(),
  modelIdentity: boundedModelSchema.nullable(),
  endpointIdentity: opaqueIdentitySchema.nullable(),
}).strict();

const NATIVE_HARNESS: Readonly<Record<ProviderId, KnownHarnessId>> = {
  codex: "codex-app-server",
  claude: "claude-agent-sdk",
  cursor: "cursor-acp",
  opencode: "opencode-sdk",
};

const NATIVE_BACKENDS: Readonly<Record<ProviderId, ModelBackendProfile>> = {
  codex: {
    id: "builtin:openai",
    displayName: "OpenAI",
    protocol: "openai-responses",
    authenticationMode: "harness-managed",
    source: "built-in",
    enabled: true,
    configurationRevision: 0,
    endpointIdentity: null,
  },
  claude: {
    id: "builtin:anthropic",
    displayName: "Anthropic",
    protocol: "anthropic-messages",
    authenticationMode: "harness-managed",
    source: "built-in",
    enabled: true,
    configurationRevision: 0,
    endpointIdentity: null,
  },
  cursor: {
    id: "builtin:cursor",
    displayName: "Cursor",
    protocol: "cursor-managed",
    authenticationMode: "harness-managed",
    source: "built-in",
    enabled: true,
    configurationRevision: 0,
    endpointIdentity: null,
  },
  opencode: {
    id: "builtin:opencode",
    displayName: "OpenCode",
    protocol: "opencode-native",
    authenticationMode: "harness-managed",
    source: "built-in",
    enabled: true,
    configurationRevision: 0,
    endpointIdentity: null,
  },
};

const EXPECTED_PROTOCOL: Readonly<Partial<Record<KnownHarnessId, ModelBackendProtocol>>> = {
  "codex-app-server": "openai-responses",
  "codex-cli": "openai-responses",
  "claude-agent-sdk": "anthropic-messages",
  "claude-cli": "anthropic-messages",
  "cursor-acp": "cursor-managed",
  "cursor-cli": "cursor-managed",
  "opencode-sdk": "opencode-native",
  "opencode-cli": "opencode-native",
};

export function nativeHarnessId(providerId: ProviderId): KnownHarnessId {
  return NATIVE_HARNESS[providerId];
}

export function nativeBackendProfile(providerId: ProviderId): ModelBackendProfile {
  return { ...NATIVE_BACKENDS[providerId] };
}

export function legacyProviderIdForHarness(harnessId: HarnessId): ProviderId | null {
  if (harnessId.startsWith("codex-")) return "codex";
  if (harnessId.startsWith("claude-")) return "claude";
  if (harnessId.startsWith("cursor-")) return "cursor";
  if (harnessId.startsWith("opencode-")) return "opencode";
  return null;
}

export function nativeModelSelection(input: {
  providerId: ProviderId;
  modelId?: string | null;
  alias?: string | null;
  reasoningEffort?: string | null;
  contextWindowOverride?: number | null;
  providerOptions?: Readonly<Record<string, JsonValue>>;
  capabilities?: readonly ModelCapability[];
}): ModelSelection {
  const backend = nativeBackendProfile(input.providerId);
  return modelSelectionSchema.parse({
    harnessId: nativeHarnessId(input.providerId),
    backendProfileId: backend.id,
    backendProfileDisplayName: backend.displayName,
    modelId: input.modelId || "provider-default",
    alias: input.alias || null,
    reasoningEffort: input.reasoningEffort || null,
    contextWindowOverride: input.contextWindowOverride ?? null,
    providerOptions: input.providerOptions ?? {},
    capabilities: input.capabilities ?? [],
    backendConfigurationRevision: backend.configurationRevision,
  });
}

/**
 * Built-in pairs are verified. A matching protocol on a custom profile is
 * unknown until Task 23 probes it. Every other pair is unavailable.
 */
export function resolveHarnessBackendCompatibility(
  harnessId: KnownHarnessId,
  profile: ModelBackendProfile,
  evidence: HarnessBackendCompatibilityEvidence = {},
): HarnessBackendCompatibility {
  const providerId = legacyProviderIdForHarness(harnessId);
  const native = providerId ? NATIVE_BACKENDS[providerId] : null;
  const expected = EXPECTED_PROTOCOL[harnessId];
  if (!profile.enabled) {
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: profile.protocol,
      state: "unavailable",
      provenance: "built-in",
      allowsModelSwitchWithinSession: false,
      reasonCode: "profile-disabled",
      reason: "This backend profile is disabled.",
    };
  }
  if (native && profile.id === native.id && profile.protocol === native.protocol) {
    const cursorManaged = harnessId === "cursor-acp" || harnessId === "cursor-cli";
    const openCodeNative = harnessId === "opencode-sdk" || harnessId === "opencode-cli";
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: profile.protocol,
      state: "verified",
      provenance: "built-in",
      allowsModelSwitchWithinSession: (
        harnessId === "codex-app-server"
        || harnessId === "claude-agent-sdk"
        || harnessId === "opencode-sdk"
      ),
      reasonCode: cursorManaged
        ? "cursor-managed"
        : openCodeNative
          ? "opencode-native-catalog"
          : "native-backend",
      reason: cursorManaged
        ? "Cursor manages its backend; model selection is available only when ACP advertises it."
        : openCodeNative
          ? "OpenCode provides its native provider and model catalog."
          : "Built-in native harness and backend pairing.",
    };
  }
  if (expected !== profile.protocol) {
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: profile.protocol,
      state: "unavailable",
      provenance: "built-in",
      allowsModelSwitchWithinSession: false,
      reasonCode: "protocol-mismatch",
      reason: "This harness does not support the selected backend protocol.",
    };
  }

  if (
    harnessId === "cursor-acp"
    || harnessId === "cursor-cli"
    || harnessId === "opencode-sdk"
    || harnessId === "opencode-cli"
  ) {
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: profile.protocol,
      state: "unavailable",
      provenance: "built-in",
      allowsModelSwitchWithinSession: false,
      reasonCode: harnessId.startsWith("cursor-")
        ? "cursor-managed"
        : "opencode-native-catalog",
      reason: harnessId.startsWith("cursor-")
        ? "Cursor controls its backend; Inertia does not inject external backend profiles."
        : "Select a provider and model from OpenCode's native catalog.",
    };
  }

  if (harnessId === "codex-cli" || harnessId === "claude-cli") {
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: profile.protocol,
      state: "unavailable",
      provenance: "built-in",
      allowsModelSwitchWithinSession: false,
      reasonCode: "protocol-mismatch",
      reason: "Custom backends require the provider's native rich harness.",
    };
  }

  const modelId = evidence.modelId?.trim();
  if (!modelId || !evidence.probe) {
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: profile.protocol,
      state: "unknown",
      provenance: "unknown",
      allowsModelSwitchWithinSession: false,
      reasonCode: "probe-required",
      reason: harnessId === "codex-app-server"
        ? "Verify this backend's Responses API and selected model before using it with Codex."
        : "Verify this backend's Anthropic Messages API and selected model before using it with Claude.",
    };
  }
  if (!probeMatchesBackendRoute(evidence.probe, profile, modelId)) {
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: profile.protocol,
      state: "unknown",
      provenance: "unknown",
      allowsModelSwitchWithinSession: false,
      reasonCode: "probe-stale",
      reason: "Compatibility evidence no longer matches this backend configuration and model.",
    };
  }
  if (evidence.probe.failure) {
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: profile.protocol,
      state: "unavailable",
      provenance: "probe",
      allowsModelSwitchWithinSession: false,
      reasonCode: "probe-failed",
      reason: "The latest compatibility check did not succeed.",
    };
  }
  if (
    !evidence.probe.protocolVerified
    || !evidence.probe.modelVerified
    || evidence.probe.compatibility === "unavailable"
  ) {
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: profile.protocol,
      state: "unavailable",
      provenance: "probe",
      allowsModelSwitchWithinSession: false,
      reasonCode: "probe-unverified",
      reason: "The selected protocol and model were not both verified.",
    };
  }
  return {
    harnessId,
    backendProfileId: profile.id,
    backendProtocol: profile.protocol,
    // A text probe verifies routing, not every provider-specific Codex or
    // Claude capability. Keep the richer harness contract honest.
    state: "partially-compatible",
    provenance: "probe",
    allowsModelSwitchWithinSession: false,
    reasonCode: harnessId === "codex-app-server"
      ? "responses-probe-verified"
      : "anthropic-probe-verified",
    reason: harnessId === "codex-app-server"
      ? "The Responses API and selected model were verified; provider-specific features may vary."
      : "The Anthropic Messages API and selected model were verified; provider-specific features may vary.",
  };
}

export function continuationIdentityForSelection(
  selection: ModelSelection,
  endpointIdentity: string | null = null,
  modelIdentityRequired = true,
): ContinuationIdentity {
  return continuationIdentitySchema.parse({
    harnessId: selection.harnessId,
    backendProfileId: selection.backendProfileId,
    backendConfigurationRevision: selection.backendConfigurationRevision,
    modelIdentity: modelIdentityRequired ? selection.modelId : null,
    endpointIdentity,
  });
}

export function sameContinuationIdentity(
  left: ContinuationIdentity | null,
  right: ContinuationIdentity | null,
): boolean {
  return left !== null
    && right !== null
    && left.harnessId === right.harnessId
    && left.backendProfileId === right.backendProfileId
    && left.backendConfigurationRevision === right.backendConfigurationRevision
    && left.modelIdentity === right.modelIdentity
    && left.endpointIdentity === right.endpointIdentity;
}
