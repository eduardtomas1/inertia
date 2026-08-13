import { describe, expect, it } from "vitest";

import { resolveComposerRouteState } from "../../src/renderer/src/utils/composerRouteState";
import type {
  ModelBackendProfileView,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  modelSelectionSchema,
  nativeModelSelection,
  withModelSelectionFastMode,
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

  it("keeps a concrete native route ready while its known catalog entry is stale", () => {
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
    expect(state.readiness).toEqual({ ready: true });
    expect(state.historical).toBe(false);
  });

  it("still requires refresh for an unknown model when the native catalog is stale", () => {
    const stale = provider("stale");
    stale.models = [];
    const state = resolveComposerRouteState({
      conversationProviderId: "codex",
      selection: nativeModelSelection({
        providerId: "codex",
        modelId: "gpt-unknown",
        alias: "GPT Unknown",
      }),
      providers: [stale],
      profiles: [],
    });

    expect(state.model).toBeUndefined();
    expect(state.readiness).toMatchObject({
      ready: false,
      badge: "Refresh needed",
      action: "refresh",
    });
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

  it("blocks stale Fast routes until the exact model advertises the native value", () => {
    const standard = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-current",
      reasoningEffort: "high",
    });
    const fast = withModelSelectionFastMode(standard, "priority");
    expect(resolveComposerRouteState({
      conversationProviderId: "codex",
      selection: fast,
      providers: [provider()],
      profiles: [],
    }).readiness).toMatchObject({
      ready: false,
      badge: "Fast unavailable",
      action: "refresh",
    });

    const advertised = provider();
    advertised.models[0]!.fastMode = {
      providerValue: "priority",
      label: "Fast",
      description: "Faster responses with increased usage.",
      isDefault: false,
    };
    expect(resolveComposerRouteState({
      conversationProviderId: "codex",
      selection: fast,
      providers: [advertised],
      profiles: [],
    }).readiness).toEqual({ ready: true });

    advertised.models[0]!.fastMode!.providerValue = "turbo";
    const malformed = resolveComposerRouteState({
      conversationProviderId: "codex",
      selection: standard,
      providers: [advertised],
      profiles: [],
    });
    expect(malformed.model?.fastMode).toBeNull();
    expect(malformed.readiness).toEqual({ ready: true });

    advertised.models[0]!.fastMode = {
      providerValue: "priority",
      label: "Fast",
      description: "Provider default Fast needs tri-state support.",
      isDefault: true,
    };
    expect(resolveComposerRouteState({
      conversationProviderId: "codex",
      selection: standard,
      providers: [advertised],
      profiles: [],
    })).toMatchObject({
      model: { fastMode: { providerValue: "priority", isDefault: true } },
      readiness: { ready: true },
    });

    const cursor = provider();
    cursor.id = "cursor";
    cursor.models[0]!.fastMode = {
      providerValue: "fast",
      label: "Fast",
      description: "Unverified metadata must stay hidden.",
      isDefault: false,
    };
    const unsupported = resolveComposerRouteState({
      conversationProviderId: "cursor",
      selection: nativeModelSelection({
        providerId: "cursor",
        modelId: "gpt-current",
        reasoningEffort: "high",
      }),
      providers: [cursor],
      profiles: [],
    });
    expect(unsupported.model?.fastMode).toBeNull();
    expect(unsupported.readiness).toEqual({ ready: true });
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
