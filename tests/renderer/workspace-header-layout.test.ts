import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");

function cssBlock(marker: string): string {
  const markerIndex = css.indexOf(marker);
  if (markerIndex < 0) return "";
  const openIndex = css.indexOf("{", markerIndex);
  const closeIndex = css.indexOf("}", openIndex);
  return css.slice(openIndex + 1, closeIndex);
}

describe("workspace header layout", () => {
  it("measures the header as its own container so labels follow its width", () => {
    const header = cssBlock("\n.workspace-header {\n");
    expect(header).toContain("container: workspace-header / inline-size");
    expect(header).toContain("height: 52px");
    expect(header).toContain("padding: 0 calc(14px + var(--workspace-corner-controls-width, 0px)) 0 12px");
  });

  it("shows split-button labels only when the header is at least 680px wide", () => {
    expect(cssBlock("\n.header-split-label {\n")).toContain("display: none");
    expect(css).toMatch(
      /@container workspace-header \(min-width: 680px\)\s*\{\s*\.header-split-label\s*\{\s*display:\s*inline;/u,
    );
  });

  it("pins the panel toggles to the window corner above the right panel", () => {
    const corner = cssBlock("\n.workspace-corner-controls {\n");
    expect(corner).toContain("position: absolute");
    expect(corner).toContain("right:");
    expect(cssBlock("\n.workspace-panel-tabs {\n"))
      .toContain("padding: 0 calc(var(--workspace-corner-controls-width, 0px) + 16px) 0 10px");
  });
});
