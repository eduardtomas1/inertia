import { describe, expect, it } from "vitest";

import { defaultSettings, type ModelBackendDefault } from "../../src/shared/contracts";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import { effectiveNewChatDefault } from "../../src/shared/new-chat-default";

const projectId = "11111111-1111-4111-8111-111111111111";

function nativeDefault(scope: "global" | "project", modelId: string, reasoningEffort: string | null): ModelBackendDefault {
  return {
    scope,
    projectId: scope === "global" ? null : projectId,
    selection: providerNativeModelSelection({ providerId: "claude", modelId, alias: modelId, reasoningEffort }),
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("effective new-chat default", () => {
  it("uses the settings when no backend default exists", () => {
    expect(effectiveNewChatDefault({ providers: [], backendProfiles: [], backendDefaults: [] }, {
      defaultProvider: "claude",
      defaultModel: "sonnet",
      defaultReasoningEffort: "high",
    })).toMatchObject({ source: "settings", providerId: "claude", modelId: "sonnet", reasoning: "high" });
  });

  it("prefers the global backend default over the settings", () => {
    expect(effectiveNewChatDefault({
      providers: [],
      backendProfiles: [],
      backendDefaults: [nativeDefault("global", "opus", "medium")],
    }, defaultSettings)).toMatchObject({ source: "global-backend", providerId: "claude", modelId: "opus", reasoning: "medium" });
  });

  it("prefers a project backend default only when a project is given", () => {
    const snapshot = {
      providers: [],
      backendProfiles: [],
      backendDefaults: [nativeDefault("global", "opus", null), nativeDefault("project", "haiku", null)],
    };
    expect(effectiveNewChatDefault(snapshot, defaultSettings, projectId)).toMatchObject({ source: "project-backend", modelId: "haiku" });
    expect(effectiveNewChatDefault(snapshot, defaultSettings)).toMatchObject({ source: "global-backend", modelId: "opus" });
  });

  it("ignores a custom backend default whose profile is missing", () => {
    const selection = modelSelectionSchema.parse({
      harnessId: "codex-app-server",
      backendProfileId: "custom:gone",
      backendProfileDisplayName: "Gone",
      backendConfigurationRevision: 1,
      modelId: "model",
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    });
    expect(effectiveNewChatDefault({
      providers: [],
      backendProfiles: [],
      backendDefaults: [{ scope: "global", projectId: null, selection, updatedAt: "2026-08-01T00:00:00.000Z" }],
    }, defaultSettings)).toMatchObject({ source: "settings", providerId: "codex", modelId: "provider-default", reasoning: null });
  });
});
