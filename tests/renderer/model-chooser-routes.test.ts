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

describe("composer model chooser route projection", () => {
  it("builds exact native routes and preserves the active selection settings", () => {
    const current = nativeModelSelection({
      providerId: "codex",
      modelId: "alpha",
      alias: "Active Alpha",
      reasoningEffort: "xhigh",
    });
    const routes = buildComposerModelRoutes([provider()], [], current);

    expect(routes.map(({ modelId }) => modelId)).toEqual(["alpha", "beta"]);
    expect(routes[0]?.selection).toEqual(current);
    expect(routes[0]).toMatchObject({
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      providerId: "codex",
      selectable: true,
    });
    expect(routes[0]?.continuationIdentity.modelIdentity).toBeNull();
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
      unavailableReason: "This saved model route is no longer available.",
    });
  });
});
