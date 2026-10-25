import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BACKEND_CREDENTIAL_MASK,
  backendCredentialSecretIssue,
  normalizeBackendCredentialSecret,
  parseSetBackendCredentialRequest,
} from "../../src/shared/backend-credentials";
import { backendEndpointIdentity } from "../../src/shared/backend-endpoint-identity";
import {
  MAX_BACKEND_PROBE_MODELS,
  MAX_DISCOVERED_BACKEND_MODELS,
  backendProfileModelsResultSchema,
  backendProfileProviderId,
  backendProfileRouteKind,
  modelBackendProfileDetailSchema,
  modelBackendProfileDiscoverModelsSchema,
  modelBackendProfileDraftSchema,
  modelBackendProfileProbeSchema,
  modelBackendProfileUpdateSchema,
  modelBackendProfileViewSchema,
  persistedModelBackendProfileSchema,
} from "../../src/shared/backend-profile-settings";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import {
  BACKEND_PROBE_FRESHNESS_MS,
  BACKEND_PROBE_RENEWAL_MS,
  MODEL_CAPABILITY_IDS,
  backendProbeAuthorityIsCurrent,
} from "../../src/shared/model-routing";
import { BACKEND_PROFILE_DISCOVERY_REQUEST_TIMEOUT_MS } from "../../src/shared/runtime-command-timeouts";

const HOUR_MS = 60 * 60 * 1_000;
const checkedAt = "2030-01-01T00:00:00.000Z";

const model = (id: string, displayName = id) => ({
  id,
  displayName,
  contextWindowTokens: null,
  reasoningOptions: [],
  capabilities: [],
});

const customDraft = {
  displayName: "Team gateway",
  harnessId: "codex-app-server",
  protocol: "openai-responses",
  authenticationMode: "bearer-token",
  preset: "custom",
  baseUrl: "https://gateway.example.test/v1",
  allowInsecureLocalhost: false,
  models: [model("team-model")],
  routing: { mode: "simple", primaryModelId: "team-model" },
  capabilityHints: [],
} as const;

function anthropicKeyProfile(overrides: Record<string, unknown> = {}) {
  const baseUrl = "https://api.anthropic.com";
  return {
    id: "custom:anthropic-key",
    displayName: "Anthropic API key",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 2,
    endpointIdentity: backendEndpointIdentity(baseUrl),
    preset: "anthropic-api-key",
    baseUrl,
    allowInsecureLocalhost: false,
    allowPrivateNetwork: false,
    credentialGeneration: "vault-generation:1",
    models: [model("claude-opus-5-5", "Claude Opus 5.5"), model("claude-haiku-5-5", "Claude Haiku 5.5")],
    routing: { mode: "simple", primaryModelId: "claude-opus-5-5" },
    capabilityHints: [],
    createdAt: checkedAt,
    updatedAt: checkedAt,
    ...overrides,
  };
}

function compatibility(profileId: string, harnessId = "claude-agent-sdk") {
  return {
    harnessId,
    backendProfileId: profileId,
    backendProtocol: harnessId === "claude-agent-sdk" ? "anthropic-messages" : "openai-responses",
    state: "unknown",
    provenance: "unknown",
    allowsModelSwitchWithinSession: false,
    reasonCode: "probe-required",
    reason: "Test this backend before using it.",
  } as const;
}

function probe(profileId: string, modelId: string) {
  return {
    profileId,
    backendConfigurationRevision: 2,
    endpointIdentity: backendEndpointIdentity("https://api.anthropic.com"),
    protocol: "anthropic-messages",
    modelId,
    compatibility: "protocol-compatible",
    protocolVerified: true,
    modelVerified: true,
    capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
      id,
      state: "unknown",
      provenance: "unknown",
      detail: null,
      checkedAt,
    })),
    contextWindow: {
      tokens: null,
      state: "unknown",
      provenance: "probe",
      detail: null,
      checkedAt,
    },
    failure: null,
    checkedAt,
  } as const;
}

function anthropicKeyView(overrides: Record<string, unknown> = {}) {
  const { baseUrl: _baseUrl, ...profile } = anthropicKeyProfile();
  return {
    ...profile,
    models: profile.models.map((entry, index) => ({
      ...entry,
      compatibility: compatibility(profile.id),
      latestProbe: index === 0 ? probe(profile.id, entry.id) : null,
    })),
    routeKind: "api-key",
    providerId: "claude",
    endpointHost: "api.anthropic.com",
    authState: "configured",
    connectionState: "connected",
    compatibility: compatibility(profile.id),
    latestProbe: probe(profile.id, "claude-opus-5-5"),
    canDelete: true,
    canDisable: true,
    ...overrides,
  };
}

