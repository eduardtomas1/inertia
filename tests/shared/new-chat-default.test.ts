import { describe, expect, it } from "vitest";

import {
  defaultSettings,
  type Initiative,
  type ModelBackendDefault,
  type ModelBackendProfileView,
  type ModelSelection,
  type ProviderInfo,
} from "../../src/shared/contracts";
import { defaultInitiativePreferences } from "../../src/shared/initiatives";
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

  describe("initiative layer", () => {
    const initiativeId = "22222222-2222-4222-8222-222222222222";
    const initiativeWith = (defaultModel: ModelSelection, defaultReasoningEffort: string | null = null): Initiative => ({
      id: initiativeId,
      name: "Checkout",
      color: "teal",
      status: "active",
      preferences: { ...defaultInitiativePreferences(), defaultModel, defaultReasoningEffort },
      brief: "",
      briefRevision: 0,
      briefUpdatedAt: null,
      notesRevision: 0,
      proposedNoteCount: 0,
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const claude = (models: string[], freshness: "fresh" | "unavailable" = "fresh") => ({
      id: "claude",
      available: true,
      installState: "installed",
      authState: "authenticated",
      canRun: true,
      models: models.map((id) => ({ id })),
      metadataState: { models: { freshness } },
    }) as unknown as ProviderInfo;
    const native = (modelId: string) => providerNativeModelSelection({ providerId: "claude", modelId, alias: modelId, reasoningEffort: null });

    it("comes before the project and global defaults, with its reasoning level", () => {
      const snapshot = {
        providers: [claude(["opus", "haiku"])],
        backendProfiles: [],
        backendDefaults: [nativeDefault("global", "sonnet", null), nativeDefault("project", "haiku", null)],
        initiatives: [initiativeWith(native("opus"), "high")],
      };
      expect(effectiveNewChatDefault(snapshot, defaultSettings, projectId, initiativeId))
        .toMatchObject({ source: "initiative", providerId: "claude", modelId: "opus", reasoning: "high" });
      // Without the initiative the project layer still applies.
      expect(effectiveNewChatDefault(snapshot, defaultSettings, projectId))
        .toMatchObject({ source: "project-backend", modelId: "haiku" });
      expect(effectiveNewChatDefault(snapshot, defaultSettings, projectId, "33333333-3333-4333-8333-333333333333"))
        .toMatchObject({ source: "project-backend", modelId: "haiku" });
    });

    it("falls through when the live catalog no longer offers the model", () => {
      const snapshot = {
        providers: [claude(["haiku"])],
        backendProfiles: [],
        backendDefaults: [nativeDefault("project", "haiku", null)],
        initiatives: [initiativeWith(native("opus"), "high")],
      };
      expect(effectiveNewChatDefault(snapshot, defaultSettings, projectId, initiativeId))
        .toMatchObject({ source: "project-backend", modelId: "haiku" });
      // An unrefreshed catalog cannot prove removal, so the initiative still applies.
      expect(effectiveNewChatDefault({ ...snapshot, providers: [claude([], "unavailable")] }, defaultSettings, projectId, initiativeId))
        .toMatchObject({ source: "initiative", modelId: "opus" });
    });

    it("falls through when the initiative's provider cannot run, and waits while it is being checked", () => {
      const state = (installState: string, authState: string, canRun: boolean) => ({
        ...claude(["opus"]), available: canRun, installState, authState, canRun,
      }) as unknown as ProviderInfo;
      const snapshot = (provider: ProviderInfo) => ({
        providers: [provider],
        backendProfiles: [],
        backendDefaults: [nativeDefault("project", "haiku", null)],
        initiatives: [initiativeWith(native("opus"), "high")],
      });
      // The project default is Claude too, so it falls through to Settings.
      expect(effectiveNewChatDefault(snapshot(state("not-installed", "unknown", false)), {
        defaultProvider: "codex", defaultModel: "gpt-5", defaultReasoningEffort: "high",
      }, projectId, initiativeId)).toMatchObject({ source: "settings", providerId: "codex", modelId: "gpt-5" });
      expect(effectiveNewChatDefault(snapshot(state("checking", "checking", false)), defaultSettings, projectId, initiativeId))
        .toMatchObject({ source: "initiative", modelId: "opus", reasoning: "high" });
    });

    it("ignores an unknown initiative id, and a snapshot without initiatives", () => {
      const unknown = "33333333-3333-4333-8333-333333333333";
      const settings = { defaultProvider: "claude" as const, defaultModel: "sonnet", defaultReasoningEffort: "low" };
      const withInitiative = {
        providers: [claude(["opus", "sonnet", "haiku"])],
        backendProfiles: [],
        backendDefaults: [],
        initiatives: [initiativeWith(native("opus"), "high")],
      };
      expect(effectiveNewChatDefault(withInitiative, settings, null, unknown))
        .toMatchObject({ source: "settings", modelId: "sonnet", reasoning: "low" });
      expect(effectiveNewChatDefault({ ...withInitiative, initiatives: undefined }, settings, null, initiativeId))
        .toMatchObject({ source: "settings", modelId: "sonnet" });
      expect(effectiveNewChatDefault({ ...withInitiative, backendDefaults: [nativeDefault("global", "haiku", null)] }, settings, null, unknown))
        .toMatchObject({ source: "global-backend", modelId: "haiku" });
    });

    it("falls through when its backend profile is disabled or reconfigured", () => {
      const selection = modelSelectionSchema.parse({
        harnessId: "codex-app-server",
        backendProfileId: "custom:gateway",
        backendProfileDisplayName: "Gateway",
        backendConfigurationRevision: 3,
        modelId: "gateway-model",
        alias: null,
        reasoningEffort: null,
        contextWindowOverride: null,
        providerOptions: {},
        capabilities: [],
      });
      const profile = (enabled: boolean, configurationRevision = 3) => ({
        id: "custom:gateway",
        enabled,
        harnessId: "codex-app-server",
        configurationRevision,
        models: [{ id: "gateway-model" }],
      }) as unknown as ModelBackendProfileView;
      const snapshot = (backendProfiles: ModelBackendProfileView[]) => ({
        providers: [],
        backendProfiles,
        backendDefaults: [nativeDefault("global", "sonnet", null)],
        initiatives: [initiativeWith(selection)],
      });
      expect(effectiveNewChatDefault(snapshot([profile(true)]), defaultSettings, null, initiativeId))
        .toMatchObject({ source: "initiative", modelId: "gateway-model" });
      expect(effectiveNewChatDefault(snapshot([profile(false)]), defaultSettings, null, initiativeId))
        .toMatchObject({ source: "global-backend", modelId: "sonnet" });
      expect(effectiveNewChatDefault(snapshot([profile(true, 4)]), defaultSettings, null, initiativeId))
        .toMatchObject({ source: "global-backend", modelId: "sonnet" });
    });
  });
});
