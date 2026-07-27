import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Bot, CloudCog, Command, ListFilter, MousePointer2, Star } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import {
  ModelSourceRail,
  activateModelSourceRailItem,
  modelSourceRailItemAccessibleLabel,
  modelSourceRailItemIcon,
} from "../../src/renderer/src/components/ModelSourceRail";
import {
  deriveModelSourceRailItems,
  filterModelRoutesBySource,
  isModelSourceRailActivationKey,
  modelSourceFilterId,
  nextModelSourceRailIndex,
  type ModelSourceRailItem,
} from "../../src/renderer/src/utils/modelSourceRail";
import type { ModelSearchRoute } from "../../src/renderer/src/utils/modelSearch";

function route(
  key: string,
  update: Partial<ModelSearchRoute> = {},
): ModelSearchRoute {
  return {
    key,
    harnessId: "codex-app-server",
    harnessLabel: "Codex",
    backendProfileId: "builtin:openai",
    backendProfileName: "OpenAI",
    providerLabel: "Codex",
    modelId: key,
    displayName: key,
    alias: null,
    source: "built-in",
    routeTerms: [],
    selectable: true,
    unavailableReason: null,
    ...update,
  };
}

const routes = [
  route("codex-a"),
  route("codex-b"),
  route("claude-a", {
    harnessId: "claude-agent-sdk",
    harnessLabel: "Claude",
    backendProfileId: "builtin:anthropic",
    backendProfileName: "Anthropic",
    providerLabel: "Claude",
  }),
  route("cursor-a", {
    harnessId: "cursor-acp",
    harnessLabel: "Cursor",
    backendProfileId: "builtin:cursor",
    backendProfileName: "Cursor",
    providerLabel: "Cursor",
  }),
  route("team-a-1", {
    harnessId: "claude-agent-sdk",
    harnessLabel: "Claude",
    backendProfileId: "custom:team-a",
    backendProfileName: "Team gateway",
    providerLabel: "Claude",
    source: "custom",
  }),
  route("team-a-2", {
    harnessId: "claude-agent-sdk",
    harnessLabel: "Claude",
    backendProfileId: "custom:team-a",
    backendProfileName: "Team gateway",
    providerLabel: "Claude",
    source: "custom",
  }),
  route("team-b-1", {
    harnessId: "codex-app-server",
    harnessLabel: "Codex",
    backendProfileId: "custom:team-b",
    backendProfileName: "Team gateway",
    providerLabel: "Codex",
    source: "custom",
  }),
  route("future-a", {
    harnessId: "future-harness",
    harnessLabel: "Future harness",
    backendProfileId: "builtin:future",
    backendProfileName: "Future",
    providerLabel: "Future",
  }),
] satisfies ModelSearchRoute[];

function renderRail(
  items: readonly ModelSourceRailItem[],
  selectedId: string | null = "all",
  withSetup = true,
): string {
  return renderToStaticMarkup(createElement(ModelSourceRail, {
    items,
    selectedId,
    resultsId: "model-results",
    onFilterChange: () => undefined,
    onSetupAction: withSetup ? () => undefined : undefined,
  }));
}

