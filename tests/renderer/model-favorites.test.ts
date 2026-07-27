import { describe, expect, it } from "vitest";

import {
  MAX_MODEL_FAVORITES,
  MODEL_FAVORITES_STORAGE_KEY,
  modelFavoriteKey,
  modelFavoriteReference,
  readModelFavorites,
  resolveModelFavorites,
  toggleModelFavorite,
  writeModelFavorites,
  type ModelFavoriteReference,
} from "../../src/renderer/src/utils/modelFavorites";
import type { ModelSearchRoute } from "../../src/renderer/src/utils/modelSearch";

function favorite(
  modelId: string,
  update: Partial<ModelFavoriteReference> = {},
): ModelFavoriteReference {
  return {
    harnessId: "codex-app-server",
    backendProfileId: "builtin:openai",
    modelId,
    ...update,
  };
}

function route(
  modelId: string,
  update: Partial<ModelSearchRoute> = {},
): ModelSearchRoute {
  const reference = favorite(modelId, update);
  return {
    key: modelFavoriteKey(reference),
    ...reference,
    displayName: modelId,
    alias: null,
    harnessLabel: "Codex",
    backendProfileName: "OpenAI",
    providerLabel: "Codex",
    source: "built-in",
    routeTerms: [],
    selectable: true,
    unavailableReason: null,
    ...update,
  };
}

function memoryStorage(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(MODEL_FAVORITES_STORAGE_KEY, initial);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("model favorites", () => {
  it("persists only bounded stable route references", () => {
    const storage = memoryStorage();
    const selection = {
      ...favorite("gpt-5.6-sol"),
      backendProfileDisplayName: "OpenAI",
      alias: "Sol",
      reasoningEffort: "high",
      contextWindowOverride: 200_000,
      providerOptions: { organization: "must-not-be-copied" },
      capabilities: [],
      backendConfigurationRevision: 7,
    };

    expect(writeModelFavorites(storage, [modelFavoriteReference(selection)])).toBe(true);
    expect(JSON.parse(storage.values.get(MODEL_FAVORITES_STORAGE_KEY) ?? "{}"))
      .toEqual({
        version: 1,
        favorites: [{
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          modelId: "gpt-5.6-sol",
        }],
      });
  });

  it("toggles independently without selecting a route and preserves insertion order", () => {
    const first = favorite("first");
    const second = favorite("second");

    expect(toggleModelFavorite([], first)).toEqual([first]);
    expect(toggleModelFavorite([first], second)).toEqual([first, second]);
    expect(toggleModelFavorite([first, second], first)).toEqual([second]);
  });

  it("deduplicates and bounds favorites deterministically", () => {
    const favorites = Array.from(
      { length: MAX_MODEL_FAVORITES + 2 },
      (_, index) => favorite(`model-${index}`),
    );
    const normalized = toggleModelFavorite(
      [favorites[0]!, favorites[0]!, ...favorites.slice(1, -1)],
      favorites.at(-1)!,
    );

    expect(normalized).toHaveLength(MAX_MODEL_FAVORITES);
    expect(normalized[0]?.modelId).toBe("model-1");
    expect(normalized.at(-1)?.modelId).toBe(`model-${MAX_MODEL_FAVORITES + 1}`);
  });

  it("tolerates malformed, oversized, and unavailable storage", () => {
    expect(readModelFavorites(memoryStorage("{not json"))).toEqual([]);
    expect(readModelFavorites(memoryStorage("x".repeat(32_769)))).toEqual([]);
    expect(readModelFavorites({
      getItem: () => {
        throw new Error("storage disabled");
      },
    })).toEqual([]);
    expect(writeModelFavorites({
      setItem: () => {
        throw new Error("quota exceeded");
      },
    }, [favorite("safe")])).toBe(false);
  });

  it("keeps valid references while dropping invalid, duplicate, and unversioned entries", () => {
    const valid = favorite("valid");
    const storage = memoryStorage(JSON.stringify({
      version: 1,
      favorites: [
        valid,
        valid,
        { ...valid, harnessId: "not a safe identity" },
        { ...valid, modelId: "   " },
        { ...valid, providerOptions: { token: "ignored" } },
      ],
    }));

    expect(readModelFavorites(storage)).toEqual([valid]);
    expect(readModelFavorites(memoryStorage(JSON.stringify({
      favorites: [valid],
    })))).toEqual([]);
  });

  it("represents removed profiles as missing without crashing or relabeling them", () => {
    const available = favorite("gpt-5.6-sol");
    const removed = favorite("model-x", {
      harnessId: "claude-agent-sdk",
      backendProfileId: "custom:removed",
    });
    const [resolvedAvailable, resolvedRemoved] = resolveModelFavorites(
      [available, removed],
      [route("gpt-5.6-sol")],
    );

    expect(resolvedAvailable?.route?.displayName).toBe("gpt-5.6-sol");
    expect(resolvedRemoved).toEqual({
      key: modelFavoriteKey(removed),
      reference: removed,
      route: null,
    });
  });

  it("does not confuse identical models exposed through different routes", () => {
    const native = favorite("shared-model");
    const custom = favorite("shared-model", {
      harnessId: "claude-agent-sdk",
      backendProfileId: "custom:team",
    });
    const resolved = resolveModelFavorites(
      [native, custom],
      [
        route("shared-model"),
        route("shared-model", {
          harnessId: "claude-agent-sdk",
          backendProfileId: "custom:team",
          harnessLabel: "Claude",
          backendProfileName: "Team",
          providerLabel: "Claude",
          source: "custom",
        }),
      ],
    );

    expect(resolved.map(({ route: match }) => match?.backendProfileId))
      .toEqual(["builtin:openai", "custom:team"]);
  });
});
