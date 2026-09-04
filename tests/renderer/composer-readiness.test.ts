import { describe, expect, it } from "vitest";

import {
  composerProviderReady,
  composerRouteReadiness,
} from "../../src/renderer/src/utils/composerReadiness";
import {
  providerNativeModelSelection,
  type ModelSelection,
} from "../../src/shared/model-routing";
import type {
  ModelBackendProfileView,
  ProviderInfo,
} from "../../src/shared/contracts";

function provider(
  overrides: Partial<ProviderInfo> = {},
): ProviderInfo {
  return {
    id: "codex",
    label: "Codex",
    command: "codex",
    available: true,
    version: "1.0.0",
    executable: "/opt/bin/codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: "Connected",
    models: [],
    rateLimits: [],
    metadataState: {
      models: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
      rateLimits: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
    },
    ...overrides,
  };
}

function profile(
  overrides: Partial<ModelBackendProfileView> = {},
): ModelBackendProfileView {
  return {
    id: "custom:team",
    displayName: "Team gateway",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 1,
    endpointIdentity: "endpoint:team",
    preset: "custom",
    allowInsecureLocalhost: false,
    credentialGeneration: "generation:1",
    models: [],
    routing: { mode: "simple", primaryModelId: "team-model" },
    capabilityHints: [],
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-27T10:00:00.000Z",
    endpointHost: "gateway.example.test",
    authState: "configured",
    connectionState: "connected",
    compatibility: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "custom:team",
      backendProtocol: "anthropic-messages",
      state: "partially-compatible",
      provenance: "probe",
      allowsModelSwitchWithinSession: false,
      reasonCode: "anthropic-probe-verified",
      reason: "The selected endpoint and model were verified.",
    },
    latestProbe: null,
    canDelete: true,
    canDisable: true,
    ...overrides,
  };
}

function customSelection(
  overrides: Partial<ModelSelection> = {},
): ModelSelection {
  return {
    harnessId: "claude-agent-sdk",
    backendProfileId: "custom:team",
    backendProfileDisplayName: "Team gateway",
    modelId: "team-model",
    alias: null,
    reasoningEffort: null,
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: 1,
    ...overrides,
  };
}

