import { describe, expect, it } from "vitest";

import { sourceLanguageForFile } from "../../src/shared/source-language";
import {
  highlightedSourceHtml,
  highlightedSourceLines,
} from "../../src/renderer/src/utils/sourceHighlighting";

describe("source highlighting", () => {
  it("highlights Java and closes multiline spans for navigable lines", () => {
    const code = [
      "public final class Example {",
      "  /* first",
      "     second */",
      "  String value = \"safe\";",
      "}",
    ].join("\n");
    const lines = highlightedSourceLines(
      code,
      sourceLanguageForFile("Example.java"),
    );
    expect(lines).toHaveLength(5);
    expect(lines?.[0]).toContain("hljs-keyword");
    expect(lines?.[1]).toMatch(/<span class="hljs-comment">.*<\/span>$/u);
    expect(lines?.[2]).toMatch(/^<span class="hljs-comment">.*<\/span>/u);
    expect(lines?.[3]).toContain("hljs-string");
  });

  it("keeps highlighted provider text inert and bounds expensive work", () => {
    const java = sourceLanguageForFile("Example.java");
    const html = highlightedSourceHtml(
      'String value = "<script>alert(1)</script>";',
      java,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(highlightedSourceHtml("x".repeat(50_001), java)).toBeNull();
  });
});
