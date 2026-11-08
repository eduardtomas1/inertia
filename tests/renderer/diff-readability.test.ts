import { describe, expect, it } from "vitest";

import type { DiffFile, DiffHunk, DiffLine } from "../../src/shared/contracts";
import { sourceLanguageForFile } from "../../src/shared/source-language";
import {
  DIFF_HIGHLIGHT_MAX_FILE_LINES,
  DIFF_HIGHLIGHT_MAX_LINE_CHARS,
  INTRALINE_MAX_FILE_CELLS,
  diffFileHighlightable,
  diffFileRenders,
  diffHunkRender,
  intralineSegments,
  markedHighlightHtml,
} from "../../src/renderer/src/utils/diffHighlighting";
import {
  INTRALINE_MAX_BLOCK_LINES,
  INTRALINE_MAX_HUNK_CELLS,
  INTRALINE_MAX_LINE_CHARS,
  intralineHunkRanges,
  intralineLineRanges,
  intralineRanges,
  intralineTokens,
} from "../../src/renderer/src/utils/diffIntraline";
import { diffSplitRows } from "../../src/renderer/src/utils/diffSplitRows";

function marked(text: string, ranges: { start: number; end: number }[]): string {
  return intralineSegments(text, ranges).map((segment) => segment.changed ? `[${segment.text}]` : segment.text).join("");
}

function pair(before: string, after: string): [string, string] | null {
  const ranges = intralineRanges(before, after);
  return ranges ? [marked(before, ranges.before), marked(after, ranges.after)] : null;
}

function line(kind: DiffLine["kind"], content: string, index: number): DiffLine {
  return {
    id: `line-${index}`,
    kind,
    content,
    patchLine: `${kind === "addition" ? "+" : kind === "deletion" ? "-" : kind === "meta" ? "\\" : " "}${content}`,
    oldLineNumber: kind === "addition" || kind === "meta" ? null : index + 1,
    newLineNumber: kind === "deletion" || kind === "meta" ? null : index + 1,
    newInsertionIndex: index,
    oldInsertionIndex: index,
  };
}

function hunkOf(lines: [DiffLine["kind"], string][]): DiffHunk {
  return {
    id: "hunk-1",
    header: "@@ -1 +1 @@",
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    lines: lines.map(([kind, content], index) => line(kind, content, index)),
  };
}

describe("intraline word diff", () => {
  it("splits on word boundaries and punctuation without losing text", () => {
    expect(intralineTokens("foo.bar(baz, 42)")).toEqual(["foo", ".", "bar", "(", "baz", ",", " ", "42", ")"]);
    const text = "naïve 𝒳 café—done";
    expect(intralineTokens(text).join("")).toBe(text);
  });

  it("handles empty and identical lines", () => {
    expect(intralineRanges("", "")).toEqual({ before: [], after: [] });
    expect(intralineRanges("same line", "same line")).toEqual({ before: [], after: [] });
    expect(intralineRanges("", "added text")).toBeNull();
    expect(intralineRanges("removed text", "")).toBeNull();
  });

  it("does not emphasize a whole-line change", () => {
    expect(intralineRanges("alpha beta", "gamma delta")).toBeNull();
    expect(intralineRanges("first before", "first after")).toEqual({
      before: [{ start: 6, end: 12 }],
      after: [{ start: 6, end: 11 }],
    });
  });

  it("emphasizes multiple narrow segments", () => {
    expect(pair("const total = price * count;", "const sum = price * amount;"))
      .toEqual(["const [total] = price * [count];", "const [sum] = price * [amount];"]);
    expect(pair("call(a, b)", "call(a, c, b)")).toEqual(["call(a, b)", "call(a, [c, ]b)"]);
    expect(pair("one two three four", "one 2 3 four")).toEqual(["one [two three] four", "one [2 3] four"]);
  });

  it("measures unicode in UTF-16 offsets consistent with the line content", () => {
    expect(pair("café 𝒳 naïve", "café 𝒴 naïve")).toEqual(["café [𝒳] naïve", "café [𝒴] naïve"]);
    expect(pair("größe = 1", "größe = 2")).toEqual(["größe = [1]", "größe = [2]"]);
  });

  it("respects the line-length bound", () => {
    const longBefore = `${"a ".repeat(INTRALINE_MAX_LINE_CHARS / 2)}x`;
    expect(longBefore.length).toBeGreaterThan(INTRALINE_MAX_LINE_CHARS);
    expect(intralineRanges(longBefore, `${longBefore}y`)).toBeNull();
    const atBound = `${"a".repeat(INTRALINE_MAX_LINE_CHARS - 2)} x`;
    expect(intralineRanges(atBound, atBound.replace(/x$/u, "y"))).not.toBeNull();
  });

  it("pairs only equal-length runs within the block bound", () => {
    const lines = (count: number, extraAddition = false): [DiffLine["kind"], string][] => [
      ...Array.from({ length: count }, (_, index) => ["deletion", `value ${index} old`] as [DiffLine["kind"], string]),
      ...Array.from({ length: count + (extraAddition ? 1 : 0) }, (_, index) => ["addition", `value ${index} new`] as [DiffLine["kind"], string]),
    ];
    expect(intralineLineRanges(hunkOf(lines(INTRALINE_MAX_BLOCK_LINES)).lines).size).toBe(INTRALINE_MAX_BLOCK_LINES * 2);
    expect(intralineLineRanges(hunkOf(lines(INTRALINE_MAX_BLOCK_LINES + 1)).lines).size).toBe(0);
    expect(intralineLineRanges(hunkOf(lines(2, true)).lines).size).toBe(0);
    const withMeta = hunkOf([["deletion", "x = 1"], ["meta", "\\ No newline at end of file"], ["addition", "x = 2"]]);
    expect([...intralineLineRanges(withMeta.lines).keys()]).toEqual([0, 2]);
  });
});

