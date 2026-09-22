import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");

function cssBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return "";
  const openIndex = source.indexOf("{", markerIndex);
  if (openIndex < 0) return "";
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return "";
}

describe("Minimal Workstream conversation canvas", () => {
  it("uses one quiet surface and keeps the reading column optically centered", () => {
    const workspaceBody = cssBlock(css, ".workspace-body {");
    const chat = cssBlock(css, "/* Chat */\n.chat-workspace {");
    const scroll = cssBlock(css, ".message-scroll {");
    const turn = cssBlock(css, "\n.response-turn {\n");

    expect(workspaceBody).toContain("background: var(--conversation-canvas-surface)");
    expect(chat).toContain("background: var(--conversation-canvas-surface)");
    expect(scroll).toContain("overflow-x: hidden");
    expect(scroll).toContain("scrollbar-gutter: stable both-edges");
    expect(turn).toContain("max-width: var(--transcript-max-width)");
    expect(turn).toMatch(/margin:\s*0 auto var\(--response-turn-gap\)/u);
  });

  it("keeps optional workspace tools secondary without a permanent divider rail", () => {
    const panel = cssBlock(css, "\n.workspace-panel {\n");
    const tabs = cssBlock(css, ".workspace-panel-tabs {");
    const stackedTabs = cssBlock(css, ".workspace-panel.is-stacked > .workspace-panel-tabs {");
    const header = cssBlock(css, "\n.workspace-header {\n");

    expect(panel).toContain("background: var(--workspace-tools-surface)");
    expect(panel).toContain("border-left: 0");
    expect(tabs).toContain("height: 52px");
    expect(header).toContain("height: 52px");
    expect(tabs).not.toContain("border-bottom");
    expect(header).not.toContain("border-bottom");
    expect(stackedTabs).toContain("border-bottom: 1px solid var(--workspace-tools-separator)");
    expect(css).toMatch(
      /\.sidebar-resize-handle::after,\s*\.workspace-tools-resize-handle::after\s*\{[^}]*background:\s*transparent;/su,
    );
    expect(css).toMatch(
      /\.pane-resize-handle:hover::after,\s*\.pane-resize-handle:focus-visible::after\s*\{[^}]*background:\s*var\(--accent\)/su,
    );
  });

  it("presents jump-to-latest as an inline affordance instead of a transcript strip", () => {
    const controls = cssBlock(css, ".timeline-follow-controls {");

    expect(controls).toContain("min-height: 0");
    expect(controls).toContain("border: 0");
    expect(controls).toContain("background: transparent");
  });

  it("keeps the chat readable beside the panel and overlays a sheet when there is no room", () => {
    const desktop = cssBlock(css, ".workspace-body {");
    const inline = cssBlock(css, ".workspace-body.has-tools {");
    const sheet = cssBlock(css, ".workspace-body > .workspace-panel.is-sheet {\n  width");

    expect(desktop).toContain("display: flex");
    expect(inline).toContain("padding-right: var(--workspace-tools-width)");
    expect(css).toMatch(
      /\.workspace-body > \.workspace-panel\.is-inline,\s*\.workspace-body > \.workspace-panel\.is-sheet\s*\{[^}]*position:\s*absolute;/su,
    );
    expect(sheet).toContain("max-width: calc(100% - 24px)");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.workspace-body > \.workspace-panel\.is-sheet:not\(\[hidden\]\)\s*\{[^}]*animation:/su,
    );
  });
});
