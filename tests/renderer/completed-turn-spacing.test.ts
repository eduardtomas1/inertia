import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { estimateCompletedTurnSpacing } from "../../src/renderer/src/utils/responseTimeline";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

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
  it("uses one density-aware semantic spacing family", () => {
    expect(estimateCompletedTurnSpacing("compact")).toEqual({
      layer: 10,
      footer: 6,
      artifact: 1,
    });
    expect(estimateCompletedTurnSpacing("default")).toEqual({
      layer: 12,
      footer: 8,
      artifact: 2,
    });
    expect(estimateCompletedTurnSpacing("comfortable")).toEqual({
      layer: 15,
      footer: 10,
      artifact: 3,
    });

    const root = cssBlock(":root {");
    expect(root).toContain("--settled-layer-spacing: 12px");
    expect(root).toContain("--settled-footer-spacing: 8px");
    expect(root).toContain("--settled-artifact-spacing: 2px");
  });

  it("removes only duplicate settled gaps and keeps inter-turn separation intact", () => {
    expect(cssBlock(
      ".response-turn:not(.is-active) > .turn-user-request {",
    )).toContain("margin-bottom: var(--settled-layer-spacing)");
    expect(cssBlock(
      ".response-turn:not(.is-active) > .agent-run-flow:not(.is-quiet-settled) {",
    )).toContain("margin-bottom: var(--settled-layer-spacing)");
    expect(cssBlock(
      ".response-turn:not(.is-active) > .turn-final-answer-document {",
    )).toContain("margin-bottom: 0");
    expect(cssBlock(
      ".turn-final-answer-document .response-markdown > :last-child {",
    )).toContain("margin-bottom: 0");
    expect(cssBlock(".turn-meta {"))
      .toContain("margin: var(--settled-footer-spacing) auto 0");
    expect(cssBlock(".turn-changed-files {"))
      .toContain("margin-top: var(--settled-artifact-spacing)");

    expect(cssBlock("\n.response-turn {"))
      .toContain("margin: 0 auto var(--response-turn-gap)");
    expect(cssBlock(".response-virtual-item {"))
      .toContain("padding-bottom: var(--response-turn-gap)");
  });

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
