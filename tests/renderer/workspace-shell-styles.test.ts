import { describe, expect, it } from "vitest";

import { readSourceText } from "../helpers/source-text";

const css = readSourceText("src/renderer/src/styles.css");

function block(selector: string, source = css): string {
  const start = source.indexOf(`\n${selector} {\n`);
  expect(start, selector).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}", start + 1));
}

describe("workspace panel launcher", () => {
  it("hovers on --fill, highlights on --fill-strong and dims unavailable rows to the shared opacity", () => {
    expect(block(".workspace-panel-launcher-list > button:hover")).toContain("background: var(--fill);");
    expect(block(".workspace-panel-launcher-list > button.is-highlighted")).toContain("background: var(--fill-strong);");
    expect(block(".workspace-panel-launcher-list > .is-unavailable")).toContain("opacity: var(--disabled-opacity);");
  });

  it("keeps menu hints and loading lines in muted text, not the warning colour", () => {
    const hint = block(".header-menu-hint-text");
    expect(hint).toContain("color: var(--text-muted);");
    expect(hint).not.toContain("--warning");
  });
});