describe("composer route readiness", () => {
  it("keeps a healthy native route quiet and uses native canRun as its gate", () => {
    const selection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "gpt-5.6",
    });
    expect(composerRouteReadiness({
      provider: provider(),
      profile: undefined,
      selection,
    })).toEqual({ ready: true });
    expect(composerRouteReadiness({
      provider: provider({
        canRun: false,
        authState: "unauthenticated",
        statusMessage: "Sign in required",
      }),
      profile: undefined,
      selection,
    })).toMatchObject({
      ready: false,
      action: "connect",
      title: "Codex needs a connection",
    });
  });

  it("uses backend route truth for custom Claude instead of native account auth", () => {
    const claudeHarness = provider({
      id: "claude",
      label: "Claude",
      command: "claude",
      executable: "/opt/bin/claude",
      authState: "unauthenticated",
      canRun: false,
      statusMessage: "Sign in required",
    });
    expect(composerRouteReadiness({
      provider: claudeHarness,
      profile: profile(),
      selection: customSelection(),
    })).toEqual({ ready: true });
    expect(composerProviderReady(claudeHarness, profile())).toBe(true);
  });

  it("names a missing backend credential and offers only Add key", () => {
    const readiness = composerRouteReadiness({
      provider: provider({
        id: "claude",
        label: "Claude",
        command: "claude",
        executable: "/opt/bin/claude",
        canRun: false,
      }),
      profile: profile({ authState: "missing" }),
      selection: customSelection(),
    });
    expect(readiness).toMatchObject({
      ready: false,
      transient: false,
      badge: "Key missing",
      title: "Team gateway needs a key",
      action: "add-key",
    });
    expect(JSON.stringify(readiness)).not.toContain("Claude needs attention");
  });

  it("opens setup instead of advertising a probe for a disabled backend", () => {
    expect(composerRouteReadiness({
      provider: provider({ id: "claude", label: "Claude", command: "claude" }),
      profile: profile({ enabled: false }),
      selection: customSelection(),
    })).toMatchObject({
      ready: false,
      badge: "Disabled",
      action: "configure",
    });
  });

  it("distinguishes a missing harness CLI from backend configuration", () => {
    expect(composerRouteReadiness({
      provider: provider({
        id: "claude",
        label: "Claude",
        command: "claude",
        available: false,
        executable: null,
        installState: "not-installed",
        authState: "unknown",
        canRun: false,
        statusMessage: "CLI not found",
      }),
      profile: profile({ authState: "missing" }),
      selection: customSelection(),
    })).toMatchObject({
      ready: false,
      badge: "CLI missing",
      title: "Claude harness CLI not found",
      action: "install",
    });
  });

  it("names Gemini readiness without claiming unavailable capabilities", () => {
    const selection = customSelection({
      harnessId: "gemini-acp",
      backendProfileId: "builtin:gemini",
      backendProfileDisplayName: "Google Gemini",
      modelId: "provider-default",
      backendConfigurationRevision: 0,
    });
    expect(composerRouteReadiness({
      provider: provider({
        id: "gemini",
        label: "Gemini",
        command: "gemini",
        available: false,
        executable: null,
        installState: "not-installed",
        authState: "unknown",
        canRun: false,
        statusMessage: "Gemini CLI not found",
      }),
      profile: undefined,
      selection,
    })).toMatchObject({
      ready: false,
      title: "Gemini CLI not found",
      action: "install",
    });

    expect(composerRouteReadiness({
      provider: provider({
        id: "gemini",
        label: "Gemini",
        command: "gemini",
        version: "0.29.5",
        executable: "/opt/bin/gemini",
        installState: "installed",
        authState: "unknown",
        canRun: false,
        statusMessage:
          "Gemini 0.29.5 is installed, but stable ACP requires 0.58.0 or newer; update Gemini",
      }),
      profile: undefined,
      selection,
    })).toMatchObject({
      ready: false,
      badge: "Update needed",
      title: "Gemini cannot run this route",
      action: "refresh",
    });
  });

  it("offers Probe for missing, stale, or failed compatibility evidence", () => {
    for (const [reasonCode, state] of [
      ["probe-required", "unknown"],
      ["probe-stale", "unknown"],
      ["probe-failed", "unavailable"],
    ] as const) {
      expect(composerRouteReadiness({
        provider: provider({
          id: "claude",
          label: "Claude",
          command: "claude",
          executable: "/opt/bin/claude",
        }),
        profile: profile({
          connectionState: reasonCode === "probe-failed" ? "failed" : "not-tested",
          compatibility: {
            ...profile().compatibility,
            reasonCode,
            state,
            reason: "Probe this exact endpoint and model.",
          },
        }),
        selection: customSelection(),
      })).toMatchObject({
        ready: false,
        title: "Team gateway needs a probe",
        detail: "Probe this exact endpoint and model.",
        action: "probe",
      });
    }
  });

  it("keeps text-compatible Codex unavailable until its inert tool check passes", () => {
    const codexProfile = profile({
      harnessId: "codex-app-server",
      protocol: "openai-responses",
      connectionState: "limited",
      compatibility: {
        harnessId: "codex-app-server",
        backendProfileId: "custom:team",
        backendProtocol: "openai-responses",
        state: "unavailable",
        provenance: "probe",
        allowsModelSwitchWithinSession: false,
        reasonCode: "responses-tools-unverified",
        reason: "Codex requires this Responses backend to pass the inert tool-call compatibility check.",
      },
    });
    const readiness = composerRouteReadiness({
      provider: provider(),
      profile: codexProfile,
      selection: customSelection({ harnessId: "codex-app-server" }),
    });
    expect(readiness).toMatchObject({
      ready: false,
      badge: "Probe needed",
      action: "probe",
      detail: "Codex requires this Responses backend to pass the inert tool-call compatibility check.",
    });
    expect(composerProviderReady(provider(), codexProfile)).toBe(false);
  });

  it("keeps checking states transient and action-free", () => {
    expect(composerRouteReadiness({
      provider: provider({
        canRun: false,
        installState: "checking",
        authState: "checking",
        available: false,
        executable: null,
      }),
      profile: undefined,
      selection: providerNativeModelSelection({ providerId: "codex" }),
    })).toMatchObject({
      ready: false,
      transient: true,
      action: null,
    });
    expect(composerRouteReadiness({
      provider: provider({
        id: "claude",
        label: "Claude",
        command: "claude",
        executable: "/opt/bin/claude",
      }),
      profile: profile({ authState: "checking" }),
      selection: customSelection(),
    })).toMatchObject({
      ready: false,
      transient: true,
      title: "Checking Team gateway",
      action: null,
    });
  });

  it("keeps Kimi probe failure optional while naming a missing Kimi key", () => {
    const kimi = profile({
      id: "builtin:kimi-code",
      displayName: "Kimi Code",
      preset: "kimi-code",
      connectionState: "failed",
      compatibility: {
        ...profile().compatibility,
        backendProfileId: "builtin:kimi-code",
        state: "unavailable",
        reasonCode: "probe-failed",
        reason: "The optional live probe failed.",
      },
    });
    const selection = customSelection({
      backendProfileId: "builtin:kimi-code",
      backendProfileDisplayName: "Kimi Code",
    });
    const claudeHarness = provider({
      id: "claude",
      label: "Claude",
      command: "claude",
      executable: "/opt/bin/claude",
      authState: "unauthenticated",
      canRun: false,
    });
    expect(composerRouteReadiness({
      provider: claudeHarness,
      profile: kimi,
      selection,
    })).toEqual({ ready: true });
    expect(composerRouteReadiness({
      provider: claudeHarness,
      profile: { ...kimi, authState: "missing" },
      selection,
    })).toMatchObject({
      ready: false,
      title: "Kimi Code needs a key",
      action: "add-key",
    });
  });
});
