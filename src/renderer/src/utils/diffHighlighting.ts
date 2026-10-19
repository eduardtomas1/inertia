import type { DiffFile, DiffHunk } from "@shared/contracts";
import type { SourceLanguage } from "@shared/source-language";

import { createBoundedCache } from "./boundedCache";
import { intralineLineRanges, type IntralineRange } from "./diffIntraline";
import { highlightedSourceLines } from "./sourceHighlighting";

/** Files over either bound render as plain text (intraline emphasis still applies). */
export const DIFF_HIGHLIGHT_MAX_FILE_LINES = 4_000;
export const DIFF_HIGHLIGHT_MAX_LINE_CHARS = 2_000;

export interface DiffHunkRender {
  /**
   * Per `hunk.lines` index: verified highlight.js markup with intraline marks
   * already applied, or `null` to render `content` as React text.
   */
  html: (string | null)[];
  /** Per `hunk.lines` index: intraline ranges for the plain-text fallback. */
  ranges: (IntralineRange[] | null)[];
}

const MARK_OPEN = '<mark class="diff-intraline">';
const MARK_CLOSE = "</mark>";
const ENTITY_TEXT: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
};
// highlight.js only emits class-bearing spans around escaped text. Anything
// else (another tag, attribute, unknown entity or a raw `>`) is rejected.
const MARKUP_TOKEN = /<[^>]*>|&[^;&<]*;|[^<&]+|[<&]/gu;
const SAFE_OPEN_SPAN = /^<span class="[A-Za-z0-9_ -]+">$/u;

type MarkupToken = { tag: string } | { text: string; source: string };

function verifiedTokens(html: string, content: string): MarkupToken[] | null {
  const tokens: MarkupToken[] = [];
  let text = "";
  let depth = 0;
  for (const [token] of html.matchAll(MARKUP_TOKEN)) {
    if (token.startsWith("<") && token.length > 1) {
      if (token === "</span>") {
        depth -= 1;
        if (depth < 0) return null;
      } else if (SAFE_OPEN_SPAN.test(token)) {
        depth += 1;
      } else {
        return null;
      }
      tokens.push({ tag: token });
    } else if (token.startsWith("&") && token.length > 1) {
      const decoded = ENTITY_TEXT[token];
      if (decoded === undefined) return null;
      tokens.push({ text: decoded, source: token });
      text += decoded;
    } else {
      if (token.includes(">") || token === "<" || token === "&") return null;
      for (const character of token) tokens.push({ text: character, source: character });
      text += token;
    }
  }
  return depth === 0 && text === content ? tokens : null;
}

function inRanges(ranges: readonly IntralineRange[], offset: number): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

/**
 * Returns `html` with `<mark class="diff-intraline">` around the given text
 * ranges, or `null` when `html` is not plain highlight.js span markup whose
 * text is exactly `content`. Marks are closed before every span boundary and
 * reopened after it so the result stays well nested.
 */
export function markedHighlightHtml(
  html: string,
  content: string,
  ranges: readonly IntralineRange[] = [],
): string | null {
  const tokens = verifiedTokens(html, content);
  if (!tokens) return null;
  if (ranges.length === 0) return html;
  let output = "";
  let offset = 0;
  let marking = false;
  for (const token of tokens) {
    if ("tag" in token) {
      if (marking) output += MARK_CLOSE;
      marking = false;
      output += token.tag;
      continue;
    }
    const wanted = inRanges(ranges, offset);
    if (wanted !== marking) output += wanted ? MARK_OPEN : MARK_CLOSE;
    marking = wanted;
    output += token.source;
    offset += token.text.length;
  }
  if (marking) output += MARK_CLOSE;
  return output;
}

/** Splits plain text into React-renderable segments for the fallback path. */
export function intralineSegments(
  content: string,
  ranges: readonly IntralineRange[],
): { text: string; changed: boolean }[] {
  const segments: { text: string; changed: boolean }[] = [];
  let cursor = 0;
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const start = Math.max(cursor, Math.min(range.start, content.length));
    const end = Math.min(range.end, content.length);
    if (start > cursor) segments.push({ text: content.slice(cursor, start), changed: false });
    if (end > start) segments.push({ text: content.slice(start, end), changed: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < content.length) segments.push({ text: content.slice(cursor), changed: false });
  return segments;
}

export function diffFileHighlightable(file: DiffFile): boolean {
  let lines = 0;
  for (const hunk of file.hunks) {
    lines += hunk.lines.length;
    if (lines > DIFF_HIGHLIGHT_MAX_FILE_LINES) return false;
    if (hunk.lines.some((line) => line.content.length > DIFF_HIGHLIGHT_MAX_LINE_CHARS)) return false;
  }
  return true;
}

// The highlighter splits on CRLF, so a CRLF line is highlighted without its
// invisible trailing carriage return and verified against the same text.
function withoutCarriageReturn(content: string): string {
  return content.endsWith("\r") ? content.slice(0, -1) : content;
}

function sideHighlights(
  hunk: DiffHunk,
  language: SourceLanguage,
  side: "old" | "new",
): Map<number, string> | null {
  const indexes: number[] = [];
  hunk.lines.forEach((line, index) => {
    if (line.kind === "context" || line.kind === (side === "old" ? "deletion" : "addition")) indexes.push(index);
  });
  if (indexes.length === 0) return new Map();
  // Each side is highlighted as one document so multi-line strings and
  // comments keep their state across lines within the hunk.
  const lines = highlightedSourceLines(indexes.map((index) => withoutCarriageReturn(hunk.lines[index]!.content)).join("\n"), language);
  if (!lines || lines.length !== indexes.length) return null;
  return new Map(indexes.map((index, position) => [index, lines[position]!]));
}

function buildHunkRender(hunk: DiffHunk, language: SourceLanguage | null): DiffHunkRender {
  const intraline = intralineLineRanges(hunk.lines);
  const oldSide = language?.highlightLanguage ? sideHighlights(hunk, language, "old") : null;
  const newSide = language?.highlightLanguage ? sideHighlights(hunk, language, "new") : null;
  const html: (string | null)[] = [];
  const ranges: (IntralineRange[] | null)[] = [];
  hunk.lines.forEach((line, index) => {
    const lineRanges = intraline.get(index) ?? null;
    const source = line.kind === "deletion" ? oldSide : line.kind === "meta" ? null : newSide;
    const highlighted = source?.get(index);
    const marked = highlighted === undefined
      ? null
      : markedHighlightHtml(highlighted, withoutCarriageReturn(line.content), lineRanges ?? []);
    html.push(marked);
    ranges.push(marked === null ? lineRanges : null);
  });
  return { html, ranges };
}

const hunkRenderCache = createBoundedCache<DiffHunkRender>(
  2_000,
  8_000_000,
  (key, render) => key.length + render.html.reduce((total, line) => total + (line?.length ?? 0), 0)
    + render.ranges.length * 8,
);

/**
 * Memoized per hunk fingerprint (which covers the path and every line), so
 * review-state changes and re-parsed identical diffs reuse earlier work.
 */
export function diffHunkRender(
  hunk: DiffHunk,
  fingerprint: string,
  language: SourceLanguage | null,
): DiffHunkRender {
  const key = `${fingerprint}\0${language?.highlightLanguage ?? ""}`;
  const cached = hunkRenderCache.get(key);
  if (cached) return cached;
  const render = buildHunkRender(hunk, language);
  hunkRenderCache.set(key, render);
  return render;
}
