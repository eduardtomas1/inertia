import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");

function cssBlock(marker: string): string {
  const markerIndex = css.indexOf(marker);
  expect(markerIndex, `${marker} should exist`).toBeGreaterThanOrEqual(0);
  const openIndex = css.indexOf("{", markerIndex);
  let depth = 0;
  for (let index = openIndex; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Unclosed CSS block for ${marker}`);
}

describe("completed-turn spacing", () => {
  it("does not shrink active work or interactive disclosure targets", () => {
    expect(cssBlock(".agent-run-flow {"))
      .toContain("margin-bottom: var(--response-block-gap)");
    expect(cssBlock(".turn-working-state {")).toContain("min-height: 28px");
    expect(cssBlock(".turn-changed-files > summary {"))
      .toContain("min-height: 32px");
    expect(cssBlock(".turn-meta-primary {")).toContain("min-height: 28px");
    expect(css).toContain(
      ".turn-action,\n.timeline-follow-controls button,\n.turn-changed-files > summary,",
    );
    expect(css).toContain("min-height: var(--ui-control-height)");
  });
});
