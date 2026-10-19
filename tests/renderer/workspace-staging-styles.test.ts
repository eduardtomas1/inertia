import { describe, expect, it } from "vitest";

import { readSourceText } from "../helpers/source-text";

const css = readSourceText("src/renderer/src/styles.css");

function block(selector: string): string {
  const pattern = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{\\n`, "u");
  const match = pattern.exec(css);
  expect(match, selector).not.toBeNull();
  const start = match!.index + match![0].length;
  return css.slice(start, css.indexOf("\n}", start));
}

describe("changed-file row actions", () => {
  it("positions only the actions cluster, laying Stage/Unstage and Open side by side", () => {
    const cluster = block(".workspace-repository-files .workspace-repository-row-actions");
    expect(cluster).toContain("position: absolute;");
    expect(cluster).toContain("display: flex;");
    expect(block(".workspace-repository-files .workspace-repository-row-actions .icon-button"))
      .toContain("position: static;");
  });

  it("keeps file names at their resting width: the cluster overlays stats only on hover or focus", () => {
    expect(css).not.toMatch(/index-action\)[^{]*workspace-repository-file-stats\s*\{[^}]*min-width/u);
    expect(block(".workspace-repository-files > li:is(:hover, :focus-within) .workspace-repository-file-stats"))
      .toContain("opacity: 0;");
  });

  it("reuses the shared focus ring, inset and above the neighbouring button", () => {
    const focus = block(".workspace-repository-files .workspace-repository-row-actions .icon-button:focus-visible");
    expect(focus).not.toMatch(/outline:/u);
    expect(focus).toContain("outline-offset: -2px;");
    expect(focus).toContain("z-index: 1;");
    expect(block(":focus-visible")).toContain("outline: 2px solid var(--focus-ring);");
  });
});
