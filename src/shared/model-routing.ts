import { z } from "zod";

import type { ProviderId } from "./provider";

export const KNOWN_HARNESS_IDS = [
  "codex-app-server",
  "codex-cli",
  "claude-agent-sdk",
  "claude-cli",
  "cursor-acp",
  "cursor-cli",
  "kimi-acp",
  "opencode-sdk",
  "opencode-cli",
] as const;

export const CURRENT_KNOWN_HARNESS_IDS = [
  ...KNOWN_HARNESS_IDS,
  "gemini-acp",
] as const;

export type KnownHarnessId = (typeof CURRENT_KNOWN_HARNESS_IDS)[number];
/** Open persisted identity; unknown historical harnesses remain renderable. */
export type HarnessId = string;

export const MODEL_BACKEND_PROTOCOLS = [
  "openai-responses",
  "anthropic-messages",
  "cursor-managed",
  "gemini-managed",
  "kimi-managed",
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
  "responses-tools-unverified",
  "responses-probe-verified",
  "anthropic-probe-verified",
  "claude-provider-documented",
  "cursor-managed",
  "gemini-managed",
  "kimi-managed",
  "opencode-native-catalog",
] as const;

export type HarnessBackendCompatibilityReasonCode =
  (typeof HARNESS_BACKEND_COMPATIBILITY_REASON_CODES)[number];
export const harnessBackendCompatibilityReasonCodeSchema = z.enum(
  HARNESS_BACKEND_COMPATIBILITY_REASON_CODES,
);

export interface HarnessBackendCompatibilityEvidence {
  modelId?: string | null;
  probe?: HarnessBackendProbeEvidence | null;
  /** Deterministic evaluation seam; production callers use the current time. */
  evaluatedAt?: Date;
}

export const BACKEND_PROBE_AUTHORITY_SCHEMA_VERSION = 1;
export const BACKEND_PROBE_FRESHNESS_MS = 24 * 60 * 60 * 1_000;

export interface HarnessBackendProbeAuthority {
  schemaVersion: typeof BACKEND_PROBE_AUTHORITY_SCHEMA_VERSION;
  operationId: string;
  admissionSequence: number;
  /** Exact verified harness installation; null evidence cannot authorize a run. */
  installationFingerprint: string | null;
  expiresAt: string;
}

export interface HarnessBackendProbeEvidence {
  profileId: string;
  backendConfigurationRevision: number;
  endpointIdentity: string | null;
  protocol: ModelBackendProtocol;
  modelId: string;
  compatibility: "protocol-compatible" | "partially-compatible" | "unavailable";
  protocolVerified: boolean;
  modelVerified: boolean;
  capabilities: readonly ModelCapability[];
  failure: unknown | null;
  checkedAt?: string;
  authority?: HarnessBackendProbeAuthority;
}

export function backendProbeAuthorityIsCurrent(
  probe: Pick<HarnessBackendProbeEvidence, "checkedAt" | "authority">,
  evaluatedAt: Date = new Date(),
): boolean {
  const checkedAt = Date.parse(probe.checkedAt ?? "");
  const expiresAt = Date.parse(probe.authority?.expiresAt ?? "");
  const now = evaluatedAt.getTime();
  return probe.authority?.schemaVersion === BACKEND_PROBE_AUTHORITY_SCHEMA_VERSION
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(probe.authority.operationId)
    && Number.isSafeInteger(probe.authority.admissionSequence)
    && probe.authority.admissionSequence > 0
    && Number.isFinite(checkedAt)
    && Number.isFinite(expiresAt)
    && expiresAt > checkedAt
    && expiresAt - checkedAt <= BACKEND_PROBE_FRESHNESS_MS
    // A backward wall-clock jump fails closed instead of extending evidence.
    && now >= checkedAt
    && now < expiresAt;
}

function probeMatchesBackendRoute(
  probe: HarnessBackendProbeEvidence,
  profile: ModelBackendProfile,
  modelId: string,
  evaluatedAt?: Date,
): boolean {
  return probe.profileId === profile.id
    && probe.backendConfigurationRevision === profile.configurationRevision
    && probe.endpointIdentity === profile.endpointIdentity
    && probe.protocol === profile.protocol
    && probe.modelId === modelId
    && backendProbeAuthorityIsCurrent(probe, evaluatedAt);
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
  /**
   * Opaque server-generated digest binding the provider executable/version,
   * protocol revision, harness implementation and capability manifest. A
   * missing historical value is deliberately unverified and cannot authorize
   * reuse of provider-owned session state.
   */
  providerCompatibilityToken?: string | null;
  /** Missing historical values are equivalent to Standard provider speed. */
  performanceModeIdentity?: string | null;
}