describe("backend draft schema", () => {
  it("accepts API key presets and custom drafts and refuses native", () => {
    expect(modelBackendProfileDraftSchema.parse({ preset: "anthropic-api-key" }))
      .toEqual({ preset: "anthropic-api-key" });
    expect(modelBackendProfileDraftSchema.safeParse({ preset: "openai-api-key" }).success).toBe(true);
    expect(modelBackendProfileDraftSchema.safeParse(customDraft).success).toBe(true);
    expect(modelBackendProfileDraftSchema.safeParse({ ...customDraft, preset: "native" }).success)
      .toBe(false);
    expect(modelBackendProfileDraftSchema.safeParse({ ...customDraft, preset: "kimi-code" }).success)
      .toBe(false);
  });

  it("requires preset connection values to equal the catalogue", () => {
    expect(modelBackendProfileDraftSchema.safeParse({
      preset: "openai-api-key",
      baseUrl: "https://api.openai.com/v1",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
      harnessId: "codex-app-server",
    }).success).toBe(true);
    for (const mismatch of [
      { baseUrl: "https://evil.example.test/v1" },
      { protocol: "anthropic-messages" },
      { authenticationMode: "none" },
      { harnessId: "claude-agent-sdk" },
      { allowInsecureLocalhost: true },
      { allowPrivateNetwork: true },
    ]) {
      expect(modelBackendProfileDraftSchema.safeParse({
        preset: "openai-api-key",
        ...mismatch,
      }).success, JSON.stringify(mismatch)).toBe(false);
    }
  });

  it("refuses none authentication for Anthropic Messages and allows it for Responses", () => {
    expect(modelBackendProfileDraftSchema.safeParse({
      ...customDraft,
      harnessId: "claude-agent-sdk",
      protocol: "anthropic-messages",
      authenticationMode: "none",
    }).success).toBe(false);
    expect(modelBackendProfileDraftSchema.safeParse({
      ...customDraft,
      authenticationMode: "none",
    }).success).toBe(true);
  });

  it("requires an http or https custom base URL without query or fragment", () => {
    for (const baseUrl of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://gateway.example.test/v1?key=1",
      "https://gateway.example.test/v1#x",
    ]) {
      expect(modelBackendProfileDraftSchema.safeParse({ ...customDraft, baseUrl }).success, baseUrl)
        .toBe(false);
    }
    expect(modelBackendProfileDraftSchema.safeParse({
      ...customDraft,
      baseUrl: "http://localhost:4000/v1",
    }).success).toBe(true);
  });

  it("requires unique non-empty model IDs and display names", () => {
    for (const models of [
      [model("team-model"), model("team-model")],
      [model("")],
      [model("team-model", " ")],
    ]) {
      expect(modelBackendProfileDraftSchema.safeParse({ ...customDraft, models }).success)
        .toBe(false);
    }
  });
});

describe("persisted backend profiles", () => {
  it("defaults the private-network opt-in to false for stored JSON", () => {
    const { allowPrivateNetwork: _ignored, ...legacy } = anthropicKeyProfile();
    expect(persistedModelBackendProfileSchema.parse(legacy).allowPrivateNetwork).toBe(false);
    expect(persistedModelBackendProfileSchema.parse({
      ...anthropicKeyProfile({ preset: "custom", baseUrl: "https://gateway.example.test", endpointIdentity: backendEndpointIdentity("https://gateway.example.test") }),
      allowPrivateNetwork: true,
    }).allowPrivateNetwork).toBe(true);
  });

  it("accepts user-created API key presets and pins them to the catalogue", () => {
    expect(persistedModelBackendProfileSchema.safeParse(anthropicKeyProfile()).success).toBe(true);
    expect(persistedModelBackendProfileSchema.safeParse(anthropicKeyProfile({
      baseUrl: "https://api.anthropic.com/v1/",
    })).success).toBe(true);
    for (const mismatch of [
      { baseUrl: "https://gateway.example.test" },
      { authenticationMode: "bearer-token" },
      { harnessId: "codex-app-server" },
      { source: "built-in" },
      { allowPrivateNetwork: true },
    ]) {
      expect(persistedModelBackendProfileSchema.safeParse(anthropicKeyProfile(mismatch)).success, JSON.stringify(mismatch))
        .toBe(false);
    }
  });

  it("accepts the private-network opt-in in updates", () => {
    expect(modelBackendProfileUpdateSchema.parse({ allowPrivateNetwork: true }))
      .toEqual({ allowPrivateNetwork: true });
    expect(modelBackendProfileUpdateSchema.safeParse({ preset: "native" }).success).toBe(false);
    expect(modelBackendProfileUpdateSchema.safeParse({ baseUrl: "ftp://gateway.example.test" }).success)
      .toBe(false);
  });
});

