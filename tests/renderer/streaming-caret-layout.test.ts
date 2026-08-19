import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "gu"))]
    .map((match) => match[1] ?? "")
    .join("\n");
}

describe("streaming caret layout", () => {
  it("attaches the live caret to the final rendered Markdown block", () => {
    const declarations = rule(
      ".response-markdown.is-streaming > .response-table-shell:last-child tbody tr:last-child > :last-child::after",
    );
    expect(declarations).toContain('content: ""');
    expect(declarations).toContain("margin-left: 4px");
    expect(declarations).not.toMatch(
      /(?:^|\n)\s*position\s*:\s*absolute/u,
    );
    expect(css).toContain(
      ".response-markdown.is-streaming > .response-code-block:last-child pre code::after",
    );
    expect(css).toMatch(
      /data-document-visible="false"[\s\S]*?response-markdown\.is-streaming[\s\S]*?animation-play-state:\s*paused/u,
    );
    expect(css).not.toContain(
      ".response-markdown.is-streaming > :last-child::after",
    );
  });
});
