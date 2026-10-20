/**
 * Word-level emphasis for paired deletion/addition runs inside one hunk.
 *
 * Everything here is pure and bounded: a block is paired only when its
 * deletion and addition runs have the same length (at most
 * `INTRALINE_MAX_BLOCK_LINES`) and each line is at most
 * `INTRALINE_MAX_LINE_CHARS` UTF-16 units. Ranges are UTF-16 offsets into
 * `DiffLine.content`, so callers can apply them to plain or escaped text.
 */

export const INTRALINE_MAX_BLOCK_LINES = 20;
export const INTRALINE_MAX_LINE_CHARS = 500;

export interface IntralineRange {
  start: number;
  end: number;
}

export interface IntralinePairRanges {
  before: IntralineRange[];
  after: IntralineRange[];
}

interface IntralineLine {
  kind: "context" | "addition" | "deletion" | "meta";
  content: string;
}

// Words (letters, marks, digits, underscore), whitespace runs, and every other
// code point on its own, so punctuation changes stay narrow.
const TOKEN = /[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu;
const WHITESPACE = /^\s+$/u;

export function intralineTokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

function changedTokenFlags(before: string[], after: string[]): { before: boolean[]; after: boolean[] } {
  const beforeChanged = before.map(() => true);
  const afterChanged = after.map(() => true);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    beforeChanged[prefix] = false;
    afterChanged[prefix] = false;
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    beforeChanged[before.length - 1 - suffix] = false;
    afterChanged[after.length - 1 - suffix] = false;
    suffix += 1;
  }
  const rows = before.length - prefix - suffix;
  const columns = after.length - prefix - suffix;
  if (rows === 0 || columns === 0) return { before: beforeChanged, after: afterChanged };
  // Token counts are bounded by the line-length cap, so this table holds at
  // most 501 * 501 cells and every value fits in 16 bits.
  const width = columns + 1;
  const table = new Uint16Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * width + column] = before[prefix + row] === after[prefix + column]
        ? table[(row + 1) * width + column + 1]! + 1
        : Math.max(table[(row + 1) * width + column]!, table[row * width + column + 1]!);
    }
  }
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[prefix + row] === after[prefix + column]) {
      beforeChanged[prefix + row] = false;
      afterChanged[prefix + column] = false;
      row += 1;
      column += 1;
    } else if (table[(row + 1) * width + column]! >= table[row * width + column + 1]!) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return { before: beforeChanged, after: afterChanged };
}

function rangesFor(tokens: string[], changed: boolean[]): IntralineRange[] {
  const ranges: IntralineRange[] = [];
  let offset = 0;
  let pendingGap: IntralineRange | null = null;
  tokens.forEach((token, index) => {
    const start = offset;
    offset += token.length;
    const last = ranges.at(-1);
    if (changed[index]) {
      if (last && last.end === start) last.end = offset;
      else if (last && pendingGap && pendingGap.start === last.end && pendingGap.end === start) last.end = offset;
      else ranges.push({ start, end: offset });
      pendingGap = null;
      return;
    }
    // A single unchanged whitespace run between two changed tokens joins them,
    // so "a b" -> "x y" reads as one emphasized phrase.
    pendingGap = last && last.end === start && WHITESPACE.test(token) ? { start, end: offset } : null;
  });
  return ranges;
}

/**
 * Returns the changed ranges of one deletion/addition pair, an empty result
 * for identical lines, or `null` when no emphasis should be shown: a line is
 * over the bound, or the pair shares no non-whitespace token (a whole-line
 * change, already conveyed by the line background).
 */
export function intralineRanges(before: string, after: string): IntralinePairRanges | null {
  if (before.length > INTRALINE_MAX_LINE_CHARS || after.length > INTRALINE_MAX_LINE_CHARS) return null;
  if (before === after) return { before: [], after: [] };
  const beforeTokens = intralineTokens(before);
  const afterTokens = intralineTokens(after);
  const flags = changedTokenFlags(beforeTokens, afterTokens);
  const sharesContent = beforeTokens.some((token, index) => !flags.before[index] && !WHITESPACE.test(token));
  if (!sharesContent) return null;
  return {
    before: rangesFor(beforeTokens, flags.before),
    after: rangesFor(afterTokens, flags.after),
  };
}

/**
 * Pairs equal-length deletion and addition runs (meta lines such as
 * "\ No newline at end of file" are transparent) and returns the emphasized
 * ranges per hunk line index. Lines without emphasis are absent.
 */
export function intralineLineRanges(lines: readonly IntralineLine[]): Map<number, IntralineRange[]> {
  const result = new Map<number, IntralineRange[]>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.kind !== "deletion") {
      index += 1;
      continue;
    }
    const deletions: number[] = [];
    while (index < lines.length && (lines[index]!.kind === "deletion" || lines[index]!.kind === "meta")) {
      if (lines[index]!.kind === "deletion") deletions.push(index);
      index += 1;
    }
    const additions: number[] = [];
    while (index < lines.length && (lines[index]!.kind === "addition" || lines[index]!.kind === "meta")) {
      if (lines[index]!.kind === "addition") additions.push(index);
      index += 1;
    }
    if (deletions.length !== additions.length || deletions.length > INTRALINE_MAX_BLOCK_LINES) continue;
    deletions.forEach((deletion, pair) => {
      const addition = additions[pair]!;
      const ranges = intralineRanges(lines[deletion]!.content, lines[addition]!.content);
      if (!ranges) return;
      if (ranges.before.length > 0) result.set(deletion, ranges.before);
      if (ranges.after.length > 0) result.set(addition, ranges.after);
    });
  }
  return result;
}
