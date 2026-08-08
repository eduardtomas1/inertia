import { describe, expect, it } from "vitest";

import { resolveComposerRouteState } from "../../src/renderer/src/utils/composerRouteState";
import type {
  ModelBackendProfileView,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  modelSelectionSchema,
  nativeModelSelection,
} from "../../src/shared/model-routing";

function provider(
  freshness: ProviderInfo["metadataState"]["models"]["freshness"] = "fresh",
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
    models: [{
      id: "gpt-current",
      label: "GPT Current",
      description: "Current catalog model",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [{
        value: "high",
        label: "High",
        description: "Deep reasoning",
      }],
      defaultReasoningEffort: "high",
    }],
    rateLimits: [],
    metadataState: {
      models: {
        freshness,
        provenance: freshness === "unavailable" ? null : "provider",
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
  };
}

function customProfile(): ModelBackendProfileView {
  return {
    id: "custom:team",
    displayName: "Team gateway",
    harnessId: "codex-app-server",
    protocol: "openai-responses",
    authenticationMode: "none",
    source: "custom",
    enabled: true,
    configurationRevision: 4,
    endpointIdentity: "endpoint:team:4",
    preset: "custom",
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models: [{
      id: "team-model",
      displayName: "Team model",
      contextWindowTokens: 120_000,
      reasoningOptions: [{
        value: "medium",
        label: "Medium",
        description: "Balanced reasoning",
      }],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: "team-model" },
    capabilityHints: [],
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:00:00.000Z",
    endpointHost: "team.example.test",
    authState: "not-required",
    connectionState: "connected",
    compatibility: {
      harnessId: "codex-app-server",
      backendProfileId: "custom:team",
      backendProtocol: "openai-responses",
      state: "partially-compatible",
      provenance: "probe",
      allowsModelSwitchWithinSession: false,
      reasonCode: "responses-probe-verified",
      reason: "The exact route was probed.",
    },
    latestProbe: null,
    canDelete: true,
    canDisable: true,
  };
}

describe("exact composer route state", () => {
  it("keeps Provider default ready beside a fresh concrete catalog", () => {
    const state = resolveComposerRouteState({
      conversationProviderId: "codex",
      selection: nativeModelSelection({
        providerId: "codex",
        modelId: "provider-default",
        reasoningEffort: "high",
      }),
      providers: [provider()],
      profiles: [],
    });

    expect(state).toMatchObject({
      providerId: "codex",
      exactIdentity: true,
      historical: false,
      model: { id: "provider-default", label: "Provider default" },
      readiness: { ready: true },
    });
  });

  it("never falls through from a missing custom backend to a native model", () => {
    const selection = modelSelectionSchema.parse({
      ...nativeModelSelection({ providerId: "codex", modelId: "gpt-current" }),
      backendProfileId: "custom:removed",
      backendProfileDisplayName: "Removed gateway",
      backendConfigurationRevision: 7,
    });
    const state = resolveComposerRouteState({
      conversationProviderId: "codex",
      selection,
      providers: [provider()],
      profiles: [],
    });

    expect(state.model).toBeUndefined();
    expect(state.profile).toBeUndefined();
    expect(state.historical).toBe(true);
    expect(state.readiness).toMatchObject({
      ready: false,
      title: "Removed gateway is unavailable",
    });
  });

  it("blocks concrete native routes on stale catalogs without claiming removal", () => {
    const selection = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-current",
      reasoningEffort: "high",
    });
    const state = resolveComposerRouteState({
      conversationProviderId: "codex",
      selection,
      providers: [provider("stale")],
      profiles: [],
    });

    expect(state.model?.id).toBe("gpt-current");
    expect(state.readiness).toMatchObject({
      ready: false,
      badge: "Refresh needed",
      action: "refresh",
    });
    expect(state.readiness).not.toMatchObject({ badge: "Model removed" });
  });

  it("blocks a removed model only when a fresh catalog proves removal", () => {
    const state = resolveComposerRouteState({
      conversationProviderId: "codex",
      selection: nativeModelSelection({
        providerId: "codex",
        modelId: "gpt-removed",
        alias: "GPT Removed",
      }),
      providers: [provider()],
      profiles: [],
    });

    expect(state.readiness).toMatchObject({
      ready: false,
      badge: "Model removed",
      title: "GPT Removed is unavailable",
    });
  });

  it("rejects provider disagreement, stale revisions, and unsupported reasoning", () => {
    const profile = customProfile();
    const base = modelSelectionSchema.parse({
      harnessId: profile.harnessId,
      backendProfileId: profile.id,
      backendProfileDisplayName: "Historical team label",
      modelId: "team-model",
      alias: "Team model",
      reasoningEffort: "medium",
      contextWindowOverride: 120_000,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: profile.configurationRevision,
    });

    expect(resolveComposerRouteState({
      conversationProviderId: "claude",
      selection: base,
      providers: [provider()],
      profiles: [profile],
    }).readiness).toMatchObject({ badge: "Route mismatch" });
    expect(resolveComposerRouteState({
      conversationProviderId: "codex",
      selection: { ...base, backendConfigurationRevision: 3 },
      providers: [provider()],
      profiles: [profile],
    }).readiness).toMatchObject({ badge: "Route changed", action: null });
    expect(resolveComposerRouteState({
      conversationProviderId: "codex",
      selection: {
        ...nativeModelSelection({ providerId: "codex", modelId: "gpt-current" }),
        backendConfigurationRevision: 99,
      },
      providers: [provider()],
      profiles: [],
    }).readiness).toMatchObject({ badge: "Route changed", action: null });
    expect(resolveComposerRouteState({
      conversationProviderId: "codex",
      selection: { ...base, reasoningEffort: "unsupported" },
      providers: [provider()],
      profiles: [profile],
    }).readiness).toMatchObject({ badge: "Reasoning unavailable" });
  });
});
