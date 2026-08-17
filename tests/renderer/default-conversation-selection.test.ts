import { describe, expect, it } from "vitest";

import { defaultSelectionForProject } from "../../src/renderer/src/utils/defaultConversationSelection";
import {
  defaultSettings,
  type ModelBackendProfileView,
  type ProviderInfo,
} from "../../src/shared/contracts";
import { modelSelectionSchema } from "../../src/shared/model-routing";

const projectId = "11111111-1111-4111-8111-111111111111";

function customSelection(revision: number) {
  return modelSelectionSchema.parse({
    harnessId: "codex-app-server",
    backendProfileId: "custom:team",
    backendProfileDisplayName: "Team gateway",
    backendConfigurationRevision: revision,
    modelId: "team-model",
    alias: "Team model",
    reasoningEffort: "medium",
    contextWindowOverride: 120_000,
    providerOptions: {},
    capabilities: [],
  });
}

function profile(): ModelBackendProfileView {
  return {
    id: "custom:team",
    displayName: "Team gateway",
    harnessId: "codex-app-server",
    protocol: "openai-responses",
    authenticationMode: "none",
    source: "custom",
    enabled: true,
    configurationRevision: 2,
    endpointIdentity: "endpoint:team:2",
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
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
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

function provider(freshness: "fresh" | "stale"): ProviderInfo {
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
    statusMessage: null,
    models: [],
    rateLimits: [],
    metadataState: {
      models: {
        freshness,
        provenance: "provider",
        updatedAt: "2026-08-01T00:00:00.000Z",
        lastAttemptedAt: "2026-08-01T00:00:00.000Z",
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

describe("default conversation selection", () => {
  it("preserves an explicitly stored effort for the provider-default model", () => {
    expect(defaultSelectionForProject({
      backendProfiles: [],
      backendDefaults: [],
      providers: [provider("fresh")],
    }, {
      ...defaultSettings,
      defaultModel: "",
      defaultReasoningEffort: "xhigh",
    }, projectId)).toMatchObject({
      modelId: "provider-default",
      reasoningEffort: "xhigh",
    });
  });

  it("skips a stale project default in favor of a valid global default", () => {
    const current = customSelection(2);
    const result = defaultSelectionForProject({
      backendProfiles: [profile()],
      backendDefaults: [
        {
          scope: "project",
          projectId,
          selection: customSelection(1),
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          scope: "global",
          projectId: null,
          selection: current,
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      providers: [],
    }, defaultSettings, projectId);

    expect(result).toEqual(current);
    expect(result).not.toBe(current);
  });

  it("falls back from a known-removed settings model but preserves stale truth", () => {
    const settings = {
      ...defaultSettings,
      defaultProvider: "codex" as const,
      defaultModel: "removed-model",
      defaultReasoningEffort: "high",
    };
    const input = {
      backendProfiles: [],
      backendDefaults: [],
      providers: [provider("fresh")],
    };

    expect(defaultSelectionForProject(input, settings, projectId)).toMatchObject({
      modelId: "provider-default",
      reasoningEffort: null,
    });
    expect(defaultSelectionForProject({
      ...input,
      providers: [provider("stale")],
    }, settings, projectId)).toMatchObject({
      modelId: "removed-model",
      reasoningEffort: "high",
    });
  });
});