describe("backend profile views", () => {
  it("distinguishes account routes from API key routes", () => {
    expect(backendProfileRouteKind({ authenticationMode: "harness-managed" })).toBe("account");
    expect(backendProfileRouteKind({ authenticationMode: "api-key" })).toBe("api-key");
    expect(backendProfileRouteKind({ authenticationMode: "bearer-token" })).toBe("api-key");
    expect(backendProfileRouteKind({ authenticationMode: "none" })).toBe("api-key");
  });

  it("shows each route under the provider a person recognises", () => {
    expect(backendProfileProviderId({ harnessId: "claude-agent-sdk", preset: "native" })).toBe("claude");
    expect(backendProfileProviderId({ harnessId: "claude-agent-sdk", preset: "kimi-code" })).toBe("kimi");
    expect(backendProfileProviderId({ harnessId: "claude-agent-sdk", preset: "custom" })).toBe("claude");
    expect(backendProfileProviderId({ harnessId: "codex-app-server", preset: "openai-api-key" })).toBe("codex");
    expect(backendProfileProviderId({ harnessId: "antigravity-cli", preset: "native" })).toBe("antigravity");
  });

  it("carries per-model compatibility and probe evidence", () => {
    const view = anthropicKeyView();
    expect(modelBackendProfileViewSchema.parse(view)).toEqual(view);
    expect(modelBackendProfileDetailSchema.parse({ ...view, baseUrl: "https://api.anthropic.com" }).models[1]!.latestProbe)
      .toBeNull();
  });

  it("rejects projections that disagree with the profile", () => {
    const view = anthropicKeyView();
    for (const invalid of [
      { routeKind: "account" },
      { providerId: "kimi" },
      { models: [{ ...view.models[0]!, latestProbe: probe(view.id, "claude-haiku-5-5") }, view.models[1]] },
      { models: [{ ...view.models[0]!, compatibility: compatibility("custom:other") }, view.models[1]] },
      { models: [{ ...view.models[0]!, compatibility: undefined }, view.models[1]] },
      { allowPrivateNetwork: undefined },
    ]) {
      expect(modelBackendProfileViewSchema.safeParse({ ...view, ...invalid }).success, JSON.stringify(Object.keys(invalid)))
        .toBe(false);
    }
  });
});

