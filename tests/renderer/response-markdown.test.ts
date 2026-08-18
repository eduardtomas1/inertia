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
    expect(html).toContain('<h1 id="user-content-result">Result</h1>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<span>Markdown</span>");
    expect(html).toContain("<span>CSV</span>");
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
    expect(resolveResponseLink("/work/project", "src/app.ts#L4")).toEqual({ kind: "project", relativePath: "src/app.ts", action: "reveal", location: { startLine: 4, endLine: 4 } });
    expect(resolveResponseLink("/work/project", "/work/project/src/app.ts#L4-L7")).toEqual({ kind: "project", relativePath: "src/app.ts", action: "reveal", location: { startLine: 4, endLine: 7 } });
    expect(resolveResponseLink("/work/project", "app.ts:42")).toEqual({ kind: "project", relativePath: "app.ts:42", action: "reveal" });
    expect(resolveResponseLink("/work/project", "src/app.ts:42:7")).toEqual({ kind: "project", relativePath: "src/app.ts:42:7", action: "reveal" });
    expect(resolveResponseLink("/work/project", "README:42")).toEqual({ kind: "project", relativePath: "README:42", action: "reveal" });
    expect(resolveResponseLink("/work/project", "src/Service%23L12")).toEqual({ kind: "project", relativePath: "src/Service#L12", action: "reveal", literalPath: true });
    expect(resolveResponseLink("/work/project", "src/Service.java%3A42")).toEqual({ kind: "project", relativePath: "src/Service.java:42", action: "reveal", literalPath: true });
    expect(resolveResponseLink("/work/project", "src/why%3F.java")).toEqual({ kind: "project", relativePath: "src/why?.java", action: "reveal", literalPath: true });
    expect(resolveResponseLink("/work/project", "src/why%3F.java:42")).toEqual({ kind: "project", relativePath: "src/why?.java", action: "reveal", location: { startLine: 42, endLine: 42 }, literalPath: true });
    expect(resolveResponseLink("/work/project", "src/hash%23part.java:8")).toEqual({ kind: "project", relativePath: "src/hash#part.java", action: "reveal", location: { startLine: 8, endLine: 8 }, literalPath: true });
    expect(resolveResponseLink("/work/project", "src/name%3A42:7")).toEqual({ kind: "project", relativePath: "src/name:42", action: "reveal", location: { startLine: 7, endLine: 7 }, literalPath: true });
    expect(resolveResponseLink("/work/project", "../secret.txt")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "%2e%2e/%2e%2e/secret.txt")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "src/%00secret.txt")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "file:///etc/passwd")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "file:///etc/passwd:42")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "javascript:alert(1)")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "https://example.com/docs")).toMatchObject({ kind: "external" });
    expect(resolveResponseLink(
      "/work/project",
      "../guide.md#L4",
      "markdown",
      "docs/reference",
    )).toEqual({
      kind: "project",
      relativePath: "docs/guide.md",
      action: "reveal",
      location: { startLine: 4, endLine: 4 },
    });
    expect(resolveResponseLink(
      "/work/project",
      "../../../secret.txt",
      "markdown",
      "docs/reference",
    )).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink(
      "/work/project",
      "../guide.md#overview",
      "markdown",
      "docs/reference",
    )).toEqual({
      kind: "project",
      relativePath: "docs/guide.md",
      action: "reveal",
      headingId: "overview",
    });
  });

  it("creates stable GitHub-compatible duplicate and Unicode heading ids", () => {
    const html = render([
      "# Foo",
      "# Foo",
      "# Foo-1",
      "# Привет non-latin 你好",
      "# 😄 emoji",
      "# root",
      "# workspace-content",
    ].join("\n"));
    expect(html).toContain('<h1 id="user-content-foo">Foo</h1>');
    expect(html).toContain('<h1 id="user-content-foo-1">Foo</h1>');
    expect(html).toContain('<h1 id="user-content-foo-1-1">Foo-1</h1>');
    expect(html).toContain('<h1 id="user-content-привет-non-latin-你好">');
    expect(html).toContain('<h1 id="user-content-😄-emoji">');
    expect(html).toContain('<h1 id="user-content-root">root</h1>');
    expect(html).toContain(
      '<h1 id="user-content-workspace-content">workspace-content</h1>',
    );
    expect(render('<h2 id="__proto__">Raw heading</h2>'))
      .toContain('<h2 id="user-content-raw-heading">Raw heading</h2>');
  });

  it("does not assign workspace image resources before client admission", () => {
    const html = renderToStaticMarkup(createElement(ResponseMarkdown, {
      content: "![Architecture](<./assets/diagram one.png>)\n\n![](../outside.png)",
      projectRoot: "/work/project",
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      markdownBasePath: "docs",
      defaultCodeWrap: false,
    }));
    expect(html).not.toContain("inertia://bundle/workspace-image/");
    expect(html).not.toContain("<img");
    expect(html).toContain('data-markdown-image-state="waiting"');
    expect(html).toContain('aria-label="Architecture"');
    expect(html).toContain("Architecture (image waiting to load)");
    expect(html).toContain('aria-hidden="true"');
  });

  it("never emits inline image data outside the guarded resource path", () => {
    const html = render("![Inline](data:image/png;base64,iVBORw0KGgo=)");
    expect(html).not.toContain("data:image/");
    expect(html).not.toContain("<img");
    expect(html).toContain('aria-label="Inline"');
    expect(html).toContain("Inline (image unavailable)");
  });

  it("keeps highlighted code as inert text", () => {
    const html = render([
      "```html",
      '<script>alert("no")</script><img src=x onerror=alert(1)>',
      "```",
    ].join("\n"));
    expect(html).toContain("hljs");
    expect(html).toContain("&lt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });

  it("infers Java highlighting and a restrained language family from a real file", () => {
    const html = render([
      "```text file=src/main/OrderService.java",
      "public final class OrderService {",
      "  private String state = \"ready\";",
      "}",
      "```",
    ].join("\n"));
    expect(html).toContain('data-language-family="java"');
    expect(html).toContain("language-java");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-string");

    const mismatchedFence = render([
      "```python file=src/main/OrderService.java",
      "public final class OrderService {}",
      "```",
    ].join("\n"));
    expect(mismatchedFence).toContain('data-language-family="java"');
    expect(mismatchedFence).toContain("language-java");

    const unsupportedFileGrammar = render([
      "```typescript file=src/main/Main.kt",
      'fun main() = println("hello")',
      "```",
    ].join("\n"));
    expect(unsupportedFileGrammar).toContain('data-language-family="java"');
    expect(unsupportedFileGrammar).toContain("language-kotlin");
    expect(unsupportedFileGrammar).not.toContain("language-typescript");
    expect(unsupportedFileGrammar).not.toContain('class="hljs');
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
    expect(html).toContain('aria-label="A constrained result preview"');
    expect(html).toContain("A constrained result preview (image unavailable)");
    expect(html).not.toContain('<img src="https://example.com/result.png"');
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

  it("mounts streamed words and inline citations on the exact motion hooks", () => {
    const streaming = render("Pistachio is [growing](https://example.com/source) quickly.", true);
    expect(streaming.match(/class="response-stream-word"/gu)).toHaveLength(3);
    expect(streaming).toContain('href="https://example.com/source"');

    const settled = render("Pistachio is growing quickly.");
    expect(settled).not.toContain("response-stream-word");
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

  it("neutralizes spreadsheet formulas in provider-authored CSV cells", () => {
    expect(tableAsCsv([[
      "=SUM(1,2)",
      "+cmd",
      " -2",
      "@lookup",
      "\t=hidden",
      "ordinary",
    ]])).toBe(`"'=SUM(1,2)",'+cmd,' -2,'@lookup,'\t=hidden,ordinary`);
  });

  it("normalizes Windows paths case-insensitively without allowing traversal", () => {
    expect(resolveResponseLink("C:\\Work Space\\Project", "src\\index.ts")).toEqual({ kind: "project", relativePath: "src/index.ts", action: "reveal" });
    expect(resolveResponseLink("C:\\Work Space\\Project", "C:\\Work Space\\Project\\src\\index.ts:42:7")).toEqual({ kind: "project", relativePath: "src/index.ts:42:7", action: "reveal" });
    expect(resolveResponseLink("C:\\Work Space\\Project", "C%3A%5CWork%20Space%5CProject%5Csrc%5Cindex.ts:42:7")).toEqual({ kind: "project", relativePath: "src/index.ts", action: "reveal", location: { startLine: 42, startColumn: 7, endLine: 42 } });
    expect(resolveResponseLink("C:\\Work Space\\Project", "C%3A%5CWork%20Space%5CProject%5Csrc%5Cindex.ts%3A42")).toEqual({ kind: "project", relativePath: "src/index.ts:42", action: "reveal", literalPath: true });
    expect(resolveResponseLink("C:\\Work Space\\Project", "..\\Elsewhere\\secret.ts")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("\\\\Server\\Share\\Project", "\\\\server\\share\\project\\src/App.java#L4")).toEqual({ kind: "project", relativePath: "src/App.java", action: "reveal", location: { startLine: 4, endLine: 4 } });
    expect(resolveResponseLink("\\\\Server\\Share\\Project", "//server/other/project/src/App.java#L4")).toEqual({ kind: "unsafe" });
  });

  it("treats code-file metadata as a project path instead of a URL", () => {
    const html = render([
      '```java file="src/why?.java"',
      "class Question {}",
      "```",
      "",
      '```java file="src/hash#part.java"',
      "class Hash {}",
      "```",
      "",
      '```java file="Name:Part.java"',
      "class Colon {}",
      "```",
    ].join("\n"));
    expect(html).toContain("src/why?.java");
    expect(html).toContain("src/hash#part.java");
    expect(html).toContain('title="src/why?.java"');
    expect(html).toContain('title="src/hash#part.java"');
    expect(html).toContain('title="Name:Part.java"');
    expect(resolveResponseLink(
      "/work/project",
      "src/why?.java",
      "file",
    )).toEqual({
      kind: "project",
      relativePath: "src/why?.java",
      action: "reveal",
    });
    expect(resolveResponseLink(
      "/work/project",
      "src/hash#part.java#L7",
      "file",
    )).toEqual({
      kind: "project",
      relativePath: "src/hash#part.java",
      action: "reveal",
      location: { startLine: 7, endLine: 7 },
    });
    expect(resolveResponseLink(
      "/work/project",
      "Name:Part.java",
      "file",
    )).toEqual({
      kind: "project",
      relativePath: "Name:Part.java",
      action: "reveal",
    });
  });
});
