import { describe, expect, it } from "vitest";

import {
  backendProfileCreatePayload,
  backendProfileUpdatePayload,
} from "../../src/renderer/src/lib/backendProfileCommands";
import {
  backendEditDraftFromDetail,
  backendProfileSemanticUpdate,
  mergeDiscoveredModels,
} from "../../src/renderer/src/utils/backendProfileDraft";
import {
  modelBackendProfileDraftSchema,
  modelBackendProfileUpdateSchema,
  type ModelBackendProfileDetail,
} from "../../src/shared/backend-profile-settings";
import { backendView, probeResult } from "./backend-view-fixtures";

const PERSISTED_MODEL_FIELDS = ["capabilities", "contextWindowTokens", "displayName", "id", "reasoningOptions"];

function detail(): ModelBackendProfileDetail {
  const id = "custom:anthropic";
  const compatibility = {
    harnessId: "claude-agent-sdk" as const,
    backendProfileId: id,
    backendProtocol: "anthropic-messages" as const,
    state: "verified" as const,
    provenance: "probe" as const,
    allowsModelSwitchWithinSession: false,
    reasonCode: "anthropic-probe-verified" as const,
    reason: "The endpoint passed the compatibility probe.",
  };
  return backendView<ModelBackendProfileDetail>({
    id,
    displayName: "Anthropic API key",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 1,
    endpointIdentity: "endpoint:anthropic",
    preset: "anthropic-api-key",
    baseUrl: "https://api.anthropic.com",
    allowInsecureLocalhost: false,
    credentialGeneration: "generation:1",
    models: [{
      id: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      contextWindowTokens: 200_000,
      reasoningOptions: [{ value: "high", label: "High", description: "Deep reasoning" }],
      capabilities: [],
      compatibility,
      latestProbe: probeResult(id, "claude-opus-5-5"),
    }],
    routing: { mode: "simple", primaryModelId: "claude-opus-5-5" },
    capabilityHints: [],
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
    endpointHost: "api.anthropic.com",
    authState: "configured",
    connectionState: "connected",
    compatibility,
    latestProbe: null,
    canDelete: true,
    canDisable: true,
  });
}

function modelFields(models: readonly object[] | undefined): string[][] {
  return (models ?? []).map((model) => Object.keys(model).sort());
}

describe("backend profile command payloads", () => {
  it("sends only persisted model fields when the view's models are passed straight through", () => {
    const view = detail();
    const update = backendProfileUpdatePayload({ models: view.models });
    expect(modelFields(update.models)).toEqual([PERSISTED_MODEL_FIELDS]);
    expect(modelBackendProfileUpdateSchema.safeParse(update).success).toBe(true);
    const create = backendProfileCreatePayload({ preset: "anthropic-api-key", models: view.models });
    expect(modelFields("models" in create ? create.models : undefined)).toEqual([PERSISTED_MODEL_FIELDS]);
    expect(modelBackendProfileDraftSchema.safeParse(create).success).toBe(true);
  });

  it("sends only persisted model fields from the Models editor and the discovery picker", () => {
    const view = detail();
    const original = backendEditDraftFromDetail(view);
    const discovered = mergeDiscoveredModels(original, [{ id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" }]);
    const editorUpdate = backendProfileUpdatePayload(backendProfileSemanticUpdate(original, discovered));
    expect(modelFields(editorUpdate.models)).toEqual([PERSISTED_MODEL_FIELDS, PERSISTED_MODEL_FIELDS]);
    expect(modelBackendProfileUpdateSchema.safeParse(editorUpdate).success).toBe(true);
    const pickerUpdate = backendProfileUpdatePayload(mergeDiscoveredModels({ models: [], routing: view.routing }, [
      { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
    ]));
    expect(modelFields(pickerUpdate.models)).toEqual([PERSISTED_MODEL_FIELDS]);
    expect(modelBackendProfileUpdateSchema.safeParse(pickerUpdate).success).toBe(true);
  });

  it("re-enables with an enabled-only update", () => {
    expect(backendProfileUpdatePayload({ enabled: true })).toEqual({ enabled: true });
  });
});
