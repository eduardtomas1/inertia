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
      new URL("../../src/renderer/src/components/composer/Composer.tsx", import.meta.url),
      "utf8",
    );
    const toolbarSource = readFileSync(
      new URL("../../src/renderer/src/components/composer/ComposerToolbar.tsx", import.meta.url),
      "utf8",
    );

    expect(modelSelectionIdentityLabel(selection)).toBe(
      "Claude harness · Kimi · K3",
    );
    expect(toolbarSource).toContain("selectedRoute={selectedModelRoute}");
    expect(toolbarSource).toContain("<ModelChooser");
    expect(source).toContain("const selectedIdentityLabel");
    expect(source).toContain("composerHarnessLabel(selectedBackendProfile.harnessId)");
    expect(source).toContain("resolveComposerRouteState");
    expect(source).toContain("selectedModel?.reasoningOptions");
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

    expect(css).toMatch(/\.model-chooser-anchor\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*0 1 auto;/su);
    expect(css).toMatch(/\.selected-model-chip-label\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/su);
    expect(css).toMatch(
      /\.send-button\s*\{[^}]*flex:\s*0 0 var\(--composer-control-height\);/su,
    );
    expect(css).toMatch(/@container \(max-width:\s*480px\)\s*\{[\s\S]*?\.model-chooser-anchor\s*\{[^}]*max-width:\s*52px/u);
  });
});
