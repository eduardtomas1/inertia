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

describe("transcript and composer composition", () => {
  it("keeps the dock optically aligned with the editorial column at every scale", () => {
    const root = cssBlock(css, ":root {");
    const compact = cssBlock(css, ':root[data-interface-scale="compact"]');
    const comfortable = cssBlock(
      css,
      ':root[data-interface-scale="comfortable"]',
    );
    const large = cssBlock(css, ':root[data-interface-scale="large"]');

    expect(root).toContain("--final-answer-max-width: 760px");
    expect(root).toContain("--composer-max-width: 780px");
    expect(compact).toContain("--final-answer-max-width: 720px");
    expect(compact).toContain("--composer-max-width: 740px");
    expect(comfortable).toContain("--final-answer-max-width: 780px");
    expect(comfortable).toContain("--composer-max-width: 800px");
    expect(large).toContain("--final-answer-max-width: 780px");
    expect(large).toContain("--composer-max-width: 800px");
  });

  it("uses one editorial axis from work through answer, metadata, and changed files", () => {
    for (const marker of [
      ".turn-execution-rail.is-live {",
      ".turn-execution-rail.is-settled {",
      ".response-turn > .turn-final-answer-document {",
      ".turn-meta {",
      ".turn-changed-files {",
    ]) {
      const block = cssBlock(css, marker);
      expect(block, marker).toContain("max-width: var(--answer-max-width)");
      expect(block, marker).toMatch(/margin(?:-right)?:\s*[^;]*auto/u);
    }

    expect(cssBlock(css, ".agent-run-flow > .agent-request-card {"))
      .toContain("max-width: var(--answer-max-width)");
  });

  it("keeps the dock distinct without a glossy shadow or dominant accent halo", () => {
    const root = cssBlock(css, ":root {");
    const focus = cssBlock(css, ".composer:focus-within {");

    expect(root).toContain("--composer-border: var(--interactive-border)");
    expect(root).toContain("--radius-composer: 12px");
    expect(root).toContain("0 8px 24px -22px");
    expect(root).toContain("0 1px 4px -3px");
    expect(focus).toContain("var(--interactive-border-hover)");
    expect(focus).toContain("0 0 0 2px");
    expect(focus).toContain("var(--focus-ring-soft)");
    expect(focus).not.toContain("0 0 0 3px");
  });
});
