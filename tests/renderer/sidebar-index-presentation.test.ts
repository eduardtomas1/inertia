import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = ["styles.css", "sidebar-work-index.css"]
  .map((fileName) => readFileSync(
    new URL(`../../src/renderer/src/${fileName}`, import.meta.url),
    "utf8",
  ))
  .join("\n")
  .replace(/\r\n?/gu, "\n");

describe("sidebar index presentation contracts", () => {
  it("keeps selected, hover, and keyboard focus treatments distinct", () => {
    expect(css).toMatch(/\.activity-thread:hover\s*\{[^}]*background:/su);
    expect(css).toMatch(/\.activity-thread\.is-active\s*\{[^}]*border-color:[^}]*background:[^}]*box-shadow:/su);
    expect(css).toMatch(/\.activity-thread-select:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/su);
  });

  it("adapts row density to compact, narrow, and wide sidebars", () => {
    expect(css).toContain(".sidebar.is-compact .activity-thread");
    expect(css).toContain(".sidebar.is-narrow .activity-thread-select");
    expect(css).toContain(".sidebar.is-wide .activity-thread-select");
  });

  it("keeps the trailing action hit target stable during press feedback", () => {
    expect(css).toMatch(/\.activity-thread-trailing\s*\{[^}]*pointer-events:\s*none;/su);
    expect(css).toMatch(/\.activity-thread-menu-button\s*\{[^}]*top:\s*0;[^}]*bottom:\s*0;[^}]*margin-block:\s*auto;/su);
  });

  it("stops decorative motion for reduced motion and hidden documents", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.activity-thread\.status-working \.activity-thread-state-mark\s*\{[\s\S]*?animation:\s*none;/u);
    expect(css).toContain(
      '.app-shell[data-document-visible="false"] .activity-thread.status-working .activity-thread-state-mark',
    );
    expect(css).toContain("animation-play-state: paused;");
  });

  it("exposes selected, focus, and status boundaries in forced colors", () => {
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread\.is-active[\s\S]*?border-color:\s*Highlight;/u);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread\.is-active \.activity-thread-select,[\s\S]*?color:\s*HighlightText;/u);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread-select:focus-visible[\s\S]*?outline-color:\s*Highlight;/u);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread-state-mark,[\s\S]*?border:\s*1px solid CanvasText;/u);
  });
});
