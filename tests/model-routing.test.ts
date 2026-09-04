import { describe, expect, it } from "vitest";

import {
  continuationIdentityForSelection,
  fastModeProviderValue,
  modelSelectionSchema,
  nativeHarnessId,
  nativeModelSelection,
  providerIdForHarness,
  providerNativeBackendProfile,
  providerNativeHarnessId,
  providerNativeModelSelection,
  resolveHarnessBackendCompatibility,
  sameContinuationIdentity,
  withModelSelectionFastMode,
  type ModelBackendProfile,
} from "../src/shared/model-routing";
import type { ProviderId } from "../src/shared/provider";

describe("model routing contracts", () => {
  it("keeps every current provider route internally consistent", () => {
    const routes: Array<[ProviderId, string, string]> = [
      ["codex", "codex-app-server", "builtin:openai"],
      ["claude", "claude-agent-sdk", "builtin:anthropic"],
      ["cursor", "cursor-acp", "builtin:cursor"],
      ["gemini", "gemini-acp", "builtin:gemini"],
      ["kimi", "kimi-acp", "builtin:kimi"],
      ["opencode", "opencode-sdk", "builtin:opencode"],
    ];

    for (const [providerId, harnessId, backendProfileId] of routes) {
      expect(providerNativeHarnessId(providerId)).toBe(harnessId);
      expect(providerNativeBackendProfile(providerId).id).toBe(backendProfileId);
      expect(providerIdForHarness(harnessId)).toBe(providerId);
      expect(providerNativeModelSelection({ providerId })).toMatchObject({
        harnessId,
        backendProfileId,
      });
    }
  });

  it("does not mutate migration-pinned pre-Gemini routing helpers", () => {
    expect(nativeHarnessId("gemini")).toBeUndefined();
    expect(() => nativeModelSelection({ providerId: "gemini" })).toThrow();
  });

  it("keeps harness, backend profile, and exact model as separate identities", () => {
    const selection = providerNativeModelSelection({
      providerId: "claude",
      modelId: "claude-sonnet",
      alias: "sonnet",
      reasoningEffort: "high",
    });

    expect(selection).toMatchObject({
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:anthropic",
      backendProfileDisplayName: "Anthropic",
      modelId: "claude-sonnet",
      alias: "sonnet",
      reasoningEffort: "high",
      backendConfigurationRevision: 0,
    });
    expect(modelSelectionSchema.parse(selection)).toEqual(selection);
  });

  it("routes Gemini through its native ACP-managed backend", () => {
    const selection = providerNativeModelSelection({
      providerId: "gemini",
      modelId: "gemini-2.5-pro",
    });

    expect(selection).toMatchObject({
      harnessId: "gemini-acp",
      backendProfileId: "builtin:gemini",
      backendProfileDisplayName: "Google Gemini",
      modelId: "gemini-2.5-pro",
    });
    expect(resolveHarnessBackendCompatibility(
      providerNativeHarnessId("gemini"),
      providerNativeBackendProfile("gemini"),
    )).toMatchObject({
      state: "verified",
      reasonCode: "gemini-managed",
      allowsModelSwitchWithinSession: true,
    });
  });

  it("does not imply universal interoperability from a matching model name", () => {
    const anthropic = providerNativeBackendProfile("claude");
    expect(resolveHarnessBackendCompatibility("claude-agent-sdk", anthropic)).toMatchObject({
      state: "verified",
      allowsModelSwitchWithinSession: true,
    });
    expect(resolveHarnessBackendCompatibility(
      "codex-app-server",
      providerNativeBackendProfile("codex"),
    ).allowsModelSwitchWithinSession).toBe(true);
    expect(resolveHarnessBackendCompatibility(
      "cursor-acp",
      providerNativeBackendProfile("cursor"),
    ).allowsModelSwitchWithinSession).toBe(false);
    expect(resolveHarnessBackendCompatibility(
      "opencode-sdk",
      providerNativeBackendProfile("opencode"),
    ).allowsModelSwitchWithinSession).toBe(true);
    expect(resolveHarnessBackendCompatibility("codex-app-server", anthropic)).toMatchObject({
      state: "unavailable",
      allowsModelSwitchWithinSession: false,
    });

    const unverifiedGateway: ModelBackendProfile = {
      id: "custom:team-gateway",
      displayName: "Team gateway",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      source: "custom",
      enabled: true,
      configurationRevision: 4,
      endpointIdentity: "profile-revision:4",
    };
    expect(resolveHarnessBackendCompatibility("claude-agent-sdk", unverifiedGateway)).toMatchObject({
      state: "unknown",
      provenance: "unknown",
    });
    expect(resolveHarnessBackendCompatibility("cursor-acp", unverifiedGateway).state).toBe("unavailable");
  });

  it("locks continuation to harness, backend revision, endpoint identity, and model", () => {
    const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.4" });
    const identity = continuationIdentityForSelection(selection, "endpoint:openai");

    expect(sameContinuationIdentity(identity, { ...identity })).toBe(true);
    expect(sameContinuationIdentity(identity, {
      ...identity,
      backendConfigurationRevision: identity.backendConfigurationRevision + 1,
    })).toBe(false);
    expect(sameContinuationIdentity(identity, {
      ...identity,
      modelIdentity: "gpt-5.5",
    })).toBe(false);
    expect(sameContinuationIdentity(identity, null)).toBe(false);
  });

  it("persists Fast mode as a non-secret provider route identity", () => {
    const standard = providerNativeModelSelection({
      providerId: "codex",
      modelId: "gpt-5.4",
    });
    const fast = withModelSelectionFastMode(standard, "priority");

    expect(fastModeProviderValue(fast)).toBe("priority");
    expect(fast.providerOptions).toEqual({ fastMode: "priority" });
    expect(continuationIdentityForSelection(fast)).toMatchObject({
      performanceModeIdentity: "fast:priority",
    });
    expect(sameContinuationIdentity(
      continuationIdentityForSelection(standard),
      continuationIdentityForSelection(fast),
    )).toBe(false);
    expect(withModelSelectionFastMode(fast, null).providerOptions).toEqual({});
  });

  it("rejects mutable or unbounded data outside the safe selection envelope", () => {
    const selection = providerNativeModelSelection({ providerId: "opencode", modelId: "anthropic/claude" });
    expect(modelSelectionSchema.safeParse({
      ...selection,
      baseUrl: "https://example.test",
    }).success).toBe(false);
    expect(modelSelectionSchema.safeParse({
      ...selection,
      providerOptions: { token: "x".repeat(20_000) },
    }).success).toBe(false);
    expect(modelSelectionSchema.safeParse({
      ...selection,
      providerOptions: { transport: { authorization: "Bearer secret" } },
    }).success).toBe(false);
    expect(modelSelectionSchema.safeParse({
      ...selection,
      providerOptions: { safe: "x".repeat(16_000), alsoSafe: "y".repeat(16_000) },
    }).success).toBe(true);
    expect(modelSelectionSchema.safeParse({
      ...selection,
      providerOptions: { safe: "x".repeat(16_384), alsoSafe: "y".repeat(16_384) },
    }).success).toBe(false);
  });

  it("accepts opaque endpoint digests that begin with a digit", () => {
    const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.4" });
    expect(continuationIdentityForSelection(selection, "0123456789abcdef").endpointIdentity)
      .toBe("0123456789abcdef");
  });
});
