import { readFileSync } from "node:fs";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SelectedModelChip } from "../../src/renderer/src/components/SelectedModelChip";
import {
  selectedModelChipGlyph,
  selectedModelChipIdentity,
  selectedModelChipLabel,
} from "../../src/renderer/src/utils/selectedModelChip";
import type { ModelSearchRoute } from "../../src/renderer/src/utils/modelSearch";

function route(update: Partial<ModelSearchRoute> = {}): ModelSearchRoute {
  return {
    key: "codex-app-server\u001fbuiltin:openai\u001fgpt-5.6-sol",
    harnessId: "codex-app-server",
    harnessLabel: "Codex",
    backendProfileId: "builtin:openai",
    backendProfileName: "OpenAI",
    providerLabel: "Codex",
    modelId: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    alias: "Sol",
    source: "built-in",
    routeTerms: [],
    selectable: true,
    unavailableReason: null,
    ...update,
  };
}

function render(
  modelRoute: ModelSearchRoute = route(),
  update: Partial<Parameters<typeof SelectedModelChip>[0]> = {},
): string {
  return renderToStaticMarkup(createElement(SelectedModelChip, {
    route: modelRoute,
    expanded: false,
    controlsId: "model-chooser",
    onOpen: () => undefined,
    ...update,
  }));
}

