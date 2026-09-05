import { describe, expect, it } from "vitest";

import type { BackendCompatibilityProbeResult } from "../src/shared/backend-probe";
import {
  MODEL_CAPABILITY_IDS,
  providerNativeBackendProfile,
  resolveHarnessBackendCompatibility,
  type KnownHarnessId,
  type ModelBackendProfile,
} from "../src/shared/model-routing";
import { backendProbeTestAuthority } from "./helpers/backend-probe-authority";

const checkedAt = "2026-07-25T08:00:00.000Z";
const evaluatedAt = new Date(checkedAt);

function customProfile(
  protocol: ModelBackendProfile["protocol"],
  id = `custom:${protocol}`,
): ModelBackendProfile {
  return {
    id,
    displayName: "Private gateway",
    protocol,
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 3,
    endpointIdentity: `endpoint:${protocol}:3`,
  };
}

function successfulProbe(
  profile: ModelBackendProfile,
  modelId: string,
  overrides: Partial<BackendCompatibilityProbeResult> = {},
): BackendCompatibilityProbeResult {
  return {
    profileId: profile.id,
    backendConfigurationRevision: profile.configurationRevision,
    endpointIdentity: profile.endpointIdentity,
    protocol: profile.protocol,
    modelId,
    compatibility: "protocol-compatible",
    protocolVerified: true,
    modelVerified: true,
    capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
      id,
      state: id === "streaming" || (
        id === "tools" && profile.protocol === "openai-responses"
      ) ? "verified" : "unknown",
      provenance: id === "streaming" || (
        id === "tools" && profile.protocol === "openai-responses"
      ) ? "probe" : "unknown",
      detail: null,
      checkedAt,
    })),
    contextWindow: {
      tokens: null,
      state: "unknown",
      provenance: "unknown",
      detail: null,
      checkedAt,
    },
    failure: null,
    checkedAt,
    authority: backendProbeTestAuthority(checkedAt),
    ...overrides,
  };
}

