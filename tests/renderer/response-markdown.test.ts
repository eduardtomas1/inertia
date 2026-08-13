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
    expect(resolveResponseLink("/work/project", "src/app.ts#L4")).toEqual({ kind: "project", relativePath: "src/app.ts", fileReference: "src/app.ts#L4", action: "reveal" });
    expect(resolveResponseLink("/work/project", "/work/project/src/app.ts#L4")).toEqual({ kind: "project", relativePath: "src/app.ts", fileReference: "src/app.ts#L4", action: "reveal" });
    expect(resolveResponseLink("/work/project", "app.ts:42")).toEqual({ kind: "project", relativePath: "app.ts", fileReference: "app.ts:42", action: "reveal" });
    expect(resolveResponseLink("/work/project", "src/app.ts:42:7")).toEqual({ kind: "project", relativePath: "src/app.ts", fileReference: "src/app.ts:42:7", action: "reveal" });
    expect(resolveResponseLink("/work/project", "Dockerfile:42")).toEqual({ kind: "project", relativePath: "Dockerfile", fileReference: "Dockerfile:42", action: "reveal" });
    expect(resolveResponseLink("/work/project", "src/Service%23L12")).toEqual({ kind: "project", relativePath: "src/Service#L12", action: "reveal" });
    expect(resolveResponseLink("/work/project", "src/Service%23L12.java")).toEqual({ kind: "project", relativePath: "src/Service#L12.java", action: "reveal" });
    expect(resolveResponseLink("/work/project", "src/Service.java%3A42")).toEqual({ kind: "project", relativePath: "src/Service.java:42", action: "reveal" });
    expect(resolveResponseLink("/work/project", "../secret.txt")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "%2e%2e/%2e%2e/secret.txt")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "src/%00secret.txt")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "file:///etc/passwd")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "file:///etc/passwd:42")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "javascript:alert(1)")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink("/work/project", "https://example.com/docs")).toMatchObject({ kind: "external" });
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

  it("recognizes Java file links and fenced code without trusting extra metadata", () => {
    const html = render([
      "Open [the service](src/main/java/example/Service.java#L2-L4).",
      "",
      "```java file=src/main/java/example/Service.java",
      "public final class Service {",
      "  private final int value = 42;",
      "}",
      "```",
    ].join("\n"));

    expect(html).toContain('class="response-project-file-link"');
    expect(html.match(/data-language="java"/gu)).toHaveLength(2);
    expect(html.match(/data-language-accent="amber"/gu)).toHaveLength(2);
    expect(html).toContain('class="hljs language-java"');
    expect(html).toContain('class="hljs-keyword"');
  });

  it("renders absolute in-project references with project-relative labels", () => {
    const html = render([
      "Open [the service](/work/project/src/Service.java#L2).",
      "",
      "```java file=/work/project/src/Service.java",
      "public final class Service {}",
      "```",
    ].join("\n"));

    expect(html).not.toContain("/work/project");
    expect(html).toContain('href="src/Service.java#L2"');
    expect(html).toContain("src/Service.java");
  });

  it("derives fenced highlighting from a safe file extension instead of a generic label", () => {
    const html = render([
      "```text file=src/Service.java",
      "public final class Service {}",
      "```",
    ].join("\n"));

    expect(html).toContain('data-language="java"');
    expect(html).toContain('class="hljs language-java"');
    expect(html).toContain('<span class="hljs-keyword">public</span>');
  });

  it("does not borrow a conflicting fence grammar for a recognized file", () => {
    const html = render([
      "```typescript file=src/Main.kt",
      "fun main() = println(\"hello\")",
      "```",
    ].join("\n"));

    expect(html).toContain('data-language="kotlin"');
    expect(html).not.toContain("language-typescript");
    expect(html).not.toContain('class="hljs');
  });

  it("keeps extensionless source references as safe project links", () => {
    const html = render("Open [the build image](Dockerfile:42).");

    expect(html).toContain('href="Dockerfile:42"');
    expect(html).toContain('data-language="dockerfile"');
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
    expect(resolveResponseLink("C:\\Work Space\\Project", "C:\\Work Space\\Project\\src\\index.ts:42:7")).toEqual({ kind: "project", relativePath: "src/index.ts", fileReference: "src/index.ts:42:7", action: "reveal" });
    expect(resolveResponseLink("C:\\Work Space\\Project", "..\\Elsewhere\\secret.ts")).toEqual({ kind: "unsafe" });
    expect(resolveResponseLink(
      "\\\\Server\\Share\\Project",
      "\\\\server\\share\\project\\src\\Main.java#L2",
    )).toEqual({
      kind: "project",
      relativePath: "src/Main.java",
      fileReference: "src/Main.java#L2",
      action: "reveal",
    });
    expect(resolveResponseLink(
      "\\\\Server\\Share\\Project",
      "\\\\Server\\Share\\Elsewhere\\secret.ts#L2",
    )).toEqual({ kind: "unsafe" });
  });
});
