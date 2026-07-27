import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ModelChooserFavoriteButton,
  ModelChooserRow,
  activateModelChooserFavorite,
  activateModelChooserRow,
  isModelChooserSelectionKey,
  modelChooserCompatibilityLabel,
  modelChooserRowFromRoute,
  type ModelChooserRowData,
} from "../../src/renderer/src/components/ModelChooserRow";
import type { ModelSearchRoute } from "../../src/renderer/src/utils/modelSearch";

function route(update: Partial<ModelSearchRoute> = {}): ModelSearchRoute {
  return {
    key: "codex-app-server\u001fbuiltin:openai\u001fgpt-5.6-sol",
    harnessId: "codex-app-server",
    backendProfileId: "builtin:openai",
    modelId: "gpt-5.6-sol",
    displayName: "GPT 5.6 Sol",
    alias: "Sol",
    harnessLabel: "Codex",
    backendProfileName: "OpenAI",
    providerLabel: "Codex",
    source: "built-in",
    routeTerms: ["sol"],
    selectable: true,
    unavailableReason: null,
    ...update,
  };
}

function row(
  routeUpdate: Partial<ModelSearchRoute> = {},
  stateUpdate: Parameters<typeof modelChooserRowFromRoute>[1] = {
    active: false,
    favorite: false,
  },
): ModelChooserRowData {
  return modelChooserRowFromRoute(route(routeUpdate), stateUpdate);
}

function render(modelRow: ModelChooserRowData): string {
  return renderToStaticMarkup(createElement(ModelChooserRow, {
    row: modelRow,
    optionId: "model-option-sol",
    tabIndex: 0,
    onSelect: () => undefined,
  }));
}

function renderFavorite(modelRow: ModelChooserRowData): string {
  return renderToStaticMarkup(createElement(ModelChooserFavoriteButton, {
    row: modelRow,
    onFavoriteToggle: () => undefined,
  }));
}

describe("ModelChooserRow", () => {
  it("renders a compact option with truthful identity, raw ID, shortcut, and active state", () => {
    const html = render(row({}, {
      active: true,
      favorite: true,
      shortcut: { label: "⌘1", ariaKeyShortcuts: "Meta+1" },
      compatibility: {
        affectsSelection: true,
        state: "verified",
        explanation: "Selection was verified for this route.",
      },
    }));

    expect(html).toContain('role="presentation"');
    expect(html).toContain('id="model-option-sol"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-disabled="false"');
    expect(html).toContain('aria-keyshortcuts="Meta+1"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("GPT 5.6 Sol");
    expect(html).toContain("Codex · OpenAI");
    expect(html).toContain("<code");
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("<kbd");
    expect(html).toContain("⌘1");
    expect(html).toContain("Verified");
    expect(html).toContain("Active model");
    expect(renderFavorite(row({}, {
      active: true,
      favorite: true,
    }))).toContain('aria-pressed="true"');
  });

  it("keeps the favorite control outside the listbox option", () => {
    const html = render(row());
    const favoriteHtml = renderFavorite(row());
    const option = html.match(/<div[^>]+role="option"[^>]*>(.*?)<\/div>/s);

    expect(option?.[1]).toBeDefined();
    expect(option?.[1]).not.toContain("<button");
    expect(html).not.toContain('class="model-chooser-row-favorite"');
    expect(favoriteHtml).toContain('class="model-chooser-row-favorite"');
    expect(favoriteHtml).toContain('aria-pressed="false"');
  });

  it("uses only harness and backend identity and explicitly marks custom routes", () => {
    const html = render(row({
      harnessId: "claude-agent-sdk",
      backendProfileId: "custom:team",
      harnessLabel: "Claude harness",
      backendProfileName: "Team gateway",
      providerLabel: "Official provider label must not leak",
      source: "custom",
    }));

    expect(html).toContain("Claude harness · Team gateway");
    expect(html).toContain("<em>Custom</em>");
    expect(html).not.toContain("Official provider label must not leak");
  });

  it("shows raw model IDs only when the display name differs", () => {
    expect(render(row({ displayName: "gpt-5.6-sol" }))).not.toContain("<code");
    expect(render(row())).toContain('<code class="model-chooser-row-model-id"');
  });

  it("surfaces compatibility states only when they affect selection", () => {
    expect(modelChooserCompatibilityLabel({
      affectsSelection: false,
      state: "unknown",
      explanation: "Purely informational.",
    })).toBeNull();
    expect(modelChooserCompatibilityLabel({
      affectsSelection: true,
      state: "partial",
      explanation: "One selection feature is unavailable.",
    })).toBe("Partial");

    const html = render(row({}, {
      active: false,
      favorite: false,
      compatibility: {
        affectsSelection: false,
        state: "unknown",
        explanation: "Purely informational.",
      },
    }));
    expect(html).not.toContain("Unknown");
    expect(html).not.toContain("Purely informational.");
  });

  it("requires and describes a disabled compatibility explanation", () => {
    expect(() => row({
      selectable: false,
      unavailableReason: null,
    })).toThrow("requires a compatibility explanation");

    const html = render(row({
      selectable: false,
      unavailableReason: "This harness cannot switch models in the current session.",
    }));
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('class="model-chooser-row-disabled-reason"');
    expect(html).toContain("This harness cannot switch models in the current session.");
  });

  it("does not select disabled rows and toggles favorites independently", () => {
    const disabled = row({
      selectable: false,
      unavailableReason: "Unavailable for this harness.",
    });
    const onSelect = vi.fn();
    const onFavoriteToggle = vi.fn();
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    expect(activateModelChooserRow(disabled, onSelect)).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();

    activateModelChooserFavorite(event, disabled, onFavoriteToggle);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onFavoriteToggle).toHaveBeenCalledWith(disabled);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("accepts unmodified Enter and Space as option selection keys", () => {
    const event = {
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };
    expect(isModelChooserSelectionKey({ ...event, key: "Enter" })).toBe(true);
    expect(isModelChooserSelectionKey({ ...event, key: " " })).toBe(true);
    expect(isModelChooserSelectionKey({ ...event, key: "ArrowDown" })).toBe(false);
    expect(isModelChooserSelectionKey({ ...event, key: "Enter", metaKey: true })).toBe(false);
  });

  it("uses namespaced semantic, truncation, focus, disabled, scale, and narrow styles", () => {
    const styles = readFileSync(
      new URL("../../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    );
    const block = styles.slice(styles.indexOf("/* Reusable model chooser result row."));

    expect(block).toContain(".model-chooser-row-option");
    expect(block).toContain(":has(.model-chooser-row-option:focus-visible)");
    expect(block).toContain('.model-chooser-row-option[aria-disabled="true"]');
    expect(block).toContain(".model-chooser-row.is-active");
    expect(block).toContain('var(--model-row-height)');
    expect(block).toContain("var(--ui-control-height)");
    expect(block).toContain("var(--surface-hover)");
    expect(block).toContain("text-overflow: ellipsis");
    expect(block).toContain("@container (max-width: 420px)");
    expect(block).not.toContain("model-chooser-row-card");
  });
});
