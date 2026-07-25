import { describe, expect, it } from "vitest";

import {
  CLAUDE_INTERNAL_TIER_IDS,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_MODEL_IDS,
  claudeCodeModelIdentifier,
  claudeCompatibleBackendProfileSchema,
  createCustomClaudeBackendProfile,
  createKimiClaudeBackendProfile,
  migrateClaudeCompatibleBackendProfile,
  nativeAnthropicBackendProfile,
  normalizeClaudeCompatibleBaseUrl,
  resolveClaudeModelRouting,
  safeClaudeBackendBaseUrl,
  type ClaudeAdvancedModelRouting,
} from "../src/shared/claude-backend-profiles";

const SECRET_REFERENCE = "secret:backend-credential-1";

describe("Claude-compatible backend profiles", () => {
  it("keeps native Anthropic harness-managed and explicitly reports no separate compaction model", () => {
    const profile = nativeAnthropicBackendProfile();

    expect(profile).toMatchObject({
      id: "builtin:anthropic",
      displayName: "Anthropic",
      protocol: "anthropic-messages",
      authenticationMode: "harness-managed",
      preset: "anthropic",
      baseUrl: null,
      secretReference: null,
      compactionModel: {
        state: "unavailable",
        modelId: null,
        provenance: "harness",
      },
    });
    expect(profile.capabilityOverrides.find(({ id }) => id === "compaction")).toMatchObject({
      state: "verified",
      provenance: "built-in",
    });
  });

  it("accepts only current officially documented Kimi Code model IDs", () => {
    for (const primaryModelId of KIMI_CODING_MODEL_IDS) {
      const profile = createKimiClaudeBackendProfile({
        id: `kimi:${primaryModelId}`,
        secretReference: SECRET_REFERENCE,
        primaryModelId,
      });
      expect(profile.primaryModelId).toBe(primaryModelId);
      expect(profile.baseUrl).toBe(KIMI_CODING_BASE_URL);
    }

    expect(() => createKimiClaudeBackendProfile({
      id: "kimi:retired",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "kimi-k2" as never,
    })).toThrow(/current Kimi Code model IDs/u);
  });

  it("keeps the exact Kimi API model separate from Claude Code's 1M context hint", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:k3",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
      contextWindowTokens: 1_048_576,
    });

    expect(profile.primaryModelId).toBe("k3");
    expect(claudeCodeModelIdentifier(profile, profile.primaryModelId)).toBe("k3[1m]");
    expect(claudeCodeModelIdentifier(profile, "k3-256k")).toBe("k3-256k");
  });

  it("uses the selected model for every tier and subagent in Simple mode", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:simple",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
    });

    const routing = resolveClaudeModelRouting(profile, "kimi-for-coding");
    expect(routing.primaryModelId).toBe("kimi-for-coding");
    expect(new Set(Object.values(routing.tierModels))).toEqual(new Set(["kimi-for-coding"]));
    expect(routing.subagentModelId).toBe("kimi-for-coding");
    expect(routing.compactionModel.state).toBe("unavailable");
  });

  it("requires and preserves deliberate independent tier routing in Advanced mode", () => {
    const routing: ClaudeAdvancedModelRouting = {
      mode: "advanced",
      tierModels: {
        fable: "k3",
        opus: "k3",
        sonnet: "k3-256k",
        haiku: "kimi-for-coding-highspeed",
      },
      subagentModelId: "kimi-for-coding",
    };
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:advanced",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
      routing,
    });

    expect(resolveClaudeModelRouting(profile, "k3-256k")).toEqual({
      primaryModelId: "k3-256k",
      tierModels: routing.tierModels,
      subagentModelId: "kimi-for-coding",
      compactionModel: profile.compactionModel,
    });
    expect(() => claudeCompatibleBackendProfileSchema.parse({
      ...profile,
      routing: {
        mode: "advanced",
        tierModels: { opus: "k3", sonnet: "k3", haiku: "k3" },
        subagentModelId: "k3",
      },
    })).toThrow();
  });

  it("normalizes safe custom endpoints and rejects credential-bearing or insecure remote URLs", () => {
    expect(normalizeClaudeCompatibleBaseUrl("https://gateway.example.test/anthropic")).toBe(
      "https://gateway.example.test/anthropic/",
    );
    expect(normalizeClaudeCompatibleBaseUrl("http://127.0.0.1:8787/v1", true)).toBe(
      "http://127.0.0.1:8787/v1/",
    );
    expect(() => normalizeClaudeCompatibleBaseUrl("https://token@gateway.example.test")).toThrow(
      /cannot contain credentials/u,
    );
    expect(() => normalizeClaudeCompatibleBaseUrl("https://gateway.example.test/?token=x")).toThrow(
      /query or fragment/u,
    );
    expect(() => normalizeClaudeCompatibleBaseUrl("http://gateway.example.test")).toThrow(
      /require HTTPS/u,
    );
  });

  it("stores only an opaque secret reference and safe base URL metadata", () => {
    const profile = createCustomClaudeBackendProfile({
      id: "custom:gateway",
      displayName: "Team gateway",
      baseUrl: "https://gateway.example.test/anthropic",
      authenticationMode: "bearer-token",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "team/sonnet",
    });

    expect(profile.secretReference).toBe(SECRET_REFERENCE);
    expect(safeClaudeBackendBaseUrl(profile)).toBe("https://gateway.example.test/anthropic/");
    expect(JSON.stringify(profile)).not.toContain("Bearer ");
    expect(() => claudeCompatibleBackendProfileSchema.parse({
      ...profile,
      apiKey: "sk-plaintext-must-not-parse",
    })).toThrow();
    expect(() => createCustomClaudeBackendProfile({
      id: "custom:bad-reference",
      displayName: "Bad reference",
      baseUrl: "https://gateway.example.test",
      authenticationMode: "api-key",
      secretReference: "sk-plaintext",
      primaryModelId: "model",
    })).toThrow(/opaque identifiers/u);
  });

  it("keeps custom capability claims honest until user declaration or probing", () => {
    expect(() => createCustomClaudeBackendProfile({
      id: "custom:claims",
      displayName: "Claimed gateway",
      baseUrl: "https://gateway.example.test",
      authenticationMode: "none",
      secretReference: null,
      primaryModelId: "custom-model",
      capabilityOverrides: [{
        id: "tools",
        state: "verified",
        provenance: "provider",
        detail: null,
      }],
    })).toThrow(/user-declared, probed, or unknown/u);

    const declared = createCustomClaudeBackendProfile({
      id: "custom:declared",
      displayName: "Declared gateway",
      baseUrl: "https://gateway.example.test",
      authenticationMode: "none",
      secretReference: null,
      primaryModelId: "custom-model",
      capabilityOverrides: [{
        id: "tools",
        state: "user-declared",
        provenance: "user",
        detail: "Configured by the user; not probed.",
      }],
    });
    expect(declared.capabilityOverrides[0]?.state).toBe("user-declared");
  });

  it("migrates incomplete draft tier maps to the visible model without native fallbacks", () => {
    const migrated = migrateClaudeCompatibleBackendProfile({
      id: "kimi:migrated",
      displayName: "Kimi",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      source: "built-in",
      enabled: true,
      configurationRevision: 3,
      schemaVersion: 0,
      preset: "kimi-code",
      baseUrl: KIMI_CODING_BASE_URL,
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
      routingMode: "advanced",
      tierModels: {
        opus: "k3",
        sonnet: "k3-256k",
      },
      contextWindowTokens: 262_144,
      autoCompactionWindowTokens: 262_144,
    });

    expect(migrated.configurationRevision).toBe(4);
    expect(migrated.routing.mode).toBe("advanced");
    if (migrated.routing.mode !== "advanced") throw new Error("Expected advanced routing.");
    expect(migrated.routing.tierModels).toEqual({
      fable: "k3-256k",
      opus: "k3",
      sonnet: "k3-256k",
      haiku: "k3-256k",
    });
    expect(migrated.routing.subagentModelId).toBe("k3-256k");
    expect(CLAUDE_INTERNAL_TIER_IDS.every((tier) => Boolean(migrated.routing.mode === "advanced"
      && migrated.routing.tierModels[tier]))).toBe(true);
    expect(migrateClaudeCompatibleBackendProfile(migrated)).toEqual(migrated);
  });

  it("never migrates a draft profile containing a plaintext credential", () => {
    expect(() => migrateClaudeCompatibleBackendProfile({
      id: "custom:legacy-secret",
      displayName: "Legacy",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      source: "custom",
      enabled: true,
      configurationRevision: 0,
      preset: "custom",
      baseUrl: "https://gateway.example.test/",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "model",
      apiKey: "sk-plaintext",
    })).toThrow();
  });
});
