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

describe("Quiet Ledger responsive transcript", () => {
  it("responds to split-panel width and prevents transcript-level horizontal scrolling", () => {
    const chat = cssBlock(css, "\n.chat-workspace {");
    const transcript = cssBlock(css, ".message-scroll {");
    const split = cssBlock(
      css,
      "@container conversation-workspace (max-width: 1040px)",
    );
    const narrowSplit = cssBlock(
      css,
      "@container conversation-workspace (max-width: 720px)",
    );
    const boundedChooser = cssBlock(
      css,
      "@container conversation-workspace (min-height: 0px)",
    );
    const stackedChooser = cssBlock(
      css,
      "@media (max-width: 1024px) {\n  @container conversation-workspace",
    );

    expect(chat).toContain("container-name: conversation-workspace");
    expect(chat).toContain("container-type: size");
    expect(transcript).toContain("overflow-x: hidden");
    expect(split).toMatch(/\.message-scroll\s*\{[^}]*clamp\(20px,\s*4cqi,\s*40px\)/su);
    expect(narrowSplit).toMatch(/\.message-scroll\s*\{[^}]*clamp\(12px,\s*3cqi,\s*18px\)/su);
    expect(boundedChooser).toMatch(
      /\.model-chooser-palette\s*\{[^}]*height:\s*min\(430px,[^;]*100cqh - 84px[^;]*\);[^}]*min-height:\s*min\(310px,[^;]*100cqh - 84px/su,
    );
    expect(stackedChooser).toMatch(
      /\.workspace-body\.has-tools \.model-chooser-palette\s*\{[^}]*height:\s*min\(390px,[^;]*100cqh - 84px[^;]*\);[^}]*min-height:\s*min\(280px,[^;]*100cqh - 84px/su,
    );
  });

  it("uses the full readable column at narrow transcript widths", () => {
    const narrow = cssBlock(
      css,
      "@container response-transcript (max-width: 760px)",
    );

    expect(narrow).toMatch(
      /\.response-turn,[\s\S]*?\.orphan-run-flow\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/u,
    );
    expect(narrow).toContain(".turn-final-answer-document");
    expect(narrow).toContain(".turn-execution-rail");
    expect(narrow).toContain(".agent-run-flow > .agent-request-card");
  });

  it("keeps the execution header on one line at medium transcript widths", () => {
    const compact = cssBlock(
      css,
      "@container response-transcript (max-width: 620px)",
    );
    const detail = cssBlock(compact, ".turn-working-copy small");
    const stop = cssBlock(compact, ".turn-stop-action");

    expect(compact).toContain("--user-request-max-width: 92%");
    expect(detail).toContain("display: none");
    expect(stop).toContain("flex: 0 0 auto");
  });

  it("stacks technical metadata and preserves readable activity at the smallest layout", () => {
    const compact = cssBlock(
      css,
      "@container response-transcript (max-width: 440px)",
    );
    const details = cssBlock(compact, ".turn-run-details > div");
    const elapsed = cssBlock(compact, ".turn-working-elapsed");
    const activity = cssBlock(
      css,
      ".turn-work-log .agent-activity-target,",
    );
    const requestCard = cssBlock(css, "@container (max-width: 420px)");

    expect(compact).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(elapsed).toContain("grid-row: 2");
    expect(compact).toMatch(/\.turn-working-separator\s*\{[^}]*display:\s*none;/su);
    expect(details).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(activity).toContain("text-overflow: ellipsis");
    expect(activity).toContain("white-space: nowrap");
    expect(requestCard).toMatch(
      /\.agent-request-actions\s*\{[^}]*display:\s*grid;[^}]*minmax\(110px,\s*1fr\)/su,
    );
  });
});
