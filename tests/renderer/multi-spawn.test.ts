import { describe, expect, it } from "vitest";

import {
  clearPendingMultiSpawnLaunchId,
  initialMultiSpawnDraft,
  judgeDefaultSelection,
  multiSpawnConversationPayload,
  multiSpawnDraftIssue,
  MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
  MULTI_SPAWN_PRESET_STORAGE_KEY,
  projectsShareLocalCheckout,
  readMultiSpawnPreset,
  refreshMultiSpawnSelection,
  secondSideDefaultSelection,
  selectionFromPreset,
  validateMultiSpawnDraft,
  writePendingMultiSpawnLaunchId,
  writeMultiSpawnPreset,
  type MultiSpawnDraft,
} from "../../src/renderer/src/utils/multiSpawn";
import { defaultSelectionForProject } from "../../src/renderer/src/utils/defaultConversationSelection";
import {
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import type { ComposerModelRoute } from "../../src/renderer/src/utils/modelChooserRoutes";
import {
  defaultSettings,
  type AppSnapshot,
  type Project,
} from "../../src/shared/contracts";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";

const codexSelection = providerNativeModelSelection({
  providerId: "codex",
  modelId: "gpt-5.6-sol",
  alias: "GPT-5.6-Sol",
  reasoningEffort: "high",
});

const draft: MultiSpawnDraft = {
  prompt: "Review this implementation.",
  rememberPreset: true,
  sides: [
    {
      projectId: "11111111-1111-4111-8111-111111111111",
      title: "Correctness",
      selection: codexSelection,
      accessMode: "supervised",
      interactionMode: "build",
    },
    {
      projectId: "22222222-2222-4222-8222-222222222222",
      title: "Maintainability",
      selection: codexSelection,
      accessMode: "full",
      interactionMode: "build",
    },
  ],
  comparison: {
    enabled: false,
    side: {
      projectId: "11111111-1111-4111-8111-111111111111",
      title: "Duo verdict",
      selection: codexSelection,
      accessMode: "supervised",
      interactionMode: "plan",
    },
  },
};

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe("multi-spawn preset", () => {
  it("uses project defaults before global defaults and preserves provider default", () => {
    const globalSelection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "global-model",
    });
    const projectSelection = providerNativeModelSelection({
      providerId: "claude",
      modelId: "project-model",
    });
    const projectId = "11111111-1111-4111-8111-111111111111";
    const snapshot = {
      projects: [],
      conversations: [],
      providers: [],
      backendProfiles: [],
      backendDefaults: [
        { scope: "global", projectId: null, selection: globalSelection, updatedAt: "2026-08-01T00:00:00.000Z" },
        { scope: "project", projectId, selection: projectSelection, updatedAt: "2026-08-01T00:00:00.000Z" },
      ],
      runs: [],
      settings: defaultSettings,
      activeProjectId: projectId,
      activeConversationId: null,
    } satisfies AppSnapshot;

    expect(defaultSelectionForProject(snapshot, defaultSettings, projectId))
      .toEqual(projectSelection);

    const providerDefaultSnapshot: AppSnapshot = {
      ...snapshot,
      backendDefaults: [],
      settings: { ...defaultSettings, defaultModel: "" },
    };
    const duo = initialMultiSpawnDraft({
      snapshot: providerDefaultSnapshot,
      settings: providerDefaultSnapshot.settings,
      activeProjectId: projectId,
      routesForSelection: () => [],
      preset: null,
    });
    expect(duo.sides.map(({ selection }) => selection.modelId))
      .toEqual(["provider-default", "provider-default"]);
  });

  it("starts both perspectives with the project's default access unless a preset saved one", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const settings = { ...defaultSettings, defaultAccessMode: "auto-edit" as const };
    const project = {
      id: projectId,
      preferences: { ...defaultProjectPreferences(), defaultAccessMode: "full" as const },
    } as Project;
    const snapshot = {
      projects: [project],
      conversations: [],
      providers: [],
      backendProfiles: [],
      backendDefaults: [],
      runs: [],
      settings,
      activeProjectId: projectId,
      activeConversationId: null,
    } satisfies AppSnapshot;
    const initial = (input: Partial<Parameters<typeof initialMultiSpawnDraft>[0]>) => initialMultiSpawnDraft({
      snapshot,
      settings,
      activeProjectId: projectId,
      routesForSelection: () => [],
      preset: null,
      ...input,
    });
    expect(initial({}).sides.map(({ accessMode }) => accessMode)).toEqual(["full", "full"]);
    expect(initial({ snapshot: { ...snapshot, projects: [] } }).sides.map(({ accessMode }) => accessMode))
      .toEqual(["auto-edit", "auto-edit"]);
  });

  it("persists only a bounded launch identity for restart reconciliation", () => {
    const target = storage();
    const launchId = "33333333-3333-4333-8333-333333333333";

    expect(writePendingMultiSpawnLaunchId(target, launchId)).toBe(true);
    expect(target.getItem(MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY)).toBe(launchId);

    expect(clearPendingMultiSpawnLaunchId(target)).toBe(true);
    expect(target.getItem(MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY)).toBeNull();
  });

  it("persists only bounded route identity, reasoning, access, and names", () => {
    const target = storage();
    writeMultiSpawnPreset(target, draft);

    const raw = target.getItem(MULTI_SPAWN_PRESET_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("projectId");
    expect(raw).not.toContain("prompt");
    expect(raw).not.toContain("providerOptions");
    expect(readMultiSpawnPreset(target)).toEqual({
      version: 2,
      comparison: null,
      sides: [
        {
          title: "Correctness",
          route: {
            harnessId: codexSelection.harnessId,
            backendProfileId: codexSelection.backendProfileId,
            modelId: "gpt-5.6-sol",
            reasoningEffort: "high",
          },
          accessMode: "supervised",
        },
        {
          title: "Maintainability",
          route: {
            harnessId: codexSelection.harnessId,
            backendProfileId: codexSelection.backendProfileId,
            modelId: "gpt-5.6-sol",
            reasoningEffort: "high",
          },
          accessMode: "full",
        },
      ],
    });
  });

  it("persists an opted-in judge route without prompt or project scope", () => {
    const target = storage();
    writeMultiSpawnPreset(target, {
      ...draft,
      comparison: {
        ...draft.comparison,
        enabled: true,
      },
    });

    const raw = target.getItem(MULTI_SPAWN_PRESET_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("projectId");
    expect(raw).not.toContain("Review this implementation");
    expect(readMultiSpawnPreset(target)?.comparison).toEqual({
      title: "Duo verdict",
      route: {
        harnessId: codexSelection.harnessId,
        backendProfileId: codexSelection.backendProfileId,
        modelId: codexSelection.modelId,
        reasoningEffort: codexSelection.reasoningEffort,
      },
      accessMode: "supervised",
    });
  });

  it("migrates the safe v1 pairing with comparison disabled", () => {
    const target = storage();
    target.setItem(MULTI_SPAWN_PRESET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sides: [0, 1].map((index) => ({
        title: `Perspective ${index + 1}`,
        route: {
          harnessId: codexSelection.harnessId,
          backendProfileId: codexSelection.backendProfileId,
          modelId: codexSelection.modelId,
          reasoningEffort: null,
        },
        accessMode: "supervised",
      })),
    }));

    expect(readMultiSpawnPreset(target)).toMatchObject({
      version: 2,
      comparison: null,
    });
  });

  it("rejects malformed or unbounded local values", () => {
    const target = storage();
    target.setItem(MULTI_SPAWN_PRESET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sides: [
        {
          title: "x".repeat(121),
          route: {
            harnessId: "codex-app-server",
            backendProfileId: "native:codex",
            modelId: "gpt",
            reasoningEffort: null,
          },
          accessMode: "full",
        },
        {},
      ],
    }));
    expect(readMultiSpawnPreset(target)).toBeNull();

    target.setItem(MULTI_SPAWN_PRESET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sides: [0, 1].map((index) => ({
        title: `Perspective ${index + 1}`,
        route: {
          harnessId: "x".repeat(513),
          backendProfileId: "builtin:openai",
          modelId: "gpt",
          reasoningEffort: null,
        },
        accessMode: "supervised",
      })),
    }));
    expect(readMultiSpawnPreset(target)).toBeNull();
  });

  it("does not turn blocked local storage into an uncaught launch error", () => {
    const blockedStorage = {
      setItem: () => {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    };
    expect(writeMultiSpawnPreset(blockedStorage, draft)).toBe(false);
  });

  it("resolves saved reasoning only against the current safe route", () => {
    const route: ComposerModelRoute = {
      key: "codex-app-server:native:codex:gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      harnessId: codexSelection.harnessId,
      harnessLabel: "Codex harness",
      backendProfileId: codexSelection.backendProfileId,
      backendProfileName: "OpenAI",
      modelId: codexSelection.modelId,
      alias: codexSelection.alias,
      providerLabel: "Codex",
      source: "built-in",
      routeTerms: ["OpenAI"],
      reasoningEffort: "high",
      reasoningOptions: ["low", "high"],
      selectable: true,
      unavailableReason: null,
      selection: codexSelection,
      continuationIdentity: {
        harnessId: codexSelection.harnessId,
        backendProfileId: codexSelection.backendProfileId,
        backendConfigurationRevision:
          codexSelection.backendConfigurationRevision,
        modelIdentity: codexSelection.modelId,
        endpointIdentity: null,
      },
      compatibility: {
        state: "verified",
        allowsModelSwitchWithinSession: true,
      },
      rowCompatibility: null,
      providerId: "codex",
      providerReady: true,
    };
    expect(selectionFromPreset([route], {
      harnessId: route.harnessId,
      backendProfileId: route.backendProfileId,
      modelId: route.modelId,
      reasoningEffort: "low",
    }, codexSelection).reasoningEffort).toBe("low");
    expect(selectionFromPreset([route], {
      harnessId: route.harnessId,
      backendProfileId: route.backendProfileId,
      modelId: route.modelId,
      reasoningEffort: "ultra",
    }, codexSelection).reasoningEffort).toBe("high");
  });

  it("rebinds a draft to the current backend configuration revision", () => {
    const currentSelection = {
      ...codexSelection,
      backendProfileId: "custom:team",
      backendProfileDisplayName: "Team gateway",
      backendConfigurationRevision: 5,
    };
    const route: ComposerModelRoute = {
      key: "codex-app-server:custom:team:gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      harnessId: currentSelection.harnessId,
      harnessLabel: "Codex harness",
      backendProfileId: currentSelection.backendProfileId,
      backendProfileName: currentSelection.backendProfileDisplayName,
      modelId: currentSelection.modelId,
      alias: currentSelection.alias,
      providerLabel: "Team gateway",
      source: "custom",
      routeTerms: [],
      reasoningEffort: "high",
      reasoningOptions: ["low", "high"],
      selectable: true,
      unavailableReason: null,
      selection: currentSelection,
      continuationIdentity: {
        harnessId: currentSelection.harnessId,
        backendProfileId: currentSelection.backendProfileId,
        backendConfigurationRevision: 5,
        modelIdentity: currentSelection.modelId,
        endpointIdentity: "opaque-team-route-5",
      },
      compatibility: {
        state: "verified",
        allowsModelSwitchWithinSession: false,
      },
      rowCompatibility: null,
      providerId: "codex",
      providerReady: true,
    };
    const stale = {
      ...currentSelection,
      reasoningEffort: "low",
      backendConfigurationRevision: 4,
    };

    expect(refreshMultiSpawnSelection([route], stale)).toMatchObject({
      reasoningEffort: "low",
      backendConfigurationRevision: 5,
    });
  });

  it("validates the shared prompt and both chat names", () => {
    expect(validateMultiSpawnDraft(draft)).toBeNull();
    expect(validateMultiSpawnDraft({ ...draft, prompt: " " }))
      .toBe("Write the brief first.");
    expect(validateMultiSpawnDraft({
      ...draft,
      sides: [{ ...draft.sides[0], title: "" }, draft.sides[1]],
    })).toBe("Name chat A.");
  });

  it("recognizes distinct project records in one local checkout", () => {
    const project = (
      id: string,
      normalizedPath: string,
      repositoryRoot: string | null,
    ): Project => ({
      id,
      name: id,
      path: normalizedPath,
      normalizedPath,
      repositoryIdentity: repositoryRoot ? `git:${repositoryRoot}` : null,
      repositoryRoot,
      repositoryRelativePath: ".",
      groupingMode: null,
      gitRepositoryLimit: 64,
      color: "#6366f1",
      status: "ready",
      createdAt: "2026-07-29T14:00:00.000Z",
      updatedAt: "2026-07-29T14:00:00.000Z",
    });
    const projects = [
      project("root", "/workspace/repo", "/workspace/repo"),
      project("module", "/workspace/repo/modules/a", "/workspace/repo"),
      project("other", "/workspace/other", "/workspace/other"),
    ];

    expect(projectsShareLocalCheckout(projects, "root", "module")).toBe(true);
    expect(projectsShareLocalCheckout(projects, "module", "other")).toBe(false);
    expect(projectsShareLocalCheckout(projects, "missing", "other")).toBe(false);
  });
});