describe("harness-specific backend compatibility", () => {
  it("keeps all native harnesses available without claiming Cursor owns model selection", () => {
    const matrix: Array<[KnownHarnessId, Parameters<typeof providerNativeBackendProfile>[0], string]> = [
      ["codex-app-server", "codex", "native-backend"],
      ["claude-agent-sdk", "claude", "native-backend"],
      ["cursor-acp", "cursor", "cursor-managed"],
      ["gemini-acp", "gemini", "gemini-managed"],
      ["kimi-acp", "kimi", "kimi-managed"],
      ["opencode-sdk", "opencode", "opencode-native-catalog"],
    ];
    for (const [harnessId, providerId, reasonCode] of matrix) {
      expect(resolveHarnessBackendCompatibility(
        harnessId,
        providerNativeBackendProfile(providerId),
      )).toMatchObject({
        state: "verified",
        provenance: "built-in",
        reasonCode,
      });
    }
    expect(resolveHarnessBackendCompatibility(
      "cursor-acp",
      providerNativeBackendProfile("cursor"),
    ).allowsModelSwitchWithinSession).toBe(false);
  });

  it("enables only the exact probed Responses model for Codex", () => {
    const profile = customProfile("openai-responses");
    const modelId = "gpt-compatible";
    expect(resolveHarnessBackendCompatibility("codex-app-server", profile, {
      evaluatedAt,
      modelId,
    })).toMatchObject({
      state: "unknown",
      reasonCode: "probe-required",
    });

    const probe = successfulProbe(profile, modelId);
    expect(resolveHarnessBackendCompatibility("codex-app-server", profile, {
      evaluatedAt,
      modelId,
      probe,
    })).toMatchObject({
      state: "partially-compatible",
      provenance: "probe",
      reasonCode: "responses-probe-verified",
    });
    const textOnlyProbe = successfulProbe(profile, modelId, {
      capabilities: successfulProbe(profile, modelId).capabilities.map(
        (capability) => capability.id === "tools"
          ? { ...capability, state: "unknown", provenance: "unknown" }
          : capability,
      ),
    });
    expect(resolveHarnessBackendCompatibility("codex-app-server", profile, {
      evaluatedAt,
      modelId,
      probe: textOnlyProbe,
    })).toMatchObject({
      state: "unavailable",
      provenance: "probe",
      reasonCode: "responses-tools-unverified",
    });
    expect(resolveHarnessBackendCompatibility("codex-app-server", {
      ...profile,
      configurationRevision: 4,
    }, {
      evaluatedAt,
      modelId,
      probe,
    })).toMatchObject({
      state: "unknown",
      reasonCode: "probe-stale",
    });
    expect(resolveHarnessBackendCompatibility("codex-app-server", profile, {
      evaluatedAt,
      modelId: "another-model",
      probe,
    }).reasonCode).toBe("probe-stale");
  });

  it("enables only exact Anthropic Messages evidence for custom Claude profiles", () => {
    const profile = customProfile("anthropic-messages");
    const modelId = "claude-compatible";
    const probe = successfulProbe(profile, modelId);
    expect(resolveHarnessBackendCompatibility("claude-agent-sdk", profile, {
      evaluatedAt,
      modelId,
      probe,
    })).toMatchObject({
      state: "partially-compatible",
      provenance: "probe",
      reasonCode: "anthropic-probe-verified",
    });
    expect(resolveHarnessBackendCompatibility("claude-agent-sdk", profile, {
      evaluatedAt,
      modelId,
      probe: successfulProbe(profile, modelId, {
        protocolVerified: false,
        compatibility: "partially-compatible",
      }),
    })).toMatchObject({
      state: "unavailable",
      reasonCode: "probe-unverified",
    });
  });

  it("does not route Chat Completions-shaped profiles through Codex", () => {
    const ordinaryChatProfile = customProfile(
      "anthropic-messages",
      "custom:ordinary-chat-completions",
    );
    expect(resolveHarnessBackendCompatibility(
      "codex-app-server",
      ordinaryChatProfile,
      {
        evaluatedAt,
        modelId: "chat-model",
        probe: successfulProbe(ordinaryChatProfile, "chat-model"),
      },
    )).toMatchObject({
      state: "unavailable",
      reasonCode: "protocol-mismatch",
    });
  });

  it("keeps Cursor and OpenCode backend ownership native", () => {
    const cursor = customProfile("cursor-managed", "custom:cursor");
    const openCode = customProfile("opencode-native", "custom:opencode");
    expect(resolveHarnessBackendCompatibility("cursor-acp", cursor, {
      evaluatedAt,
      modelId: "cursor-model",
      probe: successfulProbe(cursor, "cursor-model"),
    })).toMatchObject({
      state: "unavailable",
      reasonCode: "cursor-managed",
    });
    expect(resolveHarnessBackendCompatibility("opencode-sdk", openCode, {
      evaluatedAt,
      modelId: "provider/model",
      probe: successfulProbe(openCode, "provider/model"),
    })).toMatchObject({
      state: "unavailable",
      reasonCode: "opencode-native-catalog",
    });
  });

  it("uses sanitized fixed failure reasons instead of provider diagnostics", () => {
    const profile = customProfile("openai-responses");
    const result = resolveHarnessBackendCompatibility("codex-app-server", profile, {
      evaluatedAt,
      modelId: "model",
      probe: successfulProbe(profile, "model", {
        compatibility: "unavailable",
        protocolVerified: false,
        modelVerified: false,
        failure: {
          code: "invalid-credentials",
          message: "Authorization secret-should-not-render",
          retryAfterSeconds: null,
        },
      }),
    });
    expect(result.reasonCode).toBe("probe-failed");
    expect(result.reason).not.toContain("secret-should-not-render");
  });
});
