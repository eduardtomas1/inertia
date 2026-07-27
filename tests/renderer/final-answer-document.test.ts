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
const identitySource = readFileSync(
  new URL("../../src/renderer/src/utils/finalAnswerIdentity.ts", import.meta.url),
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
      /\.final-answer-identity\s*\{[^}]*color:\s*var\(--metadata-text\);[^}]*font-size:\s*var\(--metadata-font-size\);/su,
    );
    expect(timelineSource).toContain(
      "finalAnswerIdentityLabel(turn.agentTurn.modelSelection)",
    );
    expect(timelineSource).toContain('aria-label="Historical answer identity"');
    expect(timelineSource).toContain(
      'data-identity-source="persisted-model-selection"',
    );
    expect(timelineSource).not.toContain("isKimiThroughClaudeSelection");
    expect(identitySource).toContain("STRUCTURAL_BACKEND_LABELS");
    expect(identitySource).not.toMatch(
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
    expect(css).toMatch(
      /\.turn-final-answer-document\s+\.response-markdown\s+blockquote\s*\{[^}]*border-left-width:\s*2px;[^}]*background:\s*transparent;/su,
    );
    expect(css).toMatch(
      /\.turn-final-answer-document\s+\.response-markdown\s+:not\(pre\)\s*>\s*code\s*\{[^}]*box-decoration-break:\s*clone;/su,
    );
  });

  it("uses semantic themes and a 720–780px editorial column across scale, density, and Linux", () => {
    const root = cssBlock(css, ":root {");
    const compactScale = cssBlock(css, ':root[data-interface-scale="compact"]');
    const comfortableScale = cssBlock(css, ':root[data-interface-scale="comfortable"]');
    const largeScale = cssBlock(css, ':root[data-interface-scale="large"]');
    const compactDensity = cssBlock(css, ".chat-workspace.response-density-compact");
    const comfortableDensity = cssBlock(css, ".chat-workspace.response-density-comfortable");
    const linux = cssBlock(css, ".app-shell.platform-linux");
    const dark = cssBlock(css, ':root[data-theme="dark"]');

    expect(root).toContain("--final-answer-max-width: 760px");
    expect(root).toContain("--final-answer-text: var(--text)");
    expect(root).toContain("--metadata-text: var(--text-muted)");
    expect(compactScale).toContain("--final-answer-max-width: 720px");
    expect(comfortableScale).toContain("--final-answer-max-width: 780px");
    expect(largeScale).toContain("--final-answer-max-width: 780px");
    expect(compactDensity).toContain("--answer-line-height: 1.6");
    expect(comfortableDensity).toContain("--answer-line-height: 1.72");
    expect(linux).toContain("--platform-readability-adjustment: 0.25px");
    expect(dark).toContain("--text:");
    expect(cssBlock(css, ".turn-final-answer-document .response-markdown {"))
      .toContain("color: var(--final-answer-text)");
  });

  it("keeps rich answer content within the readable column at narrow widths", () => {
    const narrow = cssBlock(
      css,
      "@container response-transcript (max-width: 760px)",
    );

    expect(narrow).toContain(".turn-final-answer-document");
    expect(narrow).toContain("max-width: 100%");
    expect(cssBlock(css, ".response-markdown a {")).toContain(
      "overflow-wrap: anywhere",
    );
    expect(cssBlock(css, ".response-markdown img {")).toContain(
      "max-width: 100%",
    );
    expect(cssBlock(css, ".response-code-block {")).toContain(
      "max-width: 100%",
    );
    expect(cssBlock(css, ".response-table-shell {")).toContain(
      "max-width: 100%",
    );
    expect(cssBlock(css, ".response-table-scroll th,")).toContain(
      "overflow-wrap: anywhere",
    );
  });
});
