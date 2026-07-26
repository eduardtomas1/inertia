import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const timelineSource = readFileSync(
  new URL("../../src/renderer/src/components/ResponseTimeline.tsx", import.meta.url),
  "utf8",
);

describe("final answer document presentation", () => {
  it("uses the shared editorial width and type tokens without a card surface", () => {
    expect(css).toMatch(
      /\.response-turn\s*>\s*\.turn-final-answer-document\s*\{[^}]*max-width:\s*var\(--answer-max-width\);[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/su,
    );
    expect(css).toMatch(
      /\.turn-final-answer-document\s+\.response-markdown\s*\{[^}]*font-size:\s*var\(--answer-font-size\);[^}]*line-height:\s*var\(--answer-line-height\);/su,
    );
    expect(css).toMatch(
      /\.response-turn\s*\{[^}]*max-width:\s*var\(--transcript-max-width\);/su,
    );
  });

  it("keeps the historical identity secondary and independent of Kimi display-name matching", () => {
    expect(css).toMatch(
      /\.final-answer-identity\s*\{[^}]*color:\s*var\(--quiet-secondary\);[^}]*font-size:\s*var\(--metadata-font-size\);/su,
    );
    expect(timelineSource).toContain(
      "finalAnswerIdentityLabel(turn.agentTurn.modelSelection)",
    );
    expect(timelineSource).not.toContain("isKimiThroughClaudeSelection");
    expect(timelineSource).not.toMatch(
      /backendProfileDisplayName\s*===\s*["']Kimi["']/u,
    );
  });

  it("provides editorial spacing for headings, lists, quotes, code, and tables", () => {
    expect(css).toContain(".turn-final-answer-document .response-markdown h1");
    expect(css).toContain(".turn-final-answer-document .response-markdown ul");
    expect(css).toContain(".turn-final-answer-document .response-markdown blockquote");
    expect(css).toContain(".turn-final-answer-document .response-markdown .response-code-block");
    expect(css).toContain(".turn-final-answer-document .response-markdown .response-table-shell");
    expect(css).toMatch(/\.response-markdown\s+ul\s*\{[^}]*list-style:\s*disc outside;/su);
    expect(css).toMatch(/\.response-markdown\s+ol\s*\{[^}]*list-style:\s*decimal outside;/su);
  });
});
