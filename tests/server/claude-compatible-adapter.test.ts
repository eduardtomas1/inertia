import { describe, expect, it } from "vitest";

import { CLAUDE_CLOUD_ROUTING_ENVIRONMENT_KEYS } from "../../src/node/provider-routing-environment";
import {
  claudeHarnessBackendCompatibility,
  createCustomClaudeBackendProfile,
  createKimiClaudeBackendProfile,
  modelBackendProfileForClaudeProfile,
  nativeAnthropicBackendProfile,
  type ClaudeAdvancedModelRouting,
} from "../../src/shared/claude-backend-profiles";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
} from "../../src/shared/model-routing";
import {
  claudeBackendProfileRegistrations,
  ClaudeBackendLaunchConfigurationError,
  createClaudeBackendLaunchResolver as createPrivilegedClaudeBackendLaunchResolver,
  resolveClaudeCompatibleLaunch,
} from "../../src/server/runtime/backends/claude-compatible-adapter";
import type { ProviderRunInput } from "../../src/server/provider/contracts";

const SECRET_REFERENCE = "secret:kimi-code-key";
const SECRET_VALUE = "sensitive-test-value";

function providerInput(
  profile: ReturnType<typeof createKimiClaudeBackendProfile> | ReturnType<typeof nativeAnthropicBackendProfile>,
  modelId = profile.primaryModelId,
): ProviderRunInput {
  const backendProfile = modelBackendProfileForClaudeProfile(profile);
  const backendCompatibility = claudeHarnessBackendCompatibility(profile);
  const modelSelection = modelSelectionSchema.parse({
    harnessId: "claude-agent-sdk",
    backendProfileId: profile.id,
    backendProfileDisplayName: profile.displayName,
    modelId,
    alias: null,
    reasoningEffort: "high",
    contextWindowOverride: profile.contextWindowTokens,
    providerOptions: {},
    capabilities: profile.capabilityOverrides,
    backendConfigurationRevision: profile.configurationRevision,
  });
  return {
    providerId: "claude",
    harnessId: "claude-agent-sdk",
    backendProfile,
    backendCompatibility,
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(
      modelSelection,
      backendProfile.endpointIdentity,
      true,
    ),
    conversationId: "conversation-claude",
    runId: "run-claude",
    turnId: "turn-claude",
    cwd: "/workspace",
    prompt: "Inspect the project",
    model: modelId,
    reasoningEffort: "high",
    interactionMode: "build",
    access: "supervised",
  };
}