export function fastModeProviderValue(
  selection: Pick<ModelSelection, "providerOptions">,
): string | null {
  const value = selection.providerOptions.fastMode;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function modelSelectionUsesFastMode(
  selection: Pick<ModelSelection, "providerOptions">,
): boolean {
  return fastModeProviderValue(selection) !== null;
}

export function routeSupportsNativeFastModeIdentity(
  route: Pick<ModelSelection, "harnessId" | "backendProfileId">,
): boolean {
  return (
    route.harnessId === "codex-app-server"
    && route.backendProfileId === "builtin:openai"
  ) || (
    route.harnessId === "claude-agent-sdk"
    && route.backendProfileId === "builtin:anthropic"
  );
}

export function withModelSelectionFastMode(
  selection: ModelSelection,
  providerValue: string | null,
): ModelSelection {
  const providerOptions = { ...selection.providerOptions };
  delete providerOptions.fastMode;
  if (providerValue !== null) {
    providerOptions.fastMode = providerValue;
  }
  return modelSelectionSchema.parse({ ...selection, providerOptions });
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
/** Current runtime schema; the legacy export remains pinned by migration lineage. */
export const currentKnownHarnessIdSchema = z.enum(CURRENT_KNOWN_HARNESS_IDS);
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
  performanceModeIdentity: z.enum(["fast:priority", "fast:fast"])
    .nullable()
    .optional(),
}).strict();

/**
 * Current continuation records add an installation/capability-bound token.
 * Keep the legacy schema above immutable because released migration 24 uses
 * it to decode historical rows; changing that implementation would rewrite
 * migration lineage for already-published databases.
 */
export const versionedContinuationIdentitySchema = continuationIdentitySchema
  .extend({
    providerCompatibilityToken: z.string().regex(/^[0-9a-f]{64}$/u)
      .nullable()
      .optional(),
  })
  .strict();

// @ts-expect-error New providers are appended below without rewriting this migration-pinned declaration.
const NATIVE_HARNESS: Readonly<Record<ProviderId, KnownHarnessId>> = {
  codex: "codex-app-server",
  claude: "claude-agent-sdk",
  cursor: "cursor-acp",
  kimi: "kimi-acp",
  opencode: "opencode-sdk",
};

