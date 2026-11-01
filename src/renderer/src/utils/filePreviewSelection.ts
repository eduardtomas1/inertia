/** Upper bounds for a file-preview excerpt sent to the composer. */
export const MAX_FILE_SELECTION_PROMPT_LINES = 300;
export const MAX_FILE_SELECTION_PROMPT_BYTES = 16 * 1024;

export type FileSelectionPromptMode = "add" | "ask";

export interface FilePreviewLineSelection {
  /** Identity of the preview the selection was made in. */
  identity: string;
  anchor: number;
  start: number;
  end: number;
}

export interface FileSelectionPromptInput {
  path: string;
  /** Preview lines split on "\n", exactly as rendered. */
  lines: readonly string[];
  start: number;
  end: number;
  mode: FileSelectionPromptMode;
}

export interface FileSelectionPrompt {
  text: string;
  includedEnd: number;
  trimmed: boolean;
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Returns the longest prefix of `value` that fits in `maxBytes` UTF-8 bytes. */
function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = utf8Bytes(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
}

export function fileSelectionRangeLabel(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

/** A Markdown fence longer than any backtick run inside the excerpt. */
export function markdownFenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** Extends or replaces a selection, clamped to the selectable line range. */
export function nextFilePreviewSelection(
  current: FilePreviewLineSelection | null,
  identity: string,
  line: number,
  extend: boolean,
  selectableLines: number,
): FilePreviewLineSelection | null {
  if (selectableLines < 1) return null;
  const target = Math.min(Math.max(1, Math.trunc(line)), selectableLines);
  const anchor = extend && current?.identity === identity
    ? Math.min(current.anchor, selectableLines)
    : target;
  return {
    identity,
    anchor,
    start: Math.min(anchor, target),
    end: Math.max(anchor, target),
  };
}

/**
 * Builds the composer text for a preview selection: a header naming the file
 * and range, then a fenced excerpt bounded to 300 lines and 16 KiB.
 */
export function buildFileSelectionPrompt({
  path,
  lines,
  start,
  end,
  mode,
}: FileSelectionPromptInput): FileSelectionPrompt {
  const first = Math.max(1, Math.trunc(start));
  const last = Math.min(lines.length, Math.trunc(end));
  if (last < first) throw new Error("Select lines inside the loaded preview.");
  const lastByLines = Math.min(last, first + MAX_FILE_SELECTION_PROMPT_LINES - 1);
  const included: string[] = [];
  let bytes = 0;
  let trimmed = lastByLines < last;
  for (let line = first; line <= lastByLines; line += 1) {
    const text = (lines[line - 1] ?? "").replace(/\r$/u, "");
    const size = utf8Bytes(text) + (included.length > 0 ? 1 : 0);
    if (bytes + size > MAX_FILE_SELECTION_PROMPT_BYTES) {
      trimmed = true;
      if (included.length === 0) {
        included.push(utf8Prefix(text, MAX_FILE_SELECTION_PROMPT_BYTES));
      }
      break;
    }
    included.push(text);
    bytes += size;
  }
  const includedEnd = first + included.length - 1;
  const excerpt = included.join("\n");
  const fence = markdownFenceFor(excerpt);
  const parts = [
    `${path} ${fileSelectionRangeLabel(first, last)}:`,
    fence,
    excerpt,
    fence,
  ];
  if (trimmed) {
    parts.push(
      `(Excerpt trimmed to ${fileSelectionRangeLabel(first, includedEnd)}`
      + ` of the selection; limit ${MAX_FILE_SELECTION_PROMPT_LINES} lines`
      + ` or ${MAX_FILE_SELECTION_PROMPT_BYTES / 1024} KiB.)`,
    );
  }
  const text = parts.join("\n");
  return {
    text: mode === "ask" ? `${text}\n\n` : text,
    includedEnd,
    trimmed,
  };
}

/** Splits a snippet around the first case-insensitive literal match. */
export function contentSnippetParts(
  snippet: string,
  query: string,
): [before: string, match: string, after: string] | null {
  if (!query) return null;
  const lowerSnippet = snippet.toLowerCase();
  const lowerQuery = query.toLowerCase();
  // Case mapping that changes length would misplace the highlight.
  if (
    lowerSnippet.length !== snippet.length
    || lowerQuery.length !== query.length
  ) return null;
  const index = lowerSnippet.indexOf(lowerQuery);
  if (index < 0) return null;
  return [
    snippet.slice(0, index),
    snippet.slice(index, index + query.length),
    snippet.slice(index + query.length),
  ];
}
