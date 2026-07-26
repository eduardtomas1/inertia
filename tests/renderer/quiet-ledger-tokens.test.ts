import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("Quiet Ledger transcript tokens", () => {
  it("defines one semantic layout, surface, state, type, spacing, radius, and motion layer", () => {
    const root = css.match(/:root\s*\{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";

    for (const token of [
      "--transcript-max-width",
      "--answer-max-width",
      "--user-message-max-width",
      "--execution-rail-background",
      "--execution-rail-border",
      "--active-work-accent",
      "--success-state",
      "--warning-state",
      "--failure-state",
      "--quiet-secondary",
      "--quiet-muted",
      "--answer-font-size",
      "--metadata-font-size",
      "--activity-row-font-size",
      "--section-spacing",
      "--radius-small",
      "--radius-medium",
      "--radius-content",
      "--motion-fast",
      "--motion-base",
      "--motion-slow",
      "--motion-ease",
    ]) {
      expect(root, `missing ${token}`).toContain(`${token}:`);
    }

    expect(root).toContain("--active-work-accent: var(--status-working)");
    expect(root).toContain("--success-state: var(--status-completed)");
    expect(root).toContain("--warning-state: var(--status-approval)");
    expect(root).toContain("--failure-state: var(--status-failed)");
    expect(root).toContain("--quiet-secondary: var(--text-soft)");
    expect(root).toContain("--quiet-muted: var(--text-muted)");
    expect(root).toMatch(/--motion-fast:\s*140ms/u);
    expect(root).toMatch(/--motion-base:\s*180ms/u);
    expect(root).toMatch(/--motion-slow:\s*220ms/u);
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
      /\.chat-workspace\.response-density-compact\s*\{[^}]*--answer-font-size:[^}]*--section-spacing:\s*13px;[^}]*--turn-spacing:\s*28px;/su,
    );
    expect(css).toMatch(
      /\.chat-workspace\.response-density-comfortable\s*\{[^}]*--answer-font-size:[^}]*--section-spacing:\s*22px;[^}]*--turn-spacing:\s*44px;/su,
    );
  });
});
