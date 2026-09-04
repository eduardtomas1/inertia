import {
  backendProfilePrimaryModel,
  persistedModelBackendProfileSchema,
  type BackendModelDefinition,
  type ModelBackendProfileView,
  type PersistedModelBackendProfile,
} from "../../../shared/backend-profile-settings";
import {
  KIMI_CLAUDE_REASONING_OPTIONS,
  KIMI_CODING_MODELS,
  claudeCompatibleBackendProfileSchema,
  modelBackendProfileForClaudeProfile,
  type ClaudeCompatibleBackendProfile,
  type ClaudeModelRouting,
} from "../../../shared/claude-backend-profiles";
import type { BackendCompatibilityProbeResult } from "../../../shared/backend-probe";
import {
  modelBackendProfileSchema,
  nativeBackendProfile,
  nativeHarnessId,
  type HarnessBackendCompatibility,
  type ModelBackendProfile,
} from "../../../shared/model-routing";
import { backendEndpointIdentity } from "../../../shared/backend-endpoint-identity";
import type { ProviderId, ProviderInfo } from "../../../shared/contracts";
import type { StoredModelBackendProfile } from "../../database";
import { BackendProfileControllerError } from "./backend-profile-types";

const BUILT_IN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export const PROVIDER_IDS: readonly ProviderId[] = [
  "codex",
  "claude",
  "cursor",
  "kimi",
  "opencode",
];

export function normalizedBaseUrl(
  value: string,
  allowInsecureLocalhost: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BackendProfileControllerError("Enter a valid backend base URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const isLocalhost = hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1";
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (
      url.protocol !== "https:"
      && !(allowInsecureLocalhost && isLocalhost && url.protocol === "http:")
    )
  ) {
    throw new BackendProfileControllerError(
      allowInsecureLocalhost
        ? "Backend URLs must use HTTPS, except explicit localhost HTTP."
        : "Backend URLs must use HTTPS and cannot contain credentials.",
    );
  }
  return url.toString().replace(/\/$/u, "");
}

export function endpointIdentity(baseUrl: string): string {
  return backendEndpointIdentity(baseUrl);
}

function nativeModelDefinitions(
  provider: ProviderInfo | undefined,
): BackendModelDefinition[] {
  const currentDefault = provider?.models.find(({ isDefault }) => isDefault)
    ?? provider?.models[0];
  return [{
    id: "provider-default",
    displayName: "Provider default",
    contextWindowTokens: null,
    reasoningOptions: currentDefault?.reasoningOptions.map((option) => ({
      ...option,
    })) ?? [],
    capabilities: [],
  }, ...(provider?.models ?? [])
    .filter(({ id }) => id !== "provider-default")
    .map((model) => ({
    id: model.id,
    displayName: model.label,
    contextWindowTokens: null,
    reasoningOptions: model.reasoningOptions.map((option) => ({ ...option })),
    capabilities: [],
    }))];
}

export function nativeProfile(
  providerId: ProviderId,
  provider: ProviderInfo | undefined,
): PersistedModelBackendProfile {
  const profile = nativeBackendProfile(providerId);
  const models = nativeModelDefinitions(provider);
  return persistedModelBackendProfileSchema.parse({
    ...profile,
    harnessId: nativeHarnessId(providerId),
    preset: "native",
    baseUrl: null,
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models,
    routing: {
      mode: "simple",
      primaryModelId: "provider-default",
    },
    capabilityHints: [],
    createdAt: BUILT_IN_TIMESTAMP,
    updatedAt: BUILT_IN_TIMESTAMP,
  });
}

function kimiModelDefinitions(
  profile: ClaudeCompatibleBackendProfile,
): BackendModelDefinition[] {
  return KIMI_CODING_MODELS.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    contextWindowTokens: profile.contextWindowTokens,
    reasoningOptions: KIMI_CLAUDE_REASONING_OPTIONS.map((option) => ({
      ...option,
    })),
    capabilities: profile.capabilityOverrides.map((capability) => ({
      ...capability,
    })),
  }));
}

export function persistedKimiProfile(
  input: ClaudeCompatibleBackendProfile,
  credentialGeneration: string | null,
  existing?: StoredModelBackendProfile,
): PersistedModelBackendProfile {
  const profile = claudeCompatibleBackendProfileSchema.parse(input);
  if (profile.preset !== "kimi-code") {
    throw new BackendProfileControllerError(
      "Only the built-in Kimi preset can be registered.",
    );
  }
  const models = kimiModelDefinitions(profile);
  const now = new Date().toISOString();
  return persistedModelBackendProfileSchema.parse({
    ...modelBackendProfileForClaudeProfile(profile),
    enabled: existing?.profile.enabled ?? profile.enabled,
    configurationRevision:
      existing?.profile.configurationRevision ?? profile.configurationRevision,
    harnessId: "claude-agent-sdk",
    preset: "kimi-code",
    baseUrl: profile.baseUrl,
    allowInsecureLocalhost: false,
    credentialGeneration,
    models,
    routing: existing?.profile.routing ?? {
      mode: "simple",
      primaryModelId: profile.primaryModelId,
    },
    capabilityHints: profile.capabilityOverrides,
    createdAt: existing?.profile.createdAt ?? now,
    updatedAt: existing?.profile.updatedAt ?? now,
  });
}

export function routingForClaude(
  profile: PersistedModelBackendProfile,
): ClaudeModelRouting {
  if (profile.routing.mode === "simple") return { mode: "simple" };
  return {
    mode: "advanced",
    tierModels: { ...profile.routing.tierModels },
    subagentModelId: profile.routing.subagentModelId,
  };
}

export function isUsableCompatibility(
  compatibility: HarnessBackendCompatibility,
): boolean {
  return compatibility.state !== "unknown"
    && compatibility.state !== "unavailable";
}

export function safeBackendProfile(
  profile: Pick<
    PersistedModelBackendProfile,
    | "id"
    | "displayName"
    | "protocol"
    | "authenticationMode"
    | "source"
    | "enabled"
    | "configurationRevision"
    | "endpointIdentity"
  >,
): ModelBackendProfile {
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

export function connectionState(
  result: BackendCompatibilityProbeResult | null,
): ModelBackendProfileView["connectionState"] {
  if (!result) return "not-tested";
  if (result.failure) return "failed";
  return result.compatibility === "protocol-compatible"
    ? "connected"
    : result.compatibility === "partially-compatible"
      ? "limited"
      : "failed";
}

export function backendProbeForModel(
  record: Pick<StoredModelBackendProfile, "probeResults">,
  modelId: string,
): BackendCompatibilityProbeResult | null {
  return record.probeResults.find((result) => result.modelId === modelId) ?? null;
}

export function primaryContextWindow(
  profile: PersistedModelBackendProfile,
): number | null {
  return backendProfilePrimaryModel(profile).contextWindowTokens;
}
