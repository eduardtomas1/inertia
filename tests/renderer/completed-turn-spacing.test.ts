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
    expect(cssBlock("\n.agent-run-flow {"))
      .toContain("margin-bottom: var(--response-block-gap)");
    expect(cssBlock(".turn-working-state {")).toContain("min-height: var(--ledger-row)");
    expect(cssBlock(".turn-changed-files > summary {"))
      .toContain("min-height: var(--ledger-row)");
    expect(cssBlock(".turn-meta-primary {")).toContain("min-height: 28px");
    expect(css).toContain(".turn-action,\n.response-details > summary {\n  min-height: var(--ui-control-height);");
  });

  it("shares one ledger row height that only response density changes", () => {
    expect(cssBlock(":root {")).toContain("--ledger-row: max(28px, calc(var(--ui-control-height) - 6px))");
    expect(cssBlock(".chat-workspace.response-density-compact {")).toContain("--ledger-row: max(26px, calc(var(--ui-control-height) - 8px))");
    expect(cssBlock(".chat-workspace.response-density-comfortable {")).toContain("--ledger-row: max(30px, calc(var(--ui-control-height) - 4px))");
    for (const selector of [
      ".turn-work-log.is-live > details > summary {",
      ".turn-work-log > details.turn-thinking > summary {",
      ".turn-work-log details > summary {",
      ".turn-work-log.is-settled .turn-settled-summary {",
    ]) {
      expect(cssBlock(selector)).toContain("min-height: var(--ledger-row)");
    }
  });
});