describe("Claude-compatible process adapter", () => {
  it("preserves native Claude behavior in an isolated environment clone", () => {
    const baseEnvironment = {
      PATH: "/usr/bin",
      ANTHROPIC_MODEL: "existing-native-selection",
      CLAUDE_CODE_EFFORT_LEVEL: "medium",
      ANTHROPIC_API_KEY: "native-user-key",
      EMPTY_VALUE: "",
      UNICODE_VALUE: "calm-λ",
    };
    const result = resolveClaudeCompatibleLaunch({
      profile: nativeAnthropicBackendProfile(),
      baseEnvironment,
      selectedModelId: "claude-sonnet",
      reasoningEffort: "high",
    });

    expect(result.environment).toEqual(baseEnvironment);
    expect(result.environment).not.toBe(baseEnvironment);
    expect(result.modelArgument).toBe("claude-sonnet");
    expect(baseEnvironment).toEqual({
      PATH: "/usr/bin",
      ANTHROPIC_MODEL: "existing-native-selection",
      CLAUDE_CODE_EFFORT_LEVEL: "medium",
      ANTHROPIC_API_KEY: "native-user-key",
      EMPTY_VALUE: "",
      UNICODE_VALUE: "calm-λ",
    });
  });

  it("retains native cloud routing while scrubbing every route from Kimi", () => {
    const inheritedRoutes = Object.fromEntries(
      CLAUDE_CLOUD_ROUTING_ENVIRONMENT_KEYS.map((key, index) => [
        key,
        `inherited-route-${index}`,
      ]),
    );
    const baseEnvironment = {
      PATH: "/usr/bin",
      ...inheritedRoutes,
    };
    const native = resolveClaudeCompatibleLaunch({
      profile: nativeAnthropicBackendProfile(),
      baseEnvironment,
    });
    const kimi = resolveClaudeCompatibleLaunch({
      profile: createKimiClaudeBackendProfile({
        id: "kimi:cloud-routing-isolation",
        secretReference: SECRET_REFERENCE,
        primaryModelId: "k3-256k",
      }),
      baseEnvironment,
      secretValue: SECRET_VALUE,
    });

    expect(native.environment).toEqual(baseEnvironment);
    for (const key of CLAUDE_CLOUD_ROUTING_ENVIRONMENT_KEYS) {
      expect(kimi.environment).not.toHaveProperty(key);
    }
    expect(baseEnvironment).toEqual({
      PATH: "/usr/bin",
      ...inheritedRoutes,
    });
  });

  it("registers only safe envelopes while retaining verified Kimi compatibility separately", () => {
    const kimi = createKimiClaudeBackendProfile({
      id: "kimi:registered",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
    });
    const custom = createCustomClaudeBackendProfile({
      id: "custom:registered",
      displayName: "Custom",
      baseUrl: "https://gateway.example.test",
      authenticationMode: "none",
      secretReference: null,
      primaryModelId: "custom-model",
    });
    const registrations = claudeBackendProfileRegistrations([kimi, custom]);

    expect(registrations.backendProfiles).toHaveLength(2);
    expect(JSON.stringify(registrations.backendProfiles)).not.toContain(SECRET_REFERENCE);
    expect(JSON.stringify(registrations.backendProfiles)).not.toContain("api.kimi.com");
    expect(registrations.backendCompatibilities).toEqual([
      expect.objectContaining({
        backendProfileId: kimi.id,
        state: "partially-compatible",
        provenance: "built-in",
      }),
      expect.objectContaining({
        backendProfileId: custom.id,
        state: "unknown",
        provenance: "unknown",
      }),
    ]);
  });

  it("materializes an opaque reference only inside the privileged launch resolver", async () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:privileged",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
    });
    const references: string[] = [];
    const resolver = createPrivilegedClaudeBackendLaunchResolver({
      profiles: [profile],
      resolveSecret: (reference) => {
        references.push(reference);
        return SECRET_VALUE;
      },
    });
    const result = await resolver(
      providerInput(profile),
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "inherited",
      },
      { signal: new AbortController().signal },
    );

    expect(references).toEqual([SECRET_REFERENCE]);
    expect(result.environment.ANTHROPIC_API_KEY).toBe(SECRET_VALUE);
    expect(result.modelArgument).toBe("k3-256k");
    expect(result.releaseAfterStart).toBeTypeOf("function");
    expect(result.dispose).toBeUndefined();
    result.releaseAfterStart?.();
    result.releaseAfterStart?.();
    expect(result.environment.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("maps Kimi into every Claude tier, subagents, effort, and context without inherited leakage", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:k3",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
      contextWindowTokens: 1_048_576,
      autoCompactionThresholdPercent: 80,
    });
    const baseEnvironment = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "inherited-anthropic-key",
      ANTHROPIC_AUTH_TOKEN: "inherited-bearer",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku",
      CLAUDE_CODE_USE_BEDROCK: "1",
      NODE_OPTIONS: "--enable-source-maps",
    };

    const result = resolveClaudeCompatibleLaunch({
      profile,
      baseEnvironment,
      selectedModelId: "k3",
      reasoningEffort: "xhigh",
      secretValue: SECRET_VALUE,
    });

    expect(result.modelArgument).toBe("k3[1m]");
    expect(result.environment).toMatchObject({
      PATH: "/usr/bin",
      NODE_OPTIONS: "--enable-source-maps",
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ANTHROPIC_API_KEY: SECRET_VALUE,
      ANTHROPIC_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "k3[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "k3[1m]",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1048576",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
    });
    expect(result.environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.environment.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(baseEnvironment.ANTHROPIC_API_KEY).toBe("inherited-anthropic-key");

    result.releaseSecrets();
    result.releaseSecrets();
    expect(result.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.environment.ANTHROPIC_MODEL).toBe("k3[1m]");
  });

  it("preserves deliberate Advanced routing while keeping the selected primary exact", () => {
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
    const result = resolveClaudeCompatibleLaunch({
      profile,
      baseEnvironment: {},
      selectedModelId: "k3-256k",
      secretValue: SECRET_VALUE,
    });

    expect(result.modelArgument).toBe("k3-256k");
    expect(result.environment).toMatchObject({
      ANTHROPIC_MODEL: "k3-256k",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "k3",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "k3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "k3-256k",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-for-coding-highspeed",
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-for-coding",
    });
    expect(Object.values(result.environment).some((value) => value?.startsWith("claude-"))).toBe(false);
  });

  it("rejects an undocumented Kimi model or incompatible context before launch", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:validated",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
      contextWindowTokens: 1_048_576,
    });

    expect(() => resolveClaudeCompatibleLaunch({
      profile,
      baseEnvironment: {},
      selectedModelId: "kimi-for-coding",
      secretValue: SECRET_VALUE,
    })).toThrow(/model and context window are not supported/u);
    expect(() => resolveClaudeCompatibleLaunch({
      profile,
      baseEnvironment: {},
      selectedModelId: "unverified-kimi-model",
      secretValue: SECRET_VALUE,
    })).toThrow(/model and context window are not supported/u);
  });

  it("supports bearer and no-auth custom endpoints without credential crossover", () => {
    const bearerProfile = createCustomClaudeBackendProfile({
      id: "custom:bearer",
      displayName: "Bearer gateway",
      baseUrl: "https://gateway.example.test/anthropic",
      authenticationMode: "bearer-token",
      secretReference: "secret:gateway-bearer",
      primaryModelId: "gateway-model",
    });
    const bearer = resolveClaudeCompatibleLaunch({
      profile: bearerProfile,
      baseEnvironment: { ANTHROPIC_API_KEY: "stale" },
      secretValue: SECRET_VALUE,
    });
    expect(bearer.environment.ANTHROPIC_AUTH_TOKEN).toBe(SECRET_VALUE);
    expect(bearer.environment.ANTHROPIC_API_KEY).toBeUndefined();

    const noAuthProfile = createCustomClaudeBackendProfile({
      id: "custom:none",
      displayName: "Local gateway",
      baseUrl: "http://127.0.0.1:8787",
      allowInsecureLocalhost: true,
      authenticationMode: "none",
      secretReference: null,
      primaryModelId: "local-model",
    });
    const noAuth = resolveClaudeCompatibleLaunch({
      profile: noAuthProfile,
      baseEnvironment: {
        ANTHROPIC_API_KEY: "stale",
        ANTHROPIC_AUTH_TOKEN: "stale",
      },
    });
    expect(noAuth.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(noAuth.environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(noAuth.environment.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787/");
  });

  it("never mutates global process.env", () => {
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const originalModel = process.env.ANTHROPIC_MODEL;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:isolated",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
    });

    resolveClaudeCompatibleLaunch({
      profile,
      baseEnvironment: process.env,
      secretValue: SECRET_VALUE,
    });

    expect(process.env.ANTHROPIC_BASE_URL).toBe(originalBaseUrl);
    expect(process.env.ANTHROPIC_MODEL).toBe(originalModel);
    expect(process.env.ANTHROPIC_API_KEY).toBe(originalApiKey);
  });

  it("fails closed with sanitized errors when credential material is unavailable or unexpected", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:missing",
      secretReference: "secret:should-not-appear",
      primaryModelId: "k3-256k",
    });

    let failure: unknown;
    try {
      resolveClaudeCompatibleLaunch({
        profile,
        baseEnvironment: {},
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ClaudeBackendLaunchConfigurationError);
    expect(failure).toMatchObject({ code: "credential-unavailable" });
    expect((failure as Error).message).not.toContain(profile.secretReference!);
    expect((failure as Error).message).not.toContain(profile.baseUrl!);

    expect(() => resolveClaudeCompatibleLaunch({
      profile: nativeAnthropicBackendProfile(),
      baseEnvironment: {},
      secretValue: SECRET_VALUE,
    })).toThrow(/authentication is owned by the Claude harness/u);
  });

  it("does not provide an arbitrary environment escape hatch", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:no-arbitrary-env",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
    });

    let failure: unknown;
    try {
      resolveClaudeCompatibleLaunch({
        profile: {
          ...profile,
          environment: {
            PATH: "/attacker",
            NODE_OPTIONS: "--require malicious.js",
            ANTHROPIC_API_KEY: "inline-secret",
          },
        } as never,
        baseEnvironment: { PATH: "/usr/bin" },
        secretValue: SECRET_VALUE,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "invalid-profile",
      message: "The Claude backend profile is invalid.",
    });
    expect((failure as Error).message).not.toContain("inline-secret");
    expect((failure as Error).message).not.toContain("NODE_OPTIONS");
  });

  it("reads mutable privileged profiles at launch time", async () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:mutable",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
    });
    let profiles: typeof profile[] = [];
    const resolver = createPrivilegedClaudeBackendLaunchResolver({
      profiles: () => profiles,
      resolveSecret: async () => SECRET_VALUE,
    });
    expect(() => resolver(
      providerInput(profile),
      {},
      { signal: new AbortController().signal },
    )).toThrow("does not match");

    profiles = [profile];
    await expect(resolver(
      providerInput(profile),
      {},
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({
      modelArgument: "k3-256k",
      environment: {
        ANTHROPIC_API_KEY: SECRET_VALUE,
      },
    });
  });
});
