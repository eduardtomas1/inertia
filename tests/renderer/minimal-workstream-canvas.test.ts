import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

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
    const panel = cssBlock(css, ".workspace-panel {");
    const tabs = cssBlock(css, ".workspace-panel-tabs {");
    const scopedTabs = cssBlock(css, ".workspace-panel > .workspace-panel-tabs {");

    expect(panel).toContain("background: var(--workspace-tools-surface)");
    expect(panel).toContain("border-left: 0");
    expect(tabs).toContain("border-bottom: 1px solid var(--workspace-tools-separator)");
    expect(scopedTabs).toContain("background: var(--workspace-tools-surface)");
    expect(scopedTabs).toContain("box-shadow: none");
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

  it("retains the established vertical and stacked split behavior", () => {
    const desktop = cssBlock(css, ".workspace-body {");

    expect(desktop).toContain("display: flex");
    expect(css).toMatch(
      /@media \(max-width:\s*1024px\)[\s\S]*?\.workspace-body\s*\{[^}]*flex-direction:\s*column;/u,
    );
    expect(css).toMatch(
      /\.workspace-body\.has-tools > \.chat-workspace\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*220px;/su,
    );
  });
});
