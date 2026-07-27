import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ModelChooser,
  modelShortcutPlatform,
  nextModelChooserIndex,
  preferredModelChooserSource,
  searchableModelChooserRoutes,
} from "../../src/renderer/src/components/ModelChooser";
import type { ComposerModelRoute } from "../../src/renderer/src/utils/modelChooserRoutes";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";

function route(
  modelId: string,
  selectable = true,
  reasoningEffort: string | null = null,
): ComposerModelRoute {
  const selection = nativeModelSelection({
    providerId: "codex",
    modelId,
    alias: modelId.toUpperCase(),
    reasoningEffort,
  });
  return {
    key: JSON.stringify([
      selection.harnessId,
      selection.backendProfileId,
      selection.modelId,
    ]),
    displayName: modelId.toUpperCase(),
    modelId,
    alias: selection.alias,
    harnessId: selection.harnessId,
    harnessLabel: "Codex harness",
    backendProfileId: selection.backendProfileId,
    backendProfileName: selection.backendProfileDisplayName,
    providerLabel: "Codex",
    source: "built-in",
    routeTerms: [],
    reasoningEffort: selection.reasoningEffort,
    reasoningOptions: reasoningEffort ? [reasoningEffort] : [],
    selectable,
    unavailableReason: selectable ? null : "This route is unavailable.",
    selection,
    continuationIdentity: continuationIdentityForSelection(
      selection,
      null,
      false,
    ),
    compatibility: {
      state: "verified",
      allowsModelSwitchWithinSession: true,
    },
    rowCompatibility: null,
    providerId: "codex",
  };
}

describe("ModelChooser", () => {
  it("opens on Favorites when available and otherwise uses a real source", () => {
    expect(preferredModelChooserSource([
      { filter: { kind: "favorites" } },
      { filter: { kind: "provider", providerId: "codex" } },
    ])).toEqual({ kind: "favorites" });
    expect(preferredModelChooserSource([
      { filter: { kind: "provider", providerId: "claude" } },
    ])).toEqual({ kind: "provider", providerId: "claude" });
    expect(preferredModelChooserSource([])).toEqual({ kind: "all" });
  });

  it("renders the exact selected route as an anchored dialog trigger", () => {
    const alpha = route("alpha");
    const html = renderToStaticMarkup(createElement(ModelChooser, {
      routes: [alpha],
      selectedRoute: alpha,
      onSelect: () => undefined,
    }));

    expect(html).toContain("model-chooser-anchor");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("ALPHA");
    expect(html).toContain("codex-app-server");
    expect(html).not.toContain('role="dialog"');
  });

  it("navigates selectable results only and wraps predictably", () => {
    const routes = [
      route("alpha"),
      route("disabled", false),
      route("beta"),
    ];

    expect(nextModelChooserIndex(routes, -1, "Home")).toBe(0);
    expect(nextModelChooserIndex(routes, 0, "ArrowDown")).toBe(2);
    expect(nextModelChooserIndex(routes, 2, "ArrowDown")).toBe(0);
    expect(nextModelChooserIndex(routes, 0, "ArrowUp")).toBe(2);
    expect(nextModelChooserIndex(routes, -1, "End")).toBe(2);
    expect(nextModelChooserIndex([route("disabled", false)], 0, "Home"))
      .toBe(-1);
  });

  it("maps platform labels without guessing unsupported platforms", () => {
    expect(modelShortcutPlatform("MacIntel")).toBe("darwin");
    expect(modelShortcutPlatform("Win32")).toBe("win32");
    expect(modelShortcutPlatform("Linux x86_64")).toBe("linux");
    expect(modelShortcutPlatform("Plan 9")).toBe("unknown");
  });

  it("keeps searched favorite reasoning variants and deduplicates exact routes", () => {
    const discoveredHigh = route("sol", true, "high");
    discoveredHigh.reasoningOptions = ["high", "xhigh"];
    const favoriteHigh = {
      ...discoveredHigh,
      key: "favorite-high",
      selection: {
        ...discoveredHigh.selection,
        reasoningEffort: "high",
      },
    };
    const favoriteXhigh = {
      ...discoveredHigh,
      key: "favorite-xhigh",
      reasoningEffort: "xhigh",
      selection: {
        ...discoveredHigh.selection,
        reasoningEffort: "xhigh",
      },
    };

    const searchable = searchableModelChooserRoutes(
      [discoveredHigh],
      [favoriteHigh, favoriteXhigh],
    );

    expect(searchable.map(({ reasoningEffort, selection }) => [
      reasoningEffort,
      selection.reasoningEffort,
    ])).toEqual([
      ["high", "high"],
      ["xhigh", "xhigh"],
    ]);
    expect(searchable).toHaveLength(2);
  });

  it("owns labelled autofocus search, composed filters, focus restoration, and keyboard commands", () => {
    const source = readFileSync(
      new URL("../../src/renderer/src/components/ModelChooser.tsx", import.meta.url),
      "utf8",
    );
    const css = readFileSync(
      new URL("../../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    );

    expect(source).toContain('aria-label="Search models"');
    expect(source).toContain("searchRef.current?.focus()");
    expect(source).toContain("filterModelRoutesBySource");
    expect(source).toContain("searchModelRoutes(sourceRoutes, query)");
    expect(source).toContain("resolveModelShortcutBindings");
    expect(source).toContain("triggerRef.current?.focus()");
    expect(source).toContain('event.key !== "Escape"');
    expect(source).toContain(
      'document.addEventListener("keydown", handleKeyDown, true)',
    );
    expect(source).toContain("event.stopPropagation()");
    expect(source).toContain('"ArrowDown", "ArrowUp", "Home", "End"');
    expect(source).toContain('role="listbox"');
    expect(source).toContain("results.emptyState");
    expect(css).toContain(".model-chooser-palette");
    expect(css).toContain(".model-chooser-header:focus-within");
    expect(css).toContain("calc(100dvh - 178px)");
  });
});