describe("selected model chip", () => {
  it("shows only the clearest model label while retaining the exact route identity", () => {
    const identity = selectedModelChipIdentity(route());

    expect(identity.label).toBe("GPT-5.6-Sol");
    expect(identity.glyph).toBe("codex");
    expect(identity.title).toBe(
      "Current model: Codex (codex-app-server) · OpenAI (builtin:openai) · Model GPT-5.6-Sol (gpt-5.6-sol) · Reasoning Provider default",
    );
    expect(identity.accessibleName).toBe(
      "Choose model. Current selection: Codex (codex-app-server) · OpenAI (builtin:openai) · Model GPT-5.6-Sol (gpt-5.6-sol) · Reasoning Provider default.",
    );

    const html = render();
    const content = html.match(/<button[^>]*>(.*)<\/button>/s)?.[1] ?? "";
    expect(content).toContain("GPT-5.6-Sol");
    expect(content).not.toContain("codex-app-server");
    expect(content).not.toContain("builtin:openai");
    expect(content).not.toContain(" · ");
  });

  it("uses route display names for Kimi and Claude rather than backend identity", () => {
    expect(selectedModelChipLabel(route({
      displayName: "Kimi K3",
      modelId: "kimi-k3",
      harnessId: "claude-agent-sdk",
      harnessLabel: "Claude",
      backendProfileId: "builtin:kimi-code",
      backendProfileName: "Kimi",
    }))).toBe("Kimi K3");
    expect(selectedModelChipLabel(route({
      displayName: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      harnessId: "claude-agent-sdk",
      harnessLabel: "Claude",
      backendProfileId: "builtin:anthropic",
      backendProfileName: "Anthropic",
    }))).toBe("Claude Sonnet 4.6");
  });

  it("canonicalizes the provider-default sentinel and safely falls back to alias or ID", () => {
    expect(selectedModelChipLabel(route({
      displayName: "OpenAI fallback",
      modelId: "provider-default",
    }))).toBe("Provider default");
    expect(selectedModelChipLabel(route({
      displayName: "   ",
      alias: "Friendly alias",
    }))).toBe("Friendly alias");
    expect(selectedModelChipLabel(route({
      displayName: "",
      alias: null,
      modelId: "raw-model",
    }))).toBe("raw-model");

    const identity = selectedModelChipIdentity(route({
      displayName: "Ignored fallback label",
      modelId: "provider-default",
    }));
    expect(identity.title).toContain("Model Provider default (provider-default)");
  });

  it("labels custom backends truthfully without using providerLabel", () => {
    const custom = route({
      key: "claude-agent-sdk\u001fcustom:team\u001fmodel-x",
      harnessId: "claude-agent-sdk",
      harnessLabel: "Claude harness",
      backendProfileId: "custom:team",
      backendProfileName: "Team gateway",
      providerLabel: "Official Anthropic label must not leak",
      modelId: "team/model-x",
      displayName: "Review model",
      source: "custom",
    });
    const identity = selectedModelChipIdentity(custom);

    expect(identity.glyph).toBe("custom");
    expect(identity.title).toContain(
      "Custom backend Team gateway (custom:team) via Claude harness (claude-agent-sdk)",
    );
    expect(identity.title).toContain("Review model (team/model-x)");
    expect(identity.title).not.toContain("Official Anthropic label must not leak");
    expect(render(custom)).toContain('data-model-source="custom"');
  });

  it("derives recognizable glyph families only from source and harness", () => {
    expect(selectedModelChipGlyph(route())).toBe("codex");
    expect(selectedModelChipGlyph(route({
      harnessId: "claude-cli",
    }))).toBe("claude");
    expect(selectedModelChipGlyph(route({
      harnessId: "cursor-acp",
    }))).toBe("cursor");
    expect(selectedModelChipGlyph(route({
      harnessId: "gemini-acp",
    }))).toBe("gemini");
    expect(selectedModelChipGlyph(route({
      harnessId: "opencode-sdk",
    }))).toBe("opencode");
    expect(selectedModelChipGlyph(route({
      harnessId: "future-harness",
    }))).toBe("unknown");
    expect(selectedModelChipGlyph(route({
      harnessId: "claude-agent-sdk",
      source: "custom",
    }))).toBe("custom");
  });

  it("exposes the popup, controls, expanded, disabled, and forwarded-ref contract", () => {
    const ref = createRef<HTMLButtonElement>();
    const html = renderToStaticMarkup(createElement(SelectedModelChip, {
      ref,
      route: route(),
      expanded: true,
      controlsId: "chooser-listbox",
      ariaHasPopup: "listbox",
      disabled: true,
      onOpen: vi.fn(),
    }));

    expect(html).toContain('type="button"');
    expect(html).toContain('class="selected-model-chip is-open"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-controls="chooser-listbox"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("disabled");
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('tabindex="-1"');
  });

  it("makes the source glyph optional without removing the chevron", () => {
    const withGlyph = render();
    const withoutGlyph = render(route(), { showSourceGlyph: false });

    expect(withGlyph).toContain('class="selected-model-chip-glyph"');
    expect(withGlyph.match(/<svg/gu)).toHaveLength(2);
    expect(withoutGlyph).not.toContain('class="selected-model-chip-glyph"');
    expect(withoutGlyph.match(/<svg/gu)).toHaveLength(1);
    expect(withoutGlyph).toContain("selected-model-chip-chevron");
  });

  it("keeps long and unsafe labels complete in metadata while React escapes markup", () => {
    const displayName = `<script>${"Long model ".repeat(30)}</script>`;
    const html = render(route({ displayName }));
    const identity = selectedModelChipIdentity(route({ displayName }));

    expect(identity.label).toBe(displayName);
    expect(identity.title).toContain(displayName);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("uses platform-neutral Linux-readable scale, focus, open, disabled, truncation, and narrow styles", () => {
    const styles = readFileSync(
      new URL("../../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    );
    const block = styles.slice(styles.indexOf("/* Compact selected-model trigger."));

    expect(block).toContain(".selected-model-chip:hover");
    expect(block).toContain(".selected-model-chip:focus-visible");
    expect(block).toContain('.selected-model-chip[aria-expanded="true"]');
    expect(block).toContain(".selected-model-chip:disabled");
    expect(block).toContain("var(--ui-control-height)");
    expect(block).toContain("var(--ui-font-secondary)");
    expect(block).toContain("font-size: max(var(--ui-font-secondary), 10px)");
    expect(block).toContain("var(--surface-hover)");
    expect(block).toContain("text-overflow: ellipsis");
    expect(block).toContain("white-space: nowrap");
    expect(block).toContain("@container (max-width: 420px)");
    expect(block).toContain("@media (max-width: 640px)");
    expect(block).not.toContain("-apple-system");
  });
});