function readyRoute(
  providerId: "codex" | "claude" | "cursor",
  modelId: string,
  ready = true,
): ComposerModelRoute {
  const selection = providerNativeModelSelection({ providerId, modelId, alias: modelId });
  return {
    key: `${selection.harnessId}:${selection.backendProfileId}:${modelId}`,
    displayName: modelId,
    harnessId: selection.harnessId,
    harnessLabel: providerId,
    backendProfileId: selection.backendProfileId,
    backendProfileName: providerId,
    modelId,
    alias: modelId,
    providerLabel: providerId,
    source: "built-in",
    routeTerms: [],
    reasoningEffort: null,
    reasoningOptions: [],
    selectable: ready,
    unavailableReason: ready ? null : "Unavailable.",
    selection,
    continuationIdentity: {
      harnessId: selection.harnessId,
      backendProfileId: selection.backendProfileId,
      backendConfigurationRevision: selection.backendConfigurationRevision,
      modelIdentity: modelId,
      endpointIdentity: null,
    },
    compatibility: { state: "verified", allowsModelSwitchWithinSession: true },
    rowCompatibility: null,
    providerId,
    providerReady: ready,
  };
}

describe("Duo smart defaults", () => {
  const codexSol = readyRoute("codex", "gpt-5.6-sol");
  const codexAlt = readyRoute("codex", "gpt-5.5");
  const codexDefault = readyRoute("codex", "provider-default");
  const claudeOpus = readyRoute("claude", "opus");
  const cursorAuto = readyRoute("cursor", "auto");
  const offlineClaude = readyRoute("claude", "sonnet", false);
  const providerOf = (selection: { harnessId: string }) => selection.harnessId;

  it("gives chat B the first ready route from another provider", () => {
    expect(secondSideDefaultSelection(
      [codexSol, offlineClaude, codexAlt, claudeOpus, cursorAuto],
      codexSol.selection,
    ).modelId).toBe("opus");
  });

  it("falls back to another model of A's provider, never its provider default", () => {
    expect(secondSideDefaultSelection(
      [codexDefault, codexSol, offlineClaude, codexAlt],
      codexSol.selection,
    ).modelId).toBe("gpt-5.5");
    expect(secondSideDefaultSelection(
      [codexDefault, codexSol, codexAlt],
      codexDefault.selection,
    ).modelId).toBe("provider-default");
  });

  it("reuses A's route when nothing else is ready", () => {
    const selection = secondSideDefaultSelection([codexSol, offlineClaude], codexSol.selection);
    expect(selection).toEqual(codexSol.selection);
    expect(selection).not.toBe(codexSol.selection);
  });

  it("gives the judge a third provider, then any third route, then A's", () => {
    expect(judgeDefaultSelection(
      [codexSol, claudeOpus, codexAlt, cursorAuto],
      codexSol.selection,
      claudeOpus.selection,
    ).modelId).toBe("auto");
    expect(judgeDefaultSelection(
      [codexSol, claudeOpus, codexAlt],
      codexSol.selection,
      claudeOpus.selection,
    ).modelId).toBe("gpt-5.5");
    expect(judgeDefaultSelection(
      [codexSol, codexDefault, offlineClaude],
      codexSol.selection,
      codexSol.selection,
    )).toEqual(codexSol.selection);
  });

  it("builds a mixed duo with a third-model judge and keeps saved pairings first", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const settings = { ...defaultSettings, defaultProvider: "codex" as const, defaultModel: "gpt-5.6-sol" };
    const snapshot = {
      projects: [],
      conversations: [],
      providers: [],
      backendProfiles: [],
      backendDefaults: [],
      runs: [],
      settings,
      activeProjectId: projectId,
      activeConversationId: null,
    } satisfies AppSnapshot;
    const routes = [codexSol, codexAlt, claudeOpus, cursorAuto];
    const initial = (preset: Parameters<typeof initialMultiSpawnDraft>[0]["preset"]) =>
      initialMultiSpawnDraft({ snapshot, settings, activeProjectId: projectId, routesForSelection: () => routes, preset });

    const fresh = initial(null);
    expect([...fresh.sides.map(({ selection }) => selection.modelId), fresh.comparison.side.selection.modelId])
      .toEqual(["gpt-5.6-sol", "opus", "auto"]);
    expect(fresh.sides.map(({ title }) => title)).toEqual(["Duo A", "Duo B"]);
    expect(fresh.comparison.side.title).toBe("Duo verdict");
    expect(new Set([...fresh.sides, fresh.comparison.side].map(({ selection }) => providerOf(selection))).size).toBe(3);

    const reference = (route: ComposerModelRoute) => ({
      harnessId: route.harnessId,
      backendProfileId: route.backendProfileId,
      modelId: route.modelId,
      reasoningEffort: null,
    });
    const saved = initial({
      version: 2,
      sides: [
        { title: "Left", route: reference(codexSol), accessMode: "supervised" },
        { title: "Right", route: reference(codexAlt), accessMode: "supervised" },
      ],
      comparison: { title: "Referee", route: reference(codexSol), accessMode: "supervised" },
    });
    expect([...saved.sides.map(({ selection }) => selection.modelId), saved.comparison.side.selection.modelId])
      .toEqual(["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-sol"]);
  });
});

