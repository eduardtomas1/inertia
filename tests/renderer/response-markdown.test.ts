import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ResponseMarkdown,
  resolveResponseLink,
  stabilizeStreamingMarkdown,
  tableAsCsv,
  tableAsMarkdown,
} from "../../src/renderer/src/components/ResponseMarkdown";

function render(content: string, streaming = false): string {
  return renderToStaticMarkup(createElement(ResponseMarkdown, {
    content,
    projectRoot: "/work/project",
    projectId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    defaultCodeWrap: false,
    streaming,
  }));
}

describe("response Markdown", () => {
  it("renders GFM and safe interactive code and table controls", () => {
    const html = render([
      "# Result",
      "",
      "- [x] Safe",
      "- [ ] Review",
      "",
      "| File | State |",
      "| --- | --- |",
      "| `src/app.ts` | changed |",
      "",
      "```ts file=src/app.ts",
      "const answer: number = 42;",
      "```",
      "",
      "<details><summary>More</summary><p>Calm detail.</p></details>",
    ].join("\n"));
    expect(html).toContain("<h1>Result</h1>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Markdown</button>");
    expect(html).toContain("CSV</button>");
    expect(html).toContain("Copy</span>");
    expect(html).toContain("Wrap</span>");
    expect(html).toContain("src/app.ts");
    expect(html).toContain("hljs");
    expect(html).toContain("<details");
  });

  it("sanitizes raw HTML and blocks unsafe or escaping links", () => {
    const html = render('<script>alert("no")</script><img src="x" onerror="alert(1)"><iframe src="https://bad.invalid"></iframe>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<iframe");
    expect(resolveResponseLink("/work/project", "src/app.ts#L4")).toEqual({ kind: "project", relativePath: "src/app.ts", action: "reveal" });
    expect(resolveResponseLink("/work/project", "/work/project/src/app.ts#L4")).toEqual({ kind: "project", relativePath: "src/app.ts", action: "reveal" });
    expect(resolveResponseLink("/work/project", "../secret.txt")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "%2e%2e/%2e%2e/secret.txt")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "src/%00secret.txt")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "file:///etc/passwd")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "javascript:alert(1)")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "https://example.com/docs")).toMatchObject({ kind: "external" });
  });

  it("renders editorial quote, inline code, image, and long-link semantics without weakening sanitization", () => {
    const html = render([
      "> Persisted identity remains authoritative.",
      "",
      "Use `ModelSelection` and [the structural backend route](https://example.com/a/very/long/editorial/path/that/must/wrap).",
      "",
      "![A constrained result preview](https://example.com/result.png)",
    ].join("\n"));

    expect(html).toContain("<blockquote>");
    expect(html).toContain("<code>ModelSelection</code>");
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('alt="A constrained result preview"');
    expect(html).not.toContain("javascript:");
  });

  it("keeps unfinished streaming fences structurally stable and uses plain-code fallback", () => {
    const content = "Before\n\n```futurelang\nsome <unsafe> code";
    expect(stabilizeStreamingMarkdown(content)).toBe(`${content}\n\`\`\``);
    const html = render(content, true);
    expect(html).toContain("response-code-block");
    expect(html).toContain("some &lt;unsafe&gt; code");
    expect(html).not.toContain("hljs");
  });

  it("copies tables as valid Markdown or CSV", () => {
    const rows = [["Name", "Note"], ["One", "a | b"], ["Two", "line\nbreak"], ["Three", 'say "hi"']];
    expect(tableAsMarkdown(rows)).toBe([
      "| Name | Note |",
      "| --- | --- |",
      "| One | a \\| b |",
      "| Two | line<br>break |",
      '| Three | say "hi" |',
    ].join("\n"));
    expect(tableAsCsv(rows)).toBe([
      "Name,Note",
      "One,a | b",
      'Two,"line',
      'break"',
      'Three,"say ""hi"""',
    ].join("\n"));
  });

  it("normalizes Windows paths case-insensitively without allowing traversal", () => {
    expect(resolveResponseLink("C:\\Work Space\\Project", "src\\index.ts")).toEqual({ kind: "project", relativePath: "src/index.ts", action: "reveal" });
    expect(resolveResponseLink("C:\\Work Space\\Project", "..\\Elsewhere\\secret.ts")).toEqual({ kind: "unsafe" });
  });
});
