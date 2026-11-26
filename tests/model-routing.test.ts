import { describe, expect, it } from "vitest";

import {
  continuationIdentityForSelection,
  versionedContinuationIdentityForSelection,
  fastModeProviderValue,
  modelSelectionSchema,
  providerIdForHarness,
  providerNativeBackendProfile,
  providerNativeHarnessId,
  providerNativeModelSelection,
  resolveHarnessBackendCompatibility,
  withModelSelectionFastMode,
  type ModelBackendProfile,
} from "../src/shared/model-routing";
import {
  ANTIGRAVITY_EXPLICIT_COMPACTION_UNAVAILABLE_REASON,
  ANTIGRAVITY_IMAGE_INPUT_UNAVAILABLE_REASON,
  harnessImageInputUnavailableReason,
  type ProviderId,
} from "../src/shared/provider";
import {
  accessModeUnavailableReason,
  effectiveAccessMode,
  providerCanSuperviseAccess,
} from "../src/shared/access-modes";

describe("model routing contracts", () => {
  it("keeps every current provider route internally consistent", () => {
    const routes: Array<[ProviderId, string, string]> = [
      ["codex", "codex-app-server", "builtin:openai"],
      ["claude", "claude-agent-sdk", "builtin:anthropic"],
      ["cursor", "cursor-acp", "builtin:cursor"],
      ["kimi", "kimi-acp", "builtin:kimi"],
      ["opencode", "opencode-sdk", "builtin:opencode"],
      ["antigravity", "antigravity-acp", "builtin:antigravity"],
      ["grok", "grok-acp", "builtin:grok"],
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
    expect(providerIdForHarness("antigravity-cli")).toBe("antigravity");
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

  it("persists Fast mode as a non-secret provider route identity", () => {
    const standard = providerNativeModelSelection({
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
    expect(versionedContinuationIdentityForSelection(
      standard,
      null,
      true,
      providerCompatibilityToken,
    ).performanceModeIdentity).toBeUndefined();
    expect(versionedContinuationIdentityForSelection(
      fast,
      null,
      true,
      providerCompatibilityToken,
    )).toMatchObject({
      performanceModeIdentity: "fast:priority",
      providerCompatibilityToken,
    });
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

  it("enables Antigravity ACP supervision and image input while keeping legacy CLI image limits", () => {
    expect(providerCanSuperviseAccess("antigravity")).toBe(true);
    expect(effectiveAccessMode("antigravity", "supervised")).toBe("supervised");
    expect(accessModeUnavailableReason("antigravity", "supervised")).toBeNull();
    expect(harnessImageInputUnavailableReason("antigravity-acp")).toBeNull();
    expect(harnessImageInputUnavailableReason("antigravity-cli")).toBe(ANTIGRAVITY_IMAGE_INPUT_UNAVAILABLE_REASON);
    expect(ANTIGRAVITY_EXPLICIT_COMPACTION_UNAVAILABLE_REASON).toBe(
      "Antigravity does not expose explicit context compaction.",
    );
  });
});
