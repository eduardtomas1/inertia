import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";

const css = readFileSync("src/renderer/src/styles.css", "utf8").replace(/\r\n?/gu, "\n");

function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {\n`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("\n}", start));
}

function render(content: string): string {
  return renderToStaticMarkup(createElement(ResponseMarkdown, {
    content,
    projectRoot: "/workspace",
    projectId: "11111111-1111-4111-8111-111111111111",
    defaultCodeWrap: false,
  }));
}

describe("markdown block chrome", () => {
  it("keeps the code toolbar in its own row above the code instead of over it", () => {
    const header = block(".response-code-block > header");
    expect(header).not.toContain("position: absolute");
    expect(header).toContain("min-height: 28px");
    expect(header).toContain("color: var(--text-faint)");
    expect(block(".response-code-block > header > div")).toContain("opacity: 0");
    expect(css).toContain(".response-code-block:is(:hover, :focus-within) > header > div {\n  opacity: 1;");
    const html = render("```ts\nconst value = 1;\n```");
    expect(html.indexOf("<header")).toBeLessThan(html.indexOf("<pre"));
  });

  it("puts the table actions in a reserved row below the table", () => {
    const toolbar = block(".response-table-toolbar");
    expect(toolbar).not.toContain("position: absolute");
    expect(toolbar).toContain("min-height: 24px");
    expect(toolbar).toContain("opacity: 0");
    expect(css).toContain(".response-table-shell:is(:hover, :focus-within) > .response-table-toolbar {\n  opacity: 1;");
    const html = render("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(html.indexOf('class="response-table-toolbar"'))
      .toBeGreaterThan(html.indexOf("</table>"));
    expect(html).not.toContain("<span>Table</span>");
  });
});
