import { describe, expect, it } from "vitest";

import {
  continuationIdentityForSelection,
  versionedContinuationIdentityForSelection,
  fastModeProviderValue,
  modelSelectionSchema,
  nativeBackendProfile,
  nativeModelSelection,
  resolveHarnessBackendCompatibility,
  sameContinuationIdentity,
  withModelSelectionFastMode,
  type ModelBackendProfile,
} from "../src/shared/model-routing";

describe("model routing contracts", () => {
  it("keeps harness, backend profile, and exact model as separate identities", () => {
    const selection = nativeModelSelection({
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

  it("does not imply universal interoperability from a matching model name", () => {
    const anthropic = nativeBackendProfile("claude");
    expect(resolveHarnessBackendCompatibility("claude-agent-sdk", anthropic)).toMatchObject({
      state: "verified",
      allowsModelSwitchWithinSession: true,
    });
    expect(resolveHarnessBackendCompatibility(
      "codex-app-server",
      nativeBackendProfile("codex"),
    ).allowsModelSwitchWithinSession).toBe(true);
    expect(resolveHarnessBackendCompatibility(
      "cursor-acp",
      nativeBackendProfile("cursor"),
    ).allowsModelSwitchWithinSession).toBe(false);
    expect(resolveHarnessBackendCompatibility(
      "opencode-sdk",
      nativeBackendProfile("opencode"),
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
    const selection = nativeModelSelection({ providerId: "codex", modelId: "gpt-5.4" });
    const identity = versionedContinuationIdentityForSelection(
      selection,
      "endpoint:openai",
      true,
      "a".repeat(64),
    );

    expect(sameContinuationIdentity(identity, { ...identity })).toBe(true);
    const { providerCompatibilityToken: _legacyToken, ...legacyIdentity } =
      identity;
    expect(sameContinuationIdentity(
      legacyIdentity,
      { ...legacyIdentity },
    )).toBe(false);
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
    const standard = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-5.4",
    });
    const fast = withModelSelectionFastMode(standard, "priority");
    const providerCompatibilityToken = "a".repeat(64);

    expect(fastModeProviderValue(fast)).toBe("priority");
    expect(fast.providerOptions).toEqual({ fastMode: "priority" });
    expect(continuationIdentityForSelection(fast)).toMatchObject({
      performanceModeIdentity: "fast:priority",
    });
    expect(sameContinuationIdentity(
      versionedContinuationIdentityForSelection(
        standard,
        null,
        true,
        providerCompatibilityToken,
      ),
      versionedContinuationIdentityForSelection(
        fast,
        null,
        true,
        providerCompatibilityToken,
      ),
    )).toBe(false);
    expect(withModelSelectionFastMode(fast, null).providerOptions).toEqual({});
  });

  it("rejects mutable or unbounded data outside the safe selection envelope", () => {
    const selection = nativeModelSelection({ providerId: "opencode", modelId: "anthropic/claude" });
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
    const selection = nativeModelSelection({ providerId: "codex", modelId: "gpt-5.4" });
    expect(continuationIdentityForSelection(selection, "0123456789abcdef").endpointIdentity)
      .toBe("0123456789abcdef");
  });
});