describe("model source rail", () => {
  it("derives useful groups in stable order from real routes", () => {
    const items = deriveModelSourceRailItems(routes, {
      favoriteRouteKeys: ["team-a-1", "removed"],
      setupActions: [{
        id: "setup-opencode",
        providerId: "opencode",
        label: "Set up OpenCode",
      }],
    });

    expect(items.map(({ label }) => label)).toEqual([
      "All",
      "Favorites",
      "Codex",
      "Claude",
      "Cursor",
      "OpenCode",
      "Team gateway",
      "Team gateway",
      "Future harness",
    ]);
    expect(items.map(({ routeCount }) => routeCount)).toEqual([
      8, 1, 2, 1, 1, 0, 2, 1, 1,
    ]);
    expect(items[5]?.setupAction?.id).toBe("setup-opencode");
    expect(items[6]?.filter).toEqual({
      kind: "custom",
      harnessId: "claude-agent-sdk",
      backendProfileId: "custom:team-a",
    });
    expect(items[7]?.filter).toEqual({
      kind: "custom",
      harnessId: "codex-app-server",
      backendProfileId: "custom:team-b",
    });
    expect(items[8]?.filter).toEqual({
      kind: "harness",
      harnessId: "future-harness",
    });
  });

  it("hides empty and unresolved groups unless they offer an explicit setup action", () => {
    expect(deriveModelSourceRailItems([], {
      favoriteRouteKeys: ["removed"],
    })).toEqual([]);
    expect(deriveModelSourceRailItems([routes[0]!], {
      favoriteRouteKeys: ["removed"],
    }).map(({ label }) => label)).toEqual(["All", "Codex"]);

    const setupOnly = deriveModelSourceRailItems([], {
      setupActions: [{
        id: "setup-claude",
        providerId: "claude",
        label: "Install Claude support",
      }],
    });
    expect(setupOnly).toMatchObject([{
      label: "Claude",
      routeCount: 0,
      routes: [],
      setupAction: { id: "setup-claude" },
    }]);
  });

  it("never flattens custom routes into their native harness family", () => {
    const claude = filterModelRoutesBySource(routes, {
      kind: "provider",
      providerId: "claude",
    });
    const teamA = filterModelRoutesBySource(routes, {
      kind: "custom",
      harnessId: "claude-agent-sdk",
      backendProfileId: "custom:team-a",
    });

    expect(claude.map(({ key }) => key)).toEqual(["claude-a"]);
    expect(teamA.map(({ key }) => key)).toEqual(["team-a-1", "team-a-2"]);
    expect(teamA[0]).toBe(routes[4]);
  });

  it("filters favorites and all routes without mutating discovery order", () => {
    expect(filterModelRoutesBySource(
      routes,
      { kind: "favorites" },
      ["team-b-1", "codex-a"],
    ).map(({ key }) => key)).toEqual(["codex-a", "team-b-1"]);
    expect(filterModelRoutesBySource(routes, { kind: "all" })).toEqual(routes);
    expect(filterModelRoutesBySource(routes, {
      kind: "harness",
      harnessId: "future-harness",
    }).map(({ key }) => key)).toEqual(["future-a"]);
  });

  it("keeps filter identities stable and collision-safe", () => {
    expect(modelSourceFilterId({ kind: "provider", providerId: "codex" }))
      .toBe("provider:codex");
    expect(modelSourceFilterId({
      kind: "custom",
      harnessId: "claude-agent-sdk",
      backendProfileId: "custom:team/a",
    })).toBe("custom:claude-agent-sdk:custom%3Ateam%2Fa");
  });

  it("supports wrapping Arrow navigation plus Home and End", () => {
    expect(nextModelSourceRailIndex(0, "ArrowUp", 4)).toBe(3);
    expect(nextModelSourceRailIndex(3, "ArrowDown", 4)).toBe(0);
    expect(nextModelSourceRailIndex(2, "Home", 4)).toBe(0);
    expect(nextModelSourceRailIndex(1, "End", 4)).toBe(3);
    expect(nextModelSourceRailIndex(-1, "ArrowDown", 4)).toBe(0);
    expect(nextModelSourceRailIndex(-1, "ArrowUp", 4)).toBe(3);
    expect(nextModelSourceRailIndex(0, "ArrowDown", 0)).toBe(-1);
  });

  it("activates only plain Enter or Space and routes filter/setup callbacks separately", () => {
    const items = deriveModelSourceRailItems([], {
      setupActions: [{
        id: "setup-claude",
        providerId: "claude",
        label: "Set up Claude",
      }],
    });
    const setupItem = items[0]!;
    const filterItem = deriveModelSourceRailItems([routes[0]!])[0]!;
    const onFilterChange = vi.fn();
    const onSetupAction = vi.fn();
    const baseEvent = {
      altKey: false,
      ctrlKey: false,
      isComposing: false,
      metaKey: false,
      repeat: false,
      shiftKey: false,
    };

    expect(isModelSourceRailActivationKey({ ...baseEvent, key: "Enter" })).toBe(true);
    expect(isModelSourceRailActivationKey({ ...baseEvent, key: " " })).toBe(true);
    expect(isModelSourceRailActivationKey({
      ...baseEvent,
      key: "Enter",
      ctrlKey: true,
    })).toBe(false);
    expect(activateModelSourceRailItem(filterItem, {
      onFilterChange,
      onSetupAction,
    })).toBe(true);
    expect(onFilterChange).toHaveBeenCalledWith(filterItem.filter, filterItem);
    expect(onSetupAction).not.toHaveBeenCalled();

    expect(activateModelSourceRailItem(setupItem, {
      onFilterChange,
      onSetupAction,
    })).toBe(true);
    expect(onSetupAction).toHaveBeenCalledWith(setupItem.setupAction, setupItem);
  });

  it("renders an accessible vertical toolbar with a non-color selected marker", () => {
    const items = deriveModelSourceRailItems(routes, {
      favoriteRouteKeys: ["codex-a"],
    });
    const html = renderRail(items, "favorites");

    expect(html).toContain('<nav class="model-source-rail" aria-label="Model sources">');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-controls="model-results"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('class="model-source-rail-selected"');
    expect(html).toContain("Selected");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("<svg");
  });

  it("exposes truthful custom labels, unique profile identity, and recognizable glyphs", () => {
    const items = deriveModelSourceRailItems(routes, {
      favoriteRouteKeys: ["codex-a"],
    });
    const all = items.find(({ filter }) => filter.kind === "all")!;
    const favorites = items.find(({ filter }) => filter.kind === "favorites")!;
    const codex = items.find(({ filter }) =>
      filter.kind === "provider" && filter.providerId === "codex")!;
    const cursor = items.find(({ filter }) =>
      filter.kind === "provider" && filter.providerId === "cursor")!;
    const custom = items.find(({ filter }) =>
      filter.kind === "custom"
      && filter.backendProfileId === "custom:team-a")!;
    const unknown = items.find(({ filter }) => filter.kind === "harness")!;

    expect(modelSourceRailItemIcon(all)).toBe(ListFilter);
    expect(modelSourceRailItemIcon(favorites)).toBe(Star);
    expect(modelSourceRailItemIcon(codex)).toBe(Command);
    expect(modelSourceRailItemIcon(cursor)).toBe(MousePointer2);
    expect(modelSourceRailItemIcon(custom)).toBe(CloudCog);
    expect(modelSourceRailItemIcon(unknown)).toBe(Bot);
    expect(modelSourceRailItemAccessibleLabel(custom)).toBe(
      "Team gateway, custom backend via Claude, 2 models, profile custom:team-a",
    );

    const html = renderRail(items);
    expect(html).toContain("Custom · Claude");
    expect(html).toContain("Custom · Codex");
    expect(html).toContain("profile custom:team-a");
    expect(html).toContain("profile custom:team-b");
  });

  it("disables setup-only items when no action callback is supplied", () => {
    const items = deriveModelSourceRailItems([], {
      setupActions: [{
        id: "setup-opencode",
        providerId: "opencode",
        label: "Set up OpenCode",
      }],
    });
    const html = renderRail(items, null, false);
    expect(html).toContain("disabled");
    expect(html).not.toContain('aria-pressed="false"');
  });

  it("uses namespaced semantic, scale, truncation, selected, and narrow styles", () => {
    const styles = readFileSync(
      new URL("../../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    );
    const block = styles.slice(styles.indexOf("/* Reusable model chooser source rail."));

    expect(block).toContain(".model-source-rail-toolbar");
    expect(block).toContain(".model-source-rail-item.is-selected");
    expect(block).toContain(".model-source-rail-item:focus-visible");
    expect(block).toContain(".model-source-rail-item:disabled");
    expect(block).toContain("box-shadow: inset 2px 0 0");
    expect(block).toContain("var(--ui-control-height)");
    expect(block).toContain("var(--ui-font-micro)");
    expect(block).toContain("var(--surface-hover)");
    expect(block).toContain("text-overflow: ellipsis");
    expect(block).toContain("@container (max-width: 520px)");
    expect(block).toContain("@media (max-width: 640px)");
  });
});
