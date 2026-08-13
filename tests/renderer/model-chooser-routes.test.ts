import { describe, expect, it } from "vitest";

import {
  buildComposerModelRoutes,
  selectedModelSearchRoute,
} from "../../src/renderer/src/utils/modelChooserRoutes";
import type {
  ModelBackendProfileView,
  ProviderInfo,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

function provider(): ProviderInfo {
  return {
    id: "codex",
    label: "Codex",
    command: "codex",
    available: true,
    version: "1.0.0",
    executable: "/usr/bin/codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: "alpha",
      label: "Alpha",
      description: "Alpha model",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [],
      defaultReasoningEffort: "medium",
    }, {
      id: "beta",
      label: "Beta",
      description: "Beta model",
      isDefault: false,
      inputModalities: ["text"],
      reasoningOptions: [],
      defaultReasoningEffort: "high",
    }],
    rateLimits: [],
    metadataState: {
      models: {
        freshness: "fresh",
        provenance: "provider",
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

function claudeWithoutCatalog(): ProviderInfo {
  return {
    ...provider(),
    id: "claude",
    label: "Claude",
    command: "claude",
    authState: "unauthenticated",
    canRun: false,
    statusMessage: "Sign in required",
    models: [],
  };
}

function customProfile(
  state: ModelBackendProfileView["compatibility"]["state"] =
    "partially-compatible",
): ModelBackendProfileView {
  return {
    id: "custom:team",
    displayName: "Team gateway",
    protocol: "openai-responses",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 4,
    endpointIdentity: "opaque-team-route-4",
    harnessId: "codex-app-server",
    preset: "custom",
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models: [{
      id: "team-alpha",
      displayName: "Team Alpha",
      contextWindowTokens: 120_000,
      reasoningOptions: [{
        value: "medium",
        label: "Medium",
        description: "Balanced",
      }],
      capabilities: [],
    }],
    routing: {
      mode: "simple",
      primaryModelId: "team-alpha",
    },
    capabilityHints: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    endpointHost: "secret.example.invalid",
    authState: "configured",
    connectionState: "limited",
    compatibility: {
      harnessId: "codex-app-server",
      backendProfileId: "custom:team",
      backendProtocol: "openai-responses",
      state,
      provenance: state === "unknown" ? "unknown" : "probe",
      allowsModelSwitchWithinSession: false,
      reasonCode: state === "unknown"
        ? "probe-required"
        : "responses-probe-verified",
      reason: state === "unknown"
        ? "Run a compatibility check."
        : "The exact Responses route was verified.",
    },
    latestProbe: null,
    canDelete: true,
    canDisable: true,
  };
}

function nativeProfile(): ModelBackendProfileView {
  return {
    ...customProfile(),
    id: "builtin:openai",
    displayName: "OpenAI",
    protocol: "openai-responses",
    authenticationMode: "harness-managed",
    source: "built-in",
    configurationRevision: 0,
    endpointIdentity: null,
    preset: "native",
    models: provider().models.map((model) => ({
      id: model.id,
      displayName: model.label,
      contextWindowTokens: null,
      reasoningOptions: model.reasoningOptions,
      capabilities: [],
    })),
    routing: { mode: "simple", primaryModelId: "alpha" },
    endpointHost: null,
    authState: "harness-managed",
    connectionState: "connected",
    canDelete: false,
    canDisable: false,
  };
}

describe("composer model chooser route projection", () => {
  it("builds exact native routes and preserves the active selection settings", () => {
    const current = nativeModelSelection({
      providerId: "codex",
      modelId: "alpha",
      alias: "Active Alpha",
      reasoningEffort: "xhigh",
    });
    const routes = buildComposerModelRoutes([provider()], [], current);

    expect(routes.map(({ modelId }) => modelId)).toEqual([
      "provider-default",
      "alpha",
      "beta",
    ]);
    expect(routes[1]?.selection).toEqual(current);
    expect(routes[0]).toMatchObject({
      displayName: "Provider default",
      modelId: "provider-default",
      selectable: true,
    });
    expect(routes[1]).toMatchObject({
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      providerId: "codex",
      selectable: true,
    });
    expect(routes[1]?.continuationIdentity.modelIdentity).toBeNull();
    expect(buildComposerModelRoutes(
      [provider()],
      [],
      current,
      { codex: "Work Codex" },
    )[1]?.providerLabel).toBe("Work Codex");
  });

  it("preserves Fast only across compatible native models and discloses resets", () => {
    const codex = provider();
    for (const model of codex.models) {
      model.fastMode = {
        providerValue: "priority",
        label: "Fast",
        description: "Faster responses with increased usage.",
        isDefault: false,
      };
    }
    const current = nativeModelSelection({
      providerId: "codex",
      modelId: "alpha",
      providerOptions: { fastMode: "priority" },
    });
    const compatible = buildComposerModelRoutes([codex], [], current);
    expect(compatible.find(({ modelId }) => modelId === "beta"))
      .toMatchObject({
        responseSpeed: "Fast",
        supportsNativeFastModeControl: true,
        selection: { providerOptions: { fastMode: "priority" } },
      });
    expect(buildComposerModelRoutes(
      [codex],
      [nativeProfile()],
      current,
    ).find(({ modelId }) => modelId === "beta"))
      .toMatchObject({
        responseSpeed: "Fast",
        selection: { providerOptions: { fastMode: "priority" } },
      });

    codex.models[1]!.fastMode = null;
    const incompatible = buildComposerModelRoutes([codex], [], current);
    expect(incompatible.find(({ modelId }) => modelId === "beta"))
      .toMatchObject({
        speedChangeNote: "Fast turns off",
        supportsNativeFastModeControl: false,
        selection: { providerOptions: {} },
      });
    expect(incompatible.find(({ modelId }) => modelId === "beta")?.responseSpeed)
      .toBeUndefined();

    const crossProvider = buildComposerModelRoutes(
      [codex, claudeWithoutCatalog()],
      [],
      current,
    ).find(({ providerId }) => providerId === "claude");
    expect(crossProvider).toMatchObject({
      speedChangeNote: "Fast turns off",
      selection: { providerOptions: {} },
    });
    expect(crossProvider?.responseSpeed).toBeUndefined();
  });

  it("keeps Standard selectable when the provider default is Fast", () => {
    const codex = provider();
    codex.models[0]!.fastMode = {
      providerValue: "priority",
      label: "Fast",
      description: "Provider-default Fast needs tri-state support.",
      isDefault: true,
    };
    const routes = buildComposerModelRoutes(
      [codex],
      [],
      nativeModelSelection({ providerId: "codex", modelId: "alpha" }),
    );
    expect(routes.find(({ modelId }) => modelId === "alpha"))
      .toMatchObject({
        selectable: true,
        unavailableReason: null,
        responseSpeed: "Standard",
      });
    expect(routes.find(({ modelId }) => modelId === "provider-default"))
      .toMatchObject({
        selectable: true,
        unavailableReason: null,
        responseSpeed: "Standard",
      });

    for (const providerId of ["cursor", "opencode"] as const) {
      const unsupported = provider();
      unsupported.id = providerId;
      unsupported.models.forEach((model) => {
        model.fastMode = {
          providerValue: "priority",
          label: "Injected Fast",
          description: "Unsupported metadata must stay hidden.",
          isDefault: false,
        };
      });
      expect(buildComposerModelRoutes(
        [unsupported],
        [],
        nativeModelSelection({ providerId, modelId: "alpha" }),
      ).find(({ modelId }) => modelId === "alpha")?.responseSpeed)
        .toBeUndefined();
    }

    for (const [providerId, wrongValue] of [
      ["codex", "fast"],
      ["claude", "priority"],
    ] as const) {
      const malformed = provider();
      malformed.id = providerId;
      malformed.models.forEach((model) => {
        model.fastMode = {
          providerValue: wrongValue,
          label: "Wrong Fast",
          description: "Wrong native value.",
          isDefault: false,
        };
      });
      expect(buildComposerModelRoutes(
        [malformed],
        [],
        nativeModelSelection({ providerId, modelId: "alpha" }),
      ).find(({ modelId }) => modelId === "alpha")?.responseSpeed)
        .toBeUndefined();
    }
  });

  it("keeps known concrete catalog routes selectable while metadata refreshes", () => {
    const staleProvider = provider();
    staleProvider.metadataState.models.freshness = "stale";
    const routes = buildComposerModelRoutes(
      [staleProvider],
      [nativeProfile()],
      nativeModelSelection({ providerId: "codex", modelId: "alpha" }),
    );

    expect(routes.find(({ modelId }) => modelId === "provider-default"))
      .toMatchObject({ selectable: true, unavailableReason: null });
    expect(routes.find(({ modelId }) => modelId === "alpha"))
      .toMatchObject({
        selectable: true,
        unavailableReason: null,
      });
  });

  it("projects custom compatibility without leaking endpoint or credential metadata", () => {
    const profile = customProfile();
    const current = nativeModelSelection({ providerId: "codex" });
    const [route] = buildComposerModelRoutes([provider()], [profile], current);

    expect(route).toMatchObject({
      displayName: "Team Alpha",
      backendProfileName: "Team gateway",
      source: "custom",
      selectable: true,
      rowCompatibility: {
        affectsSelection: true,
        state: "partial",
      },
    });
    expect(route?.continuationIdentity).toMatchObject({
      endpointIdentity: "opaque-team-route-4",
      modelIdentity: "team-alpha",
    });
    expect(JSON.stringify(route)).not.toContain(profile.endpointHost);
    expect(JSON.stringify(route)).not.toContain("credential");
  });

  it("keeps an empty native Claude catalog selectable when other profiles exist", () => {
    const current = nativeModelSelection({ providerId: "codex" });
    const routes = buildComposerModelRoutes(
      [provider(), claudeWithoutCatalog()],
      [customProfile()],
      current,
    );

    expect(routes.find(({ providerId }) => providerId === "claude"))
      .toMatchObject({
        displayName: "Provider default",
        modelId: "provider-default",
        harnessId: "claude-agent-sdk",
        backendProfileId: "builtin:anthropic",
        providerId: "claude",
        selectable: true,
      });
  });

  it("does not preserve a selection from an older backend revision", () => {
    const profile = customProfile();
    const staleSelection = {
      ...nativeModelSelection({
        providerId: "codex",
        modelId: "team-alpha",
      }),
      harnessId: profile.harnessId,
      backendProfileId: profile.id,
      backendProfileDisplayName: profile.displayName,
      backendConfigurationRevision: profile.configurationRevision - 1,
    };
    const [route] = buildComposerModelRoutes(
      [provider()],
      [profile],
      staleSelection,
    );

    expect(route?.selection.backendConfigurationRevision)
      .toBe(profile.configurationRevision);
    expect(selectedModelSearchRoute([route!], staleSelection)).toMatchObject({
      selectable: false,
      unavailableReason: "Saved model route unavailable.",
    });
  });

  it("keeps unknown routes visible with a truthful disabled reason", () => {
    const [route] = buildComposerModelRoutes(
      [provider()],
      [customProfile("unknown")],
      nativeModelSelection({ providerId: "codex" }),
    );

    expect(route).toMatchObject({
      selectable: false,
      unavailableReason: "Run a compatibility check.",
      rowCompatibility: null,
    });
  });

  it("uses a non-selectable exact chip identity for a removed route", () => {
    const removed = {
      ...nativeModelSelection({
        providerId: "codex",
        modelId: "removed-model",
        alias: "Removed",
      }),
      backendProfileId: "custom:removed",
      backendProfileDisplayName: "Removed gateway",
    };
    const selected = selectedModelSearchRoute([], removed);

    expect(selected).toMatchObject({
      modelId: "removed-model",
      backendProfileId: "custom:removed",
      backendProfileName: "Removed gateway",
      source: "custom",
      selectable: false,
      unavailableReason: "Saved model route unavailable.",
    });
  });
});
