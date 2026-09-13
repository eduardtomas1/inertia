import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = ["styles.css", "sidebar-work-index.css", "components/sidebar/thread-actions.css"]
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
    expect(css).not.toContain(".activity-thread-menu-button");
    expect(css).toMatch(/\.thread-inline-actions\s*\{[^}]*position:\s*absolute;[^}]*top:\s*7px;[^}]*right:\s*8px;/su);
    expect(css).toMatch(/\.thread-inline-actions button\s*\{[^}]*height:\s*23px;/su);
    expect(css).not.toMatch(/\.thread-inline-actions[^{}]*\{[^}]*transform:/su);
  });

  it("stops decorative motion for reduced motion and hidden documents", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.activity-thread-status-label \.agent-pixel-loader\[data-animated="true"\] > span\s*\{[^}]*animation:\s*none;/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.activity-thread-status-label \[data-work-arrival\] > svg\s*\{[^}]*animation:\s*none;/u);
    expect(css).toMatch(/\.app-shell\[data-document-visible="false"\] \.agent-pixel-loader > span\s*\{[^}]*animation-play-state:\s*paused;/u);
    expect(css).not.toContain(".activity-thread-state-mark");
    expect(css).not.toContain("will-change:");
  });

  it("loops only the Working glyph and lets every other status arrive once", () => {
    const orbitRule = css.match(
      /\.agent-pixel-loader\[data-animated="true"\]\[data-rhythm="orbit"\] > span\s*\{([^}]*)\}/u,
    )?.[1] ?? "";
    const arrivalRule = css.match(
      /\.activity-thread-status-label \[data-work-arrival\] > svg\s*\{([^}]*)\}/u,
    )?.[1] ?? "";

    expect(orbitRule).toContain("animation-duration: 950ms");
    // The shorthand would reset animation-play-state and beat the hidden-document pause.
    expect(orbitRule).not.toMatch(/(^|[\s;])animation:/u);
    expect(arrivalRule).toContain("work-status-arrival 420ms");
    expect(arrivalRule).not.toContain("infinite");
  });

  it("exposes selected, focus, and status boundaries in forced colors", () => {
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread\.is-active[\s\S]*?border-color:\s*Highlight;/u);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread\.is-active \.activity-thread-select,[\s\S]*?color:\s*HighlightText;/u);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread-select:focus-visible[\s\S]*?outline-color:\s*Highlight;/u);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread-status-label \.agent-pixel-loader > span\s*\{[^}]*background:\s*CanvasText;/u);
  });
});