describe("highlighted diff markup", () => {
  it("applies marks across highlight spans and keeps the markup well nested", () => {
    const html = '<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;x&lt;y&quot;</span>;';
    const content = 'const a = "x<y";';
    expect(markedHighlightHtml(html, content, [{ start: 8, end: 13 }]))
      .toBe('<span class="hljs-keyword">const</span> a <mark class="diff-intraline">= </mark><span class="hljs-string"><mark class="diff-intraline">&quot;x&lt;</mark>y&quot;</span>;');
  });

  it("rejects markup that is not plain highlight spans around the exact content", () => {
    expect(markedHighlightHtml("<img src=x onerror=alert(1)>", "")).toBeNull();
    expect(markedHighlightHtml('<span class="x" onclick="y">a</span>', "a")).toBeNull();
    expect(markedHighlightHtml("<script>alert(1)</script>", "<script>alert(1)</script>")).toBeNull();
    expect(markedHighlightHtml("a &amp b", "a & b")).toBeNull();
    expect(markedHighlightHtml("a > b", "a > b")).toBeNull();
    expect(markedHighlightHtml("&lt;b&gt;", "<i>")).toBeNull();
    expect(markedHighlightHtml("<span class=\"a\">x", "x")).toBeNull();
    expect(markedHighlightHtml("&lt;b&gt;", "<b>")).toBe("&lt;b&gt;");
  });

  it("highlights each side of a hunk and escapes untrusted content", () => {
    const hunk = hunkOf([
      ["context", "const page = 1;"],
      ["deletion", 'const html = "<script>alert(1)</script>";'],
      ["addition", 'const html = "<script>alert(2)</script>";'],
    ]);
    const render = diffHunkRender(hunk, "fingerprint-escape", sourceLanguageForFile("src/page.ts"));
    expect(render.html).toHaveLength(3);
    for (const html of render.html) {
      expect(html).not.toBeNull();
      expect(html).not.toMatch(/<script/u);
    }
    expect(render.html[0]).toContain('<span class="hljs-keyword">const</span>');
    expect(render.html[1]).toContain("&lt;script&gt;");
    expect(render.html[2]).toContain('<mark class="diff-intraline">2</mark>');
    expect(diffHunkRender(hunk, "fingerprint-escape", sourceLanguageForFile("src/page.ts"))).toBe(render);
  });

  it("falls back to plain text with intraline ranges when highlighting is off", () => {
    const hunk = hunkOf([["deletion", "value = 1"], ["addition", "value = 2"]]);
    const render = diffHunkRender(hunk, "fingerprint-plain", null);
    expect(render.html).toEqual([null, null]);
    expect(render.ranges).toEqual([[{ start: 8, end: 9 }], [{ start: 8, end: 9 }]]);
  });

  it("caps highlighting by file line count and line length", () => {
    const file = (hunks: DiffHunk[]): DiffFile => ({ path: "a.ts", oldPath: "a.ts", newPath: "a.ts", hunks });
    expect(diffFileHighlightable(file([hunkOf(Array.from({ length: DIFF_HIGHLIGHT_MAX_FILE_LINES }, () => ["context", "x"] as [DiffLine["kind"], string]))]))).toBe(true);
    expect(diffFileHighlightable(file([hunkOf(Array.from({ length: DIFF_HIGHLIGHT_MAX_FILE_LINES + 1 }, () => ["context", "x"] as [DiffLine["kind"], string]))]))).toBe(false);
    expect(diffFileHighlightable(file([hunkOf([["addition", "x".repeat(DIFF_HIGHLIGHT_MAX_LINE_CHARS)]])]))).toBe(true);
    expect(diffFileHighlightable(file([hunkOf([["addition", "x".repeat(DIFF_HIGHLIGHT_MAX_LINE_CHARS + 1)]])]))).toBe(false);
  });
});