describe("Duo draft issues", () => {
  it("names the field to focus and the reason to show", () => {
    expect(multiSpawnDraftIssue(draft)).toBeNull();
    expect(multiSpawnDraftIssue({ ...draft, prompt: " " }))
      .toEqual({ field: "prompt", message: "Write the brief first." });
    expect(multiSpawnDraftIssue({
      ...draft,
      sides: [draft.sides[0], { ...draft.sides[1], title: " " }],
    })).toEqual({ field: "title-1", message: "Name chat B." });
    expect(multiSpawnDraftIssue({
      ...draft,
      sides: [{ ...draft.sides[0], projectId: "" }, draft.sides[1]],
    })).toEqual({ field: "project-0", message: "Choose a project for chat A." });
    expect(multiSpawnDraftIssue({
      ...draft,
      comparison: { enabled: true, side: { ...draft.comparison.side, title: "" } },
    })).toEqual({ field: "title-2", message: "Name the judge." });
    expect(multiSpawnDraftIssue({
      ...draft,
      comparison: { enabled: false, side: { ...draft.comparison.side, title: "" } },
    })).toBeNull();
  });
});

describe("multi-spawn access for providers that cannot ask for approval", () => {
  it("launches an Antigravity side left at Supervised as Auto-accept edits and keeps Supervised elsewhere", () => {
    const side = (providerId: "antigravity" | "claude") => ({
      projectId: "project-1",
      title: `${providerId} side`,
      selection: providerNativeModelSelection({ providerId }),
      accessMode: "supervised" as const,
      interactionMode: "build" as const,
    });
    expect(multiSpawnConversationPayload(side("antigravity"), defaultSettings)).toMatchObject({ providerId: "antigravity", accessMode: "auto-edit" });
    expect(multiSpawnConversationPayload(side("claude"), defaultSettings)).toMatchObject({ providerId: "claude", accessMode: "supervised" });
  });
});
