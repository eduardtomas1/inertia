import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  clearPendingMultiSpawnLaunchId,
  MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
  MULTI_SPAWN_PRESET_STORAGE_KEY,
  projectsShareLocalCheckout,
  readPendingMultiSpawnLaunchId,
  readMultiSpawnPreset,
  refreshMultiSpawnSelection,
  selectionFromPreset,
  validateMultiSpawnDraft,
  writePendingMultiSpawnLaunchId,
  writeMultiSpawnPreset,
  type MultiSpawnDraft,
} from "../../src/renderer/src/utils/multiSpawn";
import {
  nativeModelSelection,
} from "../../src/shared/model-routing";
import type { ComposerModelRoute } from "../../src/renderer/src/utils/modelChooserRoutes";
import type { Project } from "../../src/shared/contracts";

const codexSelection = nativeModelSelection({
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
  it("persists only a bounded launch identity for restart reconciliation", () => {
    const target = storage();
    const launchId = "33333333-3333-4333-8333-333333333333";

    expect(writePendingMultiSpawnLaunchId(target, launchId)).toBe(true);
    expect(readPendingMultiSpawnLaunchId(target)).toBe(launchId);

    target.setItem(MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY, "not-a-launch-id");
    expect(readPendingMultiSpawnLaunchId(target)).toBeNull();

    expect(clearPendingMultiSpawnLaunchId(target)).toBe(true);
    expect(target.getItem(MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY)).toBeNull();
  });

  it("keeps the route model palette outside card and dialog clipping", () => {
    const styles = readFileSync(
      new URL("../../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    );
    const dialogRules = styles.match(
      /\.multi-spawn-dialog \{(?<rules>[^}]+)\}/u,
    )?.groups?.rules;
    const routeCardRules = styles.match(
      /\.multi-spawn-side \{(?<rules>[^}]+)\}/u,
    )?.groups?.rules;

    expect(dialogRules).toContain("overflow: visible");
    expect(routeCardRules).toContain("overflow: visible");
  });

  it("persists only bounded route identity, reasoning, access, and names", () => {
    const target = storage();
    writeMultiSpawnPreset(target, draft);

    const raw = target.getItem(MULTI_SPAWN_PRESET_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("projectId");
    expect(raw).not.toContain("prompt");
    expect(raw).not.toContain("providerOptions");
    expect(readMultiSpawnPreset(target)).toEqual({
      version: 1,
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
      .toBe("Write one prompt for both chats.");
    expect(validateMultiSpawnDraft({
      ...draft,
      sides: [{ ...draft.sides[0], title: "" }, draft.sides[1]],
    })).toBe("Name chat 1.");
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