describe("bounded intraline work", () => {
  const file = (path: string, hunks: DiffHunk[]): DiffFile => ({ path, oldPath: path, newPath: path, hunks });
  const words = (seed: number, count: number) => Array.from({ length: count }, (_, index) => `w${(seed * 7 + index * 13) % 97}`).join(" ");
  const pairedHunk = (seed: number, pairs: number, wordsPerLine: number): DiffHunk => {
    const hunk = hunkOf([
      ...Array.from({ length: pairs }, (_, index) => ["deletion", words(seed + index, wordsPerLine)] as [DiffLine["kind"], string]),
      ...Array.from({ length: pairs }, (_, index) => ["addition", words(seed + index + 1, wordsPerLine)] as [DiffLine["kind"], string]),
    ]);
    return { ...hunk, id: `hunk-${seed}` };
  };

  it("caps the intraline work one large file can spend", () => {
    const hunks = Array.from({ length: 190 }, (_, index) => pairedHunk(index * 31, 10, 60));
    const large = file("notes/large.txt", hunks);
    expect(diffFileHighlightable(large)).toBe(true);
    const startedAt = performance.now();
    const renders = diffFileRenders(large, (hunk) => `bounded-${hunk.id}`);
    const elapsed = performance.now() - startedAt;
    const spent = renders.reduce((total, render) => total + render.intralineCells, 0);
    expect(spent).toBeLessThanOrEqual(INTRALINE_MAX_FILE_CELLS + INTRALINE_MAX_HUNK_CELLS);
    expect(renders.some((render) => render.ranges.some((ranges) => ranges !== null))).toBe(true);
    expect(renders.at(-1)!.ranges.every((ranges) => ranges === null)).toBe(true);
    expect(elapsed).toBeLessThan(1_500);
  });

  it("skips intraline emphasis for files outside the highlight bounds", () => {
    const hunk = hunkOf([["deletion", "value = 1"], ["addition", "value = 2"], ["context", "x".repeat(DIFF_HIGHLIGHT_MAX_LINE_CHARS + 1)]]);
    const [render] = diffFileRenders(file("a.txt", [hunk]), () => "fingerprint-outside-bounds");
    expect(render!.ranges.every((ranges) => ranges === null)).toBe(true);
    expect(render!.intralineCells).toBe(0);
  });

  it("drops a hunk's emphasis whole when it needs more than its allowance", () => {
    const hunk = pairedHunk(5, 20, 40);
    const over = intralineHunkRanges(hunk.lines, 10_000);
    expect(over.ranges.size).toBe(0);
    expect(intralineHunkRanges(hunk.lines, 10_000)).toEqual(over);
    expect(intralineHunkRanges(hunk.lines).ranges.size).toBeGreaterThan(0);
  });

  it("does not build a comparison table for lines that share no token", () => {
    const unrelated = hunkOf([["deletion", "alpha beta gamma delta"], ["addition", "one two three four"]]);
    const { ranges, cells } = intralineHunkRanges(unrelated.lines);
    expect(ranges.size).toBe(0);
    expect(cells).toBe(intralineTokens("alpha beta gamma delta").length + intralineTokens("one two three four").length);
  });
});

describe("split diff rows", () => {
  it("aligns paired runs with placeholders and keeps meta lines", () => {
    const hunk = hunkOf([
      ["context", "a"],
      ["deletion", "b"],
      ["deletion", "c"],
      ["addition", "B"],
      ["context", "d"],
      ["addition", "e"],
      ["deletion", "f"],
      ["meta", "\\ No newline at end of file"],
    ]);
    expect(diffSplitRows(hunk.lines)).toEqual([
      { kind: "context", index: 0 },
      { kind: "change", left: 1, right: 3 },
      { kind: "change", left: 2, right: null },
      { kind: "context", index: 4 },
      { kind: "change", left: null, right: 5 },
      { kind: "change", left: 6, right: null },
      { kind: "meta", index: 7 },
    ]);
  });
});