// @ts-expect-error New providers are appended below without rewriting this migration-pinned declaration.
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
  kimi: {
    id: "builtin:kimi",
    displayName: "Kimi Code",
    protocol: "kimi-managed",
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

const CURRENT_NATIVE_HARNESS: Readonly<Record<ProviderId, KnownHarnessId>> = {
  ...NATIVE_HARNESS,
  gemini: "gemini-acp",
};

const CURRENT_NATIVE_BACKENDS: Readonly<Record<ProviderId, ModelBackendProfile>> = {
  ...NATIVE_BACKENDS,
  gemini: {
    id: "builtin:gemini",
    displayName: "Google Gemini",
    protocol: "gemini-managed",
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
  "gemini-acp": "gemini-managed",
  "kimi-acp": "kimi-managed",
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
  if (harnessId.startsWith("kimi-")) return "kimi";
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
 * Returns only capability evidence produced by the privileged compatibility
 * probe. User hints and partially compatible declarations are informative,
 * but cannot authorize an optional provider operation.
 */
export function modelSelectionHasVerifiedProbeCapability(
  selection: Pick<ModelSelection, "capabilities">,
  capabilityId: ModelCapabilityId,
): boolean {
  return selection.capabilities.some((capability) =>
    capability.id === capabilityId
    && capability.state === "verified"
    && capability.provenance === "probe");
}

/**
 * Current provider routing helpers live alongside the immutable declarations
 * used by released database migrations. New providers must extend these
 * companions instead of changing the pinned historical declarations above.
 */
export function providerNativeHarnessId(providerId: ProviderId): KnownHarnessId {
  return CURRENT_NATIVE_HARNESS[providerId];
}

export function providerNativeBackendProfile(
  providerId: ProviderId,
): ModelBackendProfile {
  return { ...CURRENT_NATIVE_BACKENDS[providerId] };
}

export function providerIdForHarness(harnessId: HarnessId): ProviderId | null {
  if (harnessId === "gemini-acp") return "gemini";
  return legacyProviderIdForHarness(harnessId);
}

export function providerNativeModelSelection(input: {
  providerId: ProviderId;
  modelId?: string | null;
  alias?: string | null;
  reasoningEffort?: string | null;
  contextWindowOverride?: number | null;
  providerOptions?: Readonly<Record<string, JsonValue>>;
  capabilities?: readonly ModelCapability[];
}): ModelSelection {
  const backend = providerNativeBackendProfile(input.providerId);
  return modelSelectionSchema.parse({
    harnessId: providerNativeHarnessId(input.providerId),
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
  const providerId = providerIdForHarness(harnessId);
  const native = providerId ? CURRENT_NATIVE_BACKENDS[providerId] : null;
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
    const geminiManaged = harnessId === "gemini-acp";
    const kimiManaged = harnessId === "kimi-acp";
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
        || harnessId === "gemini-acp"
        || harnessId === "kimi-acp"
        || harnessId === "opencode-sdk"
      ),
      reasonCode: cursorManaged
        ? "cursor-managed"
        : geminiManaged
          ? "gemini-managed"
        : kimiManaged
          ? "kimi-managed"
        : openCodeNative
          ? "opencode-native-catalog"
          : "native-backend",
      reason: cursorManaged
        ? "Cursor manages its backend; model selection is available only when ACP advertises it."
        : geminiManaged
          ? "Gemini CLI manages its backend; model selection follows the active ACP session."
        : kimiManaged
          ? "Kimi Code manages its backend; model and thinking selection follow the active ACP session."
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
    || harnessId === "gemini-acp"
    || harnessId === "kimi-acp"
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
        : harnessId.startsWith("gemini-")
          ? "gemini-managed"
        : harnessId.startsWith("kimi-")
          ? "kimi-managed"
        : "opencode-native-catalog",
      reason: harnessId.startsWith("cursor-")
        ? "Cursor controls its backend; Inertia does not inject external backend profiles."
        : harnessId.startsWith("gemini-")
          ? "Gemini CLI controls its backend; Inertia does not inject external backend profiles."
        : harnessId.startsWith("kimi-")
          ? "Kimi Code controls its backend; Inertia does not inject external backend profiles."
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
  if (!probeMatchesBackendRoute(
    evidence.probe,
    profile,
    modelId,
    evidence.evaluatedAt,
  )) {
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
  const toolsVerified = evidence.probe.capabilities.some((capability) => (
    capability.id === "tools"
    && capability.state === "verified"
    && capability.provenance === "probe"
  ));
  if (harnessId === "codex-app-server" && !toolsVerified) {
    return {
      harnessId,
      backendProfileId: profile.id,
      backendProtocol: profile.protocol,
      state: "unavailable",
      provenance: "probe",
      allowsModelSwitchWithinSession: false,
      reasonCode: "responses-tools-unverified",
      reason: "Codex requires this Responses backend to pass the inert tool-call compatibility check.",
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
  const fastMode = fastModeProviderValue(selection);
  return continuationIdentitySchema.parse({
    harnessId: selection.harnessId,
    backendProfileId: selection.backendProfileId,
    backendConfigurationRevision: selection.backendConfigurationRevision,
    modelIdentity: modelIdentityRequired ? selection.modelId : null,
    endpointIdentity,
    ...(fastMode ? { performanceModeIdentity: `fast:${fastMode}` } : {}),
  });
}

export function versionedContinuationIdentityForSelection(
  selection: ModelSelection,
  endpointIdentity: string | null,
  modelIdentityRequired: boolean,
  providerCompatibilityToken: string | null,
): ContinuationIdentity {
  return versionedContinuationIdentitySchema.parse({
    ...continuationIdentityForSelection(
      selection,
      endpointIdentity,
      modelIdentityRequired,
    ),
    ...(providerCompatibilityToken ? { providerCompatibilityToken } : {}),
  });
}

export function sameContinuationIdentity(
  left: ContinuationIdentity | null,
  right: ContinuationIdentity | null,
): boolean {
  return left !== null
    && right !== null
    && typeof left.providerCompatibilityToken === "string"
    && typeof right.providerCompatibilityToken === "string"
    && left.harnessId === right.harnessId
    && left.backendProfileId === right.backendProfileId
    && left.backendConfigurationRevision === right.backendConfigurationRevision
    && left.modelIdentity === right.modelIdentity
    && left.endpointIdentity === right.endpointIdentity
    && left.providerCompatibilityToken === right.providerCompatibilityToken
    && (left.performanceModeIdentity ?? null)
      === (right.performanceModeIdentity ?? null);
}
