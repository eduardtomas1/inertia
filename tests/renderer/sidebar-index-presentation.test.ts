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
  it("keeps a visible keyboard focus outline on Work rows", () => {
    expect(css).toMatch(/^:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/mu);
    expect(css).toMatch(/^:is\([^{]*\.activity-thread-select,[^{]*\):focus-visible\s*\{\s*outline-offset:\s*-2px;/mu);
    expect(css).not.toMatch(/\.activity-thread-select:focus-visible\s*\{[^}]*outline:\s*(?:0|none)/su);
  });

  it("lifts faint metadata to muted text on selected fills, where faint text falls below 4.5:1", () => {
    expect(css).toContain(".activity-thread.is-active .activity-thread-trailing,\n.activity-thread.is-active .activity-thread-trailing time,\n.activity-thread.is-active .activity-thread-branch-meta {\n  color: var(--text-muted);\n}");
    expect(css).toContain(".workspace-panel-tab:is(.is-active, .is-dragging) .workspace-panel-badge {\n  color: var(--text-muted);\n}");
  });

  it("keeps the trailing action hit target stable during press feedback", () => {
    expect(css).toMatch(/\.activity-thread-trailing\s*\{[^}]*pointer-events:\s*none;/su);
    expect(css).not.toContain(".activity-thread-menu-button");
    expect(css).toMatch(/\.thread-inline-actions\s*\{[^}]*position:\s*absolute;[^}]*top:\s*6px;[^}]*right:\s*4px;/su);
    expect(css).toMatch(/\.thread-inline-actions \.icon-button\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/su);
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
    expect(arrivalRule).toContain("work-status-arrival var(--dur-slow)");
    expect(arrivalRule).not.toContain("infinite");
  });

  it("exposes selected, focus, and status boundaries in forced colors", () => {
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread\.is-active[\s\S]*?border-color:\s*Highlight;/u);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread\.is-active \.activity-thread-select,[\s\S]*?color:\s*HighlightText;/u);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread-select:focus-visible[\s\S]*?outline-color:\s*Highlight;/u);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread-status-label \.agent-pixel-loader > span\s*\{[^}]*background:\s*CanvasText;/u);
  });

  it("keeps colour for statuses that need you and lets Completed recede to its green check", () => {
    expect(css).toContain(".activity-thread.status-completed .activity-thread-status-label {\n  color: var(--text-faint);\n  font-weight: 400;\n}");
    expect(css).toContain(".activity-thread.status-completed .activity-thread-status-label > [data-work-status] {\n  color: var(--status-completed);\n}");
    expect(css).toContain(".activity-thread.is-active.status-completed .activity-thread-status-label {\n  color: var(--text-muted);\n}");
    for (const [status, token] of [["approval", "status-approval"], ["input", "status-input"], ["failed", "status-failed"], ["limited", "warning"]]) {
      expect(css).toContain(`.activity-thread.status-${status} .activity-thread-status-label { color: var(--${token}); }`);
    }
    expect(css).toMatch(/\.activity-thread-status-label \{[^}]*font-weight: 500;/u);
  });

  it("raises the selected row as a tile whose ring stays inside the clipped list", () => {
    expect(css).toContain(".activity-thread.is-active {\n  background: var(--paper);\n  box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), inset 0 0 0 1px var(--line-soft);\n}");
    expect(css).toContain(':root[data-theme="dark"] .activity-thread.is-active {\n  background: var(--fill-strong);\n  box-shadow: inset 0 1px 0 var(--raised-edge), inset 0 0 0 1px var(--line-soft);\n}');
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.activity-thread\.is-active,\n  :root\[data-theme="dark"\] \.activity-thread\.is-active \{[^}]*background: Highlight;[^}]*box-shadow: none;/u);
  });
});

