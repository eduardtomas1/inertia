import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("Minimal Workstream tokens", () => {
  it("defines one semantic layout, surface, state, type, spacing, radius, control, and motion layer", () => {
    const root = css.match(/:root\s*\{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";

    for (const token of [
      "--transcript-max-width",
      "--final-answer-max-width",
      "--commentary-max-width",
      "--user-request-max-width",
      "--composer-max-width",
      "--conversation-canvas-surface",
      "--workspace-tools-surface",
      "--workspace-tools-separator",
      "--composer-surface",
      "--composer-border",
      "--composer-shadow",
      "--composer-bottom-breathing-room",
      "--execution-text",
      "--execution-muted-text",
      "--execution-separator",
      "--activity-rail-border",
      "--active-work-gradient-primary",
      "--active-work-gradient-secondary",
      "--active-work-gradient-opacity",
      "--final-answer-text",
      "--metadata-text",
      "--user-request-tint",
      "--approval-accent",
      "--question-accent",
      "--warning-accent",
      "--failure-accent",
      "--success-accent",
      "--quiet-secondary",
      "--quiet-muted",
      "--answer-font-size",
      "--metadata-font-size",
      "--activity-row-font-size",
      "--transcript-section-spacing",
      "--settled-layer-spacing",
      "--settled-footer-spacing",
      "--settled-artifact-spacing",
      "--turn-spacing",
      "--markdown-paragraph-spacing",
      "--radius-small",
      "--radius-medium",
      "--radius-composer",
      "--control-height",
      "--control-height-small",
      "--composer-control-height",
      "--model-row-height",
      "--popover-width",
      "--model-chooser-width",
      "--motion-fast",
      "--motion-base",
      "--motion-slow",
      "--motion-ease",
    ]) {
      expect(root, `missing ${token}`).toContain(`${token}:`);
    }

    expect(root).toContain("--active-work-gradient-primary: var(--status-working)");
    expect(root).toContain("--active-work-gradient-secondary: var(--accent)");
    expect(root).toContain("--approval-accent: var(--status-approval)");
    expect(root).toContain("--question-accent: var(--status-input)");
    expect(root).toContain("--success-accent: var(--status-completed)");
    expect(root).toContain("--warning-accent: var(--warning)");
    expect(root).toContain("--failure-accent: var(--status-failed)");
    expect(root).toContain("--quiet-secondary: var(--text-soft)");
    expect(root).toContain("--quiet-muted: var(--text-muted)");
    expect(root).toContain("--answer-max-width: var(--final-answer-max-width)");
    expect(root).toContain("--user-message-max-width: var(--user-request-max-width)");
    expect(root).toContain("--execution-rail-border: var(--activity-rail-border)");
    expect(root).toMatch(/--motion-fast:\s*140ms/u);
    expect(root).toMatch(/--motion-base:\s*180ms/u);
    expect(root).toMatch(/--motion-slow:\s*220ms/u);
    expect(root).toMatch(/--ui-font-main:\s*14px/u);
    expect(root).toMatch(/--ui-font-secondary:\s*11\.5px/u);
  });

  it("adapts layout and controls through interface scale", () => {
    for (const scale of ["compact", "comfortable", "large"]) {
      const scaleBlock =
        css.match(
          new RegExp(
            `:root\\[data-interface-scale="${scale}"\\]\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`,
            "u",
          ),
        )?.groups?.body ?? "";

      expect(scaleBlock).toContain("--transcript-max-width:");
      expect(scaleBlock).toContain("--final-answer-max-width:");
      expect(scaleBlock).toContain("--commentary-max-width:");
      expect(scaleBlock).toContain("--user-request-max-width:");
      expect(scaleBlock).toContain("--composer-max-width:");
      expect(scaleBlock).toContain("--popover-width:");
      expect(scaleBlock).toContain("--model-chooser-width:");
      expect(scaleBlock).toContain("--radius-composer:");
    }

    expect(css).toMatch(
      /--model-row-height:\s*calc\(var\(--ui-control-height\)\s*\+\s*6px\)/u,
    );
  });

  it("derives transcript type from interface scale and preserves density and Linux readability adjustments", () => {
    expect(css).toMatch(
      /--answer-font-size:\s*calc\(var\(--ui-font-main\)\s*\+\s*1\.5px\s*\+\s*var\(--platform-readability-adjustment\)\)/u,
    );
    expect(css).toMatch(
      /\.app-shell\.platform-linux\s*\{[^}]*--platform-readability-adjustment:\s*0\.25px;/su,
    );
    expect(css).toMatch(
      /\.chat-workspace\s*\{[^}]*--response-font-size:\s*var\(--answer-font-size\);[^}]*--response-line-height:\s*var\(--answer-line-height\);[^}]*--response-turn-gap:\s*var\(--turn-spacing\);[^}]*--response-block-gap:\s*var\(--section-spacing\);/su,
    );
    expect(css).toMatch(
      /\.chat-workspace\.response-density-compact\s*\{[^}]*--answer-font-size:[^}]*--transcript-section-spacing:\s*13px;[^}]*--settled-layer-spacing:\s*10px;[^}]*--settled-footer-spacing:\s*6px;[^}]*--settled-artifact-spacing:\s*1px;[^}]*--markdown-paragraph-spacing:\s*0\.82em;[^}]*--turn-spacing:\s*28px;/su,
    );
    expect(css).toMatch(
      /\.chat-workspace\.response-density-comfortable\s*\{[^}]*--answer-font-size:[^}]*--transcript-section-spacing:\s*22px;[^}]*--settled-layer-spacing:\s*15px;[^}]*--settled-footer-spacing:\s*10px;[^}]*--settled-artifact-spacing:\s*3px;[^}]*--markdown-paragraph-spacing:\s*1\.05em;[^}]*--turn-spacing:\s*44px;/su,
    );
  });

  it("routes core transcript and composer surfaces through the semantic layer", () => {
    expect(css).toMatch(
      /\.composer\s*\{[^}]*max-width:\s*var\(--composer-max-width\);[^}]*border:\s*1px solid var\(--composer-border\);[^}]*border-radius:\s*var\(--radius-composer\);[^}]*background:\s*var\(--composer-surface\);[^}]*box-shadow:\s*var\(--composer-shadow\);/su,
    );
    expect(css).toMatch(
      /\.response-turn\s*>\s*\.turn-user-request\s*\{[^}]*background:\s*var\(--user-request-tint\);/su,
    );
    expect(css).toMatch(
      /\.turn-commentary-row\s+\.response-markdown\s*\{[^}]*color:\s*var\(--execution-text\);/su,
    );
  });
});
