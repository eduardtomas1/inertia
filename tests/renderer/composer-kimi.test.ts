import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createKimiClaudeBackendProfile,
  createKimiClaudeModelSelection,
  KIMI_CLAUDE_REASONING_OPTIONS,
  modelSelectionIdentityLabel,
} from "../../src/shared/claude-backend-profiles";

describe("Kimi composer identity", () => {
  it("uses the persisted identity and verified effort mappings without native Claude models", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:composer",
      secretReference: "secret:kimi-composer",
      primaryModelId: "k3",
    });
    const selection = createKimiClaudeModelSelection({ profile });
    const source = readFileSync(
      new URL("../../src/renderer/src/components/Composer.tsx", import.meta.url),
      "utf8",
    );

    expect(modelSelectionIdentityLabel(selection)).toBe(
      "Claude harness · Kimi · K3",
    );
    expect(source).toContain("title={selectedIdentityLabel}");
    expect(source).toContain(
      "kimiSelection ? selectedIdentityLabel : selectedModel?.label",
    );
    expect(source).toContain(
      "disabled: !kimiSelection && !selectedProvider?.models.length",
    );
    expect(source).toContain(
      "reasoningOptions: KIMI_CLAUDE_REASONING_OPTIONS",
    );
    expect(KIMI_CLAUDE_REASONING_OPTIONS.map(({ value, description }) => [
      value,
      description,
    ])).toEqual([
      ["auto", "Uses K3 high effort"],
      ["low", "Uses K3 low effort"],
      ["medium", "Maps to K3 high effort"],
      ["high", "Uses K3 high effort"],
      ["xhigh", "Maps to K3 max effort"],
      ["max", "Uses K3 max effort"],
    ]);
  });

  it("bounds and truncates the long identity without allowing it to displace the fixed send control", () => {
    const css = readFileSync(
      new URL("../../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(/\.composer-provider-control\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*0 1 auto;/su);
    expect(css).toMatch(/\.composer-provider-control \.composer-pill\s*\{[^}]*max-width:\s*190px;/su);
    expect(css).toMatch(/\.composer-pill > span\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/su);
    expect(css).toMatch(/\.send-button\s*\{[^}]*flex:\s*0 0 32px;/su);
    expect(css).toMatch(/@media \(max-width:\s*560px\)\s*\{[\s\S]*?\.composer-options \.composer-pill span\s*\{[^}]*display:\s*none;/u);
  });
});