describe("backend commands", () => {
  const requestId = randomUUID();

  it("probes every model by default, checks only the key for an empty list and bounds explicit lists", () => {
    expect(modelBackendProfileProbeSchema.parse({ profileId: "custom:team" }))
      .toEqual({ profileId: "custom:team" });
    expect(modelBackendProfileProbeSchema.parse({ profileId: "custom:team", modelIds: [] }))
      .toEqual({ profileId: "custom:team", modelIds: [] });
    expect(modelBackendProfileProbeSchema.parse({ profileId: "custom:team", modelIds: ["a", "b"] }))
      .toEqual({ profileId: "custom:team", modelIds: ["a", "b"] });
    expect(MAX_BACKEND_PROBE_MODELS).toBe(16);
    for (const modelIds of [
      ["a", "a"],
      Array.from({ length: 17 }, (_, index) => `model-${index}`),
    ]) {
      expect(modelBackendProfileProbeSchema.safeParse({ profileId: "custom:team", modelIds }).success)
        .toBe(false);
    }
    expect(modelBackendProfileProbeSchema.safeParse({ profileId: "custom:team", modelId: "a" }).success)
      .toBe(false);
    expect(clientCommandSchema.safeParse({
      type: "backend.profile.probe",
      requestId,
      payload: { profileId: "custom:team", modelIds: ["a"] },
    }).success).toBe(true);
  });

  it("discovers models for one profile", () => {
    expect(modelBackendProfileDiscoverModelsSchema.parse({ profileId: "custom:team" }))
      .toEqual({ profileId: "custom:team" });
    expect(clientCommandSchema.safeParse({
      type: "backend.profile.discover-models",
      requestId,
      payload: { profileId: "custom:team" },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      type: "backend.profile.discover-models",
      requestId,
      payload: { profileId: "custom:team", baseUrl: "https://elsewhere.example.test" },
    }).success).toBe(false);
    expect(BACKEND_PROFILE_DISCOVERY_REQUEST_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("validates discovered model results", () => {
    const result = {
      kind: "backend.profile.models",
      profileId: "custom:team",
      models: [{ id: "a", displayName: "A" }, { id: "b", displayName: "B" }],
    };
    expect(backendProfileModelsResultSchema.parse(result)).toEqual(result);
    expect(backendProfileModelsResultSchema.safeParse({
      ...result,
      models: [{ id: "a", displayName: "A" }, { id: "a", displayName: "Again" }],
    }).success).toBe(false);
    expect(backendProfileModelsResultSchema.safeParse({
      ...result,
      models: Array.from({ length: MAX_DISCOVERED_BACKEND_MODELS + 1 }, (_, index) => ({
        id: `model-${index}`,
        displayName: `Model ${index}`,
      })),
    }).success).toBe(false);
  });

  it("lets Claude sign in with Console billing and keeps account sign-in the default", () => {
    const start = (payload: Record<string, unknown>) => clientCommandSchema.safeParse({
      type: "provider.auth.start",
      requestId,
      payload: { cols: 80, rows: 24, ...payload },
    }).success;
    expect(start({ providerId: "claude" })).toBe(true);
    expect(start({ providerId: "claude", method: "account" })).toBe(true);
    expect(start({ providerId: "claude", method: "console" })).toBe(true);
    expect(start({ providerId: "codex", method: "account" })).toBe(true);
    expect(start({ providerId: "codex", method: "console" })).toBe(false);
    expect(start({ providerId: "claude", method: "api-key" })).toBe(false);
  });
});

describe("backend probe freshness", () => {
  it("keeps evidence for seven days and renews it after one day", () => {
    expect(BACKEND_PROBE_FRESHNESS_MS).toBe(7 * 24 * HOUR_MS);
    expect(BACKEND_PROBE_RENEWAL_MS).toBe(24 * HOUR_MS);
    const authority = {
      schemaVersion: 1 as const,
      operationId: "00000000-0000-4000-8000-000000000001",
      admissionSequence: 1,
      installationFingerprint: null,
      expiresAt: new Date(Date.parse(checkedAt) + BACKEND_PROBE_FRESHNESS_MS).toISOString(),
    };
    expect(backendProbeAuthorityIsCurrent(
      { checkedAt, authority },
      new Date(Date.parse(checkedAt) + 6 * 24 * HOUR_MS),
    )).toBe(true);
    expect(backendProbeAuthorityIsCurrent(
      { checkedAt, authority },
      new Date(Date.parse(checkedAt) + BACKEND_PROBE_FRESHNESS_MS),
    )).toBe(false);
    expect(backendProbeAuthorityIsCurrent({
      checkedAt,
      authority: {
        ...authority,
        expiresAt: new Date(Date.parse(checkedAt) + BACKEND_PROBE_FRESHNESS_MS + 1).toISOString(),
      },
    }, new Date(Date.parse(checkedAt) + HOUR_MS))).toBe(false);
  });
});

describe("pasted backend credentials", () => {
  it("trims surrounding whitespace before storage", () => {
    expect(parseSetBackendCredentialRequest({
      profileId: "custom:team",
      secret: "  sk-ant-test-key\n",
    })).toEqual({ profileId: "custom:team", secret: "sk-ant-test-key" });
    expect(normalizeBackendCredentialSecret("\tsk-test \r\n")).toBe("sk-test");
  });

  it("refuses a secret that is empty after trimming with a clear message", () => {
    expect(parseSetBackendCredentialRequest({ profileId: "custom:team", secret: " \n\t " }))
      .toBeNull();
    expect(backendCredentialSecretIssue(" \n\t ")).toBe(
      "Paste an API key or token. Only spaces or line breaks were entered.",
    );
    expect(() => normalizeBackendCredentialSecret("   ")).toThrow(
      "Paste an API key or token. Only spaces or line breaks were entered.",
    );
  });

  it("keeps the other secret rules", () => {
    expect(backendCredentialSecretIssue("sk-test")).toBeNull();
    expect(backendCredentialSecretIssue(BACKEND_CREDENTIAL_MASK)).not.toBeNull();
    expect(backendCredentialSecretIssue(` ${BACKEND_CREDENTIAL_MASK} `)).not.toBeNull();
    expect(backendCredentialSecretIssue("line-one\nline-two")).not.toBeNull();
    expect(backendCredentialSecretIssue("x".repeat(16_385))).not.toBeNull();
    expect(backendCredentialSecretIssue(7)).not.toBeNull();
    expect(parseSetBackendCredentialRequest({
      profileId: "custom:team",
      secret: "line-one\nline-two",
    })).toBeNull();
    expect(parseSetBackendCredentialRequest({
      profileId: "custom:team",
      secret: "sk-test",
      extra: true,
    })).toBeNull();
  });
});
