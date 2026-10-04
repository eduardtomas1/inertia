import { describe, expect, it } from "vitest";

import { defaultSettings, type ModelBackendDefault, type ProviderInfo } from "../../src/shared/contracts";
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

  it("falls back to the first runnable provider with its default model when the stored one cannot run", () => {
    const provider = (id: "codex" | "claude", canRun: boolean) => ({
      id, available: true, installState: canRun ? "installed" : "missing", authState: "authenticated", canRun,
      models: [], metadataState: { models: { freshness: "unavailable" } },
    }) as unknown as ProviderInfo;
    expect(effectiveNewChatDefault({ providers: [provider("codex", false), provider("claude", true)], backendProfiles: [], backendDefaults: [] }, {
      defaultProvider: "codex",
      defaultModel: "gpt-5",
      defaultReasoningEffort: "high",
    })).toMatchObject({ source: "fallback", providerId: "claude", modelId: "provider-default", reasoning: null });
  });

  describe("native backend defaults for a provider that cannot run", () => {
    const provider = (id: "codex" | "claude", state: "ready" | "missing" | "checking") => ({
      id,
      available: state === "ready",
      installState: { ready: "installed", missing: "not-installed", checking: "checking" }[state],
      authState: { ready: "authenticated", missing: "unknown", checking: "checking" }[state],
      canRun: state === "ready",
      models: [],
      metadataState: { models: { freshness: "unavailable" } },
    }) as unknown as ProviderInfo;
    const codexDefault = (scope: "global" | "project"): ModelBackendDefault => ({
      scope,
      projectId: scope === "global" ? null : projectId,
      selection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5", alias: "gpt-5", reasoningEffort: "high" }),
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    it("skips the global default and uses the settings", () => {
      expect(effectiveNewChatDefault({
        providers: [provider("codex", "missing"), provider("claude", "ready")],
        backendProfiles: [],
        backendDefaults: [codexDefault("global")],
      }, { defaultProvider: "claude", defaultModel: "sonnet", defaultReasoningEffort: "low" }))
        .toMatchObject({ source: "settings", providerId: "claude", modelId: "sonnet", reasoning: "low" });
    });

    it("skips the global default and falls back when the settings provider cannot run either", () => {
      expect(effectiveNewChatDefault({
        providers: [provider("codex", "missing"), provider("claude", "ready")],
        backendProfiles: [],
        backendDefaults: [codexDefault("global")],
      }, { defaultProvider: "codex", defaultModel: "gpt-5", defaultReasoningEffort: "high" }))
        .toMatchObject({ source: "fallback", providerId: "claude", modelId: "provider-default", reasoning: null });
    });

    it("skips the project default and keeps the global default ahead of the settings", () => {
      expect(effectiveNewChatDefault({
        providers: [provider("codex", "missing"), provider("claude", "ready")],
        backendProfiles: [],
        backendDefaults: [codexDefault("project"), nativeDefault("global", "opus", "medium")],
      }, { defaultProvider: "claude", defaultModel: "sonnet", defaultReasoningEffort: "low" }, projectId))
        .toMatchObject({ source: "global-backend", providerId: "claude", modelId: "opus", reasoning: "medium" });
    });

    it("keeps the default while its provider is still being checked", () => {
      expect(effectiveNewChatDefault({
        providers: [provider("codex", "checking"), provider("claude", "ready")],
        backendProfiles: [],
        backendDefaults: [codexDefault("project"), nativeDefault("global", "opus", "medium")],
      }, defaultSettings, projectId)).toMatchObject({ source: "project-backend", providerId: "codex", modelId: "gpt-5", reasoning: "high" });
    });
  });
});
