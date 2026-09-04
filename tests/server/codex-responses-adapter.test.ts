import { describe, expect, it } from "vitest";

import {
  continuationIdentityForSelection,
  modelSelectionSchema,
  providerNativeBackendProfile,
  providerNativeModelSelection,
  resolveHarnessBackendCompatibility,
  type ModelBackendProfile,
} from "../../src/shared/model-routing";
import type { ProviderRunInput } from "../../src/server/provider/contracts";
import {
  CodexResponsesBackendConfigurationError,
  createCodexResponsesBackendLaunchResolver,
} from "../../src/server/runtime/backends/codex-responses-adapter";

function customProfile(
  overrides: Partial<ModelBackendProfile> = {},
): ModelBackendProfile {
  return {
    id: "custom:responses-gateway",
    displayName: "Responses gateway",
    protocol: "openai-responses",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 7,
    endpointIdentity: "endpoint:responses:7",
    ...overrides,
  };
}

function customRun(profile: ModelBackendProfile): ProviderRunInput {
  const modelSelection = modelSelectionSchema.parse({
    harnessId: "codex-app-server",
    backendProfileId: profile.id,
    backendProfileDisplayName: profile.displayName,
    modelId: "responses-model",
    alias: null,
    reasoningEffort: "high",
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: profile.configurationRevision,
  });
  return {
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfile: profile,
    backendCompatibility: {
      harnessId: "codex-app-server",
      backendProfileId: profile.id,
      backendProtocol: "openai-responses",
      state: "partially-compatible",
      provenance: "probe",
      allowsModelSwitchWithinSession: false,
      reasonCode: "responses-probe-verified",
      reason: "The Responses API and selected model were verified.",
    },
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(
      modelSelection,
      profile.endpointIdentity,
    ),
    conversationId: "conversation",
    cwd: "/workspace",
    prompt: "Inspect",
    model: "responses-model",
    reasoningEffort: "high",
    interactionMode: "build",
    access: "supervised",
  };
}

describe("Codex Responses backend launch adapter", () => {
  it("uses official Codex provider configuration and process-owned credentials", async () => {
    const profile = customProfile();
    const baseEnvironment = {
      SAFE: "yes",
      INERTIA_CODEX_BACKEND_TOKEN: "stale",
    };
    const resolver = createCodexResponsesBackendLaunchResolver({
      profiles: [{
        profile,
        baseUrl: "https://gateway.example/v1/",
        secretReference: "secret:responses-gateway",
      }],
      resolveSecret: async () => "owned-secret",
    });

    const launch = await resolver(
      customRun(profile),
      baseEnvironment,
      { signal: new AbortController().signal },
    );
    expect(launch.environment).toMatchObject({
      SAFE: "yes",
      INERTIA_CODEX_BACKEND_TOKEN: "owned-secret",
    });
    expect(launch.harnessConfiguration).toEqual({
      kind: "codex-responses",
      providerId: "inertia_custom_responses-gateway",
      displayName: "Responses gateway",
      baseUrl: "https://gateway.example/v1",
      credentialEnvironmentKey: "INERTIA_CODEX_BACKEND_TOKEN",
    });
    expect(JSON.stringify(launch.harnessConfiguration)).not.toContain("owned-secret");
    expect(baseEnvironment.INERTIA_CODEX_BACKEND_TOKEN).toBe("stale");

    launch.releaseAfterStart?.();
    expect(launch.environment.INERTIA_CODEX_BACKEND_TOKEN).toBeUndefined();
  });

  it("leaves the native OpenAI App Server launch unchanged", async () => {
    const profile = providerNativeBackendProfile("codex");
    const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-native" });
    const resolver = createCodexResponsesBackendLaunchResolver();
    const launch = await resolver({
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfile: profile,
      backendCompatibility: resolveHarnessBackendCompatibility("codex-app-server", profile),
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(selection),
      conversationId: "native",
      cwd: "/workspace",
      prompt: "Inspect",
      model: "gpt-native",
      interactionMode: "build",
      access: "supervised",
    }, { SAFE: "yes" }, { signal: new AbortController().signal });

    expect(launch).toEqual({ environment: { SAFE: "yes" } });
  });

  it("rejects non-Responses and credential-bearing endpoint configuration", () => {
    expect(() => createCodexResponsesBackendLaunchResolver({
      profiles: [{
        profile: customProfile({ protocol: "anthropic-messages" }),
        baseUrl: "https://gateway.example/v1",
        secretReference: "secret:gateway",
      }],
    })).toThrow(CodexResponsesBackendConfigurationError);
    expect(() => createCodexResponsesBackendLaunchResolver({
      profiles: [{
        profile: customProfile(),
        baseUrl: "https://user:password@gateway.example/v1",
        secretReference: "secret:gateway",
      }],
    })).toThrow("must use HTTPS");
  });

  it("allows only explicitly enabled literal loopback HTTP after probe routing", async () => {
    const profile = customProfile();
    const loopbackResolver = createCodexResponsesBackendLaunchResolver({
      profiles: [{
        profile,
        baseUrl: "http://127.42.0.1:4312/v1",
        secretReference: "secret:gateway",
        allowInsecureLocalhost: true,
      }],
      resolveSecret: async () => "owned-secret",
    });
    await expect(loopbackResolver(
      customRun(profile),
      {},
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({
      harnessConfiguration: {
        kind: "codex-responses",
        baseUrl: "http://127.42.0.1:4312/v1",
      },
    });

    for (const baseUrl of [
      "http://loopback.example.test:4312/v1",
      "http://203.0.113.7:4312/v1",
    ]) {
      expect(() => createCodexResponsesBackendLaunchResolver({
        profiles: [{
          profile,
          baseUrl,
          secretReference: "secret:gateway",
          allowInsecureLocalhost: true,
        }],
      })).toThrow("literal loopback");
      const resolver = createCodexResponsesBackendLaunchResolver({
        profiles: () => [{
          profile,
          baseUrl,
          secretReference: "secret:gateway",
          allowInsecureLocalhost: true,
        }],
      });
      expect(() => resolver(
        customRun(profile),
        {},
        { signal: new AbortController().signal },
      )).toThrow("literal loopback");
    }
  });

  it("fails closed when the secure credential cannot be resolved", async () => {
    const profile = customProfile();
    const resolver = createCodexResponsesBackendLaunchResolver({
      profiles: [{
        profile,
        baseUrl: "https://gateway.example/v1",
        secretReference: "secret:gateway",
      }],
      resolveSecret: async () => null,
    });

    await expect(resolver(
      customRun(profile),
      {},
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({
      code: "credential-unavailable",
    });
  });

  it("reads mutable privileged profile state at launch time", async () => {
    const profile = customProfile();
    let profiles: Array<{
      profile: ModelBackendProfile;
      baseUrl: string;
      secretReference: string;
    }> = [];
    const resolver = createCodexResponsesBackendLaunchResolver({
      profiles: () => profiles,
      resolveSecret: async () => "owned-secret",
    });
    expect(() => resolver(
      customRun(profile),
      {},
      { signal: new AbortController().signal },
    )).toThrow("does not match");

    profiles = [{
      profile,
      baseUrl: "https://gateway.example/v1",
      secretReference: "secret:gateway",
    }];
    await expect(resolver(
      customRun(profile),
      {},
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({
      harnessConfiguration: { kind: "codex-responses" },
    });
  });
});
