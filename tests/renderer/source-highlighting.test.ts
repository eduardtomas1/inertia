import hljs from "highlight.js/lib/core";
import { describe, expect, it, vi } from "vitest";

import { sourceLanguageForFile } from "../../src/shared/source-language";
import { createBoundedCache } from "../../src/renderer/src/utils/boundedCache";
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

  it("reuses highlighted HTML when the same source is shown again", () => {
    const typescript = sourceLanguageForFile("example.ts");
    const json = sourceLanguageForFile("example.json");
    const code = "const reusedHighlight = { value: 1 };";
    const highlight = vi.spyOn(hljs, "highlight");
    try {
      const first = highlightedSourceHtml(code, typescript);
      const second = highlightedSourceHtml(code, typescript);
      expect(second).toBe(first);
      expect(highlight).toHaveBeenCalledTimes(1);

      highlightedSourceHtml(code, json);
      expect(highlight).toHaveBeenCalledTimes(2);
      expect(highlightedSourceHtml(code, typescript, false)).toBeNull();
      expect(highlight).toHaveBeenCalledTimes(2);
    } finally {
      highlight.mockRestore();
    }
  });
});

describe("bounded cache", () => {
  it("evicts the least recently used entry beyond its entry limit", () => {
    const cache = createBoundedCache<string>(2, 100, () => 1);
    cache.set("a", "first");
    cache.set("b", "second");
    expect(cache.get("a")).toBe("first");
    cache.set("c", "third");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("first");
    expect(cache.get("c")).toBe("third");
  });

  it("evicts old entries to stay within its weight limit and skips oversized values", () => {
    const cache = createBoundedCache<string>(10, 10, (_key, value) => value.length);
    cache.set("a", "aaaa");
    cache.set("b", "bbbb");
    cache.set("c", "cccc");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("bbbb");

    cache.set("d", "d".repeat(11));
    expect(cache.get("d")).toBeUndefined();
    expect(cache.get("c")).toBe("cccc");
  });

  it("replaces an entry without double counting its weight", () => {
    const cache = createBoundedCache<string>(10, 8, (_key, value) => value.length);
    cache.set("a", "aaaa");
    cache.set("a", "AAAA");
    cache.set("b", "bbbb");

    expect(cache.get("a")).toBe("AAAA");
    expect(cache.get("b")).toBe("bbbb");
  });

  it("keeps cached null values distinguishable from misses", () => {
    const cache = createBoundedCache<string | null>(2, 10, () => 1);
    cache.set("unhighlightable", null);

    expect(cache.get("unhighlightable")).toBeNull();
    expect(cache.get("missing")).toBeUndefined();
  });
});
