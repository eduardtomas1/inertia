import { describe, expect, it } from "vitest";

import {
  INERTIA_RESERVED_PRIMARY_SHORTCUT_KEYS,
  MAX_MODEL_SHORTCUTS,
  matchesModelShortcut,
  resolveModelShortcutBindings,
  type ModelShortcutKeyboardEvent,
} from "../../src/renderer/src/utils/modelShortcuts";
import {
  modelFavoriteKey,
  resolveModelFavorites,
  type ModelFavoriteReference,
} from "../../src/renderer/src/utils/modelFavorites";
import type { ModelSearchRoute } from "../../src/renderer/src/utils/modelSearch";

function reference(
  modelId: string,
  update: Partial<ModelFavoriteReference> = {},
): ModelFavoriteReference {
  return {
    harnessId: "codex-app-server",
    backendProfileId: "builtin:openai",
    modelId,
    reasoningEffort: null,
    ...update,
  };
}

function route(
  modelId: string,
  update: Partial<ModelSearchRoute> = {},
): ModelSearchRoute {
  const identity = reference(modelId, update);
  return {
    key: modelFavoriteKey(identity),
    ...identity,
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

function event(
  update: Partial<ModelShortcutKeyboardEvent> = {},
): ModelShortcutKeyboardEvent {
  return {
    altKey: false,
    code: "Digit1",
    ctrlKey: true,
    isComposing: false,
    key: "1",
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...update,
  };
}

describe("model shortcut resolution", () => {
  it("assigns distinct shortcuts to high and xhigh favorites on one model", () => {
    const high = reference("gpt-5.6-sol", { reasoningEffort: "high" });
    const xhigh = reference("gpt-5.6-sol", { reasoningEffort: "xhigh" });
    const available = route("gpt-5.6-sol", {
      reasoningEffort: "high",
      reasoningOptions: ["high", "xhigh"],
    });
    const favorites = resolveModelFavorites([high, xhigh], [available]);
    const visible = favorites.flatMap(({ route: match }) =>
      match ? [match] : []);

    expect(resolveModelShortcutBindings(favorites, visible, {
      platform: "linux",
    }).map(({ favoriteKey, key, route: match }) => [
      favoriteKey,
      key,
      match.reasoningEffort,
    ])).toEqual([
      [modelFavoriteKey(high), "1", "high"],
      [modelFavoriteKey(xhigh), "2", "xhigh"],
    ]);
  });

  it("matches a favorite to the ordinary stable base route shown by a source", () => {
    const high = reference("gpt-5.6-sol", { reasoningEffort: "high" });
    const discovered = route("gpt-5.6-sol", {
      key: "stable-base-route",
      reasoningEffort: "high",
      reasoningOptions: ["high", "xhigh"],
    });
    const favorites = resolveModelFavorites([high], [discovered]);

    expect(resolveModelShortcutBindings(favorites, [discovered], {
      platform: "darwin",
    }).map(({ favoriteKey, routeKey, label }) => [
      favoriteKey,
      routeKey,
      label,
    ])).toEqual([[
      modelFavoriteKey(high),
      "stable-base-route",
      "⌘1",
    ]]);
  });

  it("assigns only the first bounded set of visible selectable favorites", () => {
    const routes = Array.from(
      { length: MAX_MODEL_SHORTCUTS + 3 },
      (_, index) => route(`model-${index + 1}`),
    );
    routes[1]!.selectable = false;
    routes[1]!.unavailableReason = "Add an API key.";
    const hidden = routes[3]!;
    const visible = routes.filter((candidate) => candidate !== hidden);
    const favorites = resolveModelFavorites(
      routes.map(({ harnessId, backendProfileId, modelId }) => ({
        harnessId,
        backendProfileId,
        modelId,
        reasoningEffort: null,
      })),
      routes,
    );

    const bindings = resolveModelShortcutBindings(favorites, visible, {
      platform: "linux",
    });

    expect(bindings).toHaveLength(MAX_MODEL_SHORTCUTS);
    expect(bindings.map(({ route }) => route.modelId)).toEqual([
      "model-1",
      "model-3",
      "model-5",
      "model-6",
      "model-7",
      "model-8",
      "model-9",
      "model-10",
      "model-11",
    ]);
    expect(bindings.map(({ key }) => key)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9",
    ]);
  });

  it("keeps favorite order stable when provider and search result order changes", () => {
    const alpha = route("alpha");
    const beta = route("beta");
    const gamma = route("gamma");
    const discoveredOnly = route("not-favorited");
    const favorites = resolveModelFavorites(
      [reference("beta"), reference("alpha"), reference("gamma")],
      [alpha, beta, gamma],
    );

    const reordered = resolveModelShortcutBindings(
      favorites,
      [discoveredOnly, gamma, alpha, beta],
      { platform: "win32" },
    );
    const filtered = resolveModelShortcutBindings(
      favorites,
      [gamma, alpha],
      { platform: "win32" },
    );

    expect(reordered.map(({ routeKey, key }) => [routeKey, key])).toEqual([
      [beta.key, "1"],
      [alpha.key, "2"],
      [gamma.key, "3"],
    ]);
    expect(filtered.map(({ routeKey, key }) => [routeKey, key])).toEqual([
      [alpha.key, "1"],
      [gamma.key, "2"],
    ]);
  });

  it("ignores removed and duplicate favorite routes without consuming slots", () => {
    const alpha = route("alpha");
    const favorites = resolveModelFavorites(
      [reference("removed"), reference("alpha"), reference("alpha")],
      [alpha],
    );

    expect(resolveModelShortcutBindings(favorites, [alpha], {
      platform: "linux",
    }).map(({ favoriteKey, key }) => [favoriteKey, key])).toEqual([
      [modelFavoriteKey(reference("alpha")), "1"],
    ]);
  });

  it("skips caller reservations and exposes collision-safe descriptors", () => {
    const routes = [route("alpha"), route("beta"), route("gamma")];
    const favorites = resolveModelFavorites(
      [reference("alpha"), reference("beta"), reference("gamma")],
      routes,
    );
    const bindings = resolveModelShortcutBindings(favorites, routes, {
      platform: "linux",
      reservedPrimaryKeys: ["1", "3", " K "],
    });

    expect(INERTIA_RESERVED_PRIMARY_SHORTCUT_KEYS).toEqual(["b", "j", "k", "n"]);
    expect(bindings.map(({ key, code, ariaKeyShortcuts }) => ({
      key,
      code,
      ariaKeyShortcuts,
    }))).toEqual([
      { key: "2", code: "Digit2", ariaKeyShortcuts: "Control+2" },
      { key: "4", code: "Digit4", ariaKeyShortcuts: "Control+4" },
      { key: "5", code: "Digit5", ariaKeyShortcuts: "Control+5" },
    ]);
  });

  it("uses macOS-aware labels without changing non-macOS behavior", () => {
    const model = route("alpha");
    const favorites = resolveModelFavorites([reference("alpha")], [model]);

    expect(resolveModelShortcutBindings(favorites, [model], {
      platform: "darwin",
    })[0]).toMatchObject({
      primaryModifier: "Meta",
      label: "⌘1",
      ariaKeyShortcuts: "Meta+1",
    });
    for (const platform of ["linux", "win32", "unknown"] as const) {
      expect(resolveModelShortcutBindings(favorites, [model], {
        platform,
      })[0]).toMatchObject({
        primaryModifier: "Control",
        label: "Ctrl+1",
        ariaKeyShortcuts: "Control+1",
      });
    }
  });

  it("matches only the exact active primary shortcut", () => {
    const model = route("alpha");
    const favorites = resolveModelFavorites([reference("alpha")], [model]);
    const binding = resolveModelShortcutBindings(favorites, [model], {
      platform: "linux",
    })[0];
    expect(binding).toBeDefined();
    if (!binding) return;

    expect(matchesModelShortcut(event(), binding)).toBe(true);
    expect(matchesModelShortcut(event({ altKey: true }), binding)).toBe(false);
    expect(matchesModelShortcut(event({ shiftKey: true }), binding)).toBe(false);
    expect(matchesModelShortcut(event({ metaKey: true }), binding)).toBe(false);
    expect(matchesModelShortcut(event({ ctrlKey: false }), binding)).toBe(false);
    expect(matchesModelShortcut(event({ repeat: true }), binding)).toBe(false);
    expect(matchesModelShortcut(event({ isComposing: true }), binding)).toBe(false);
    expect(matchesModelShortcut(event({ code: "Numpad1" }), binding)).toBe(false);
    expect(matchesModelShortcut(event({ code: "", key: "1" }), binding)).toBe(true);

    const macBinding = resolveModelShortcutBindings(favorites, [model], {
      platform: "darwin",
    })[0];
    expect(macBinding).toBeDefined();
    if (!macBinding) return;
    expect(matchesModelShortcut(event({
      ctrlKey: false,
      metaKey: true,
    }), macBinding)).toBe(true);
  });
});
