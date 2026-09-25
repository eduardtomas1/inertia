export interface ReasoningSummarySegment {
  id: string;
  title: string | null;
  body: string;
}

const SEGMENT_PATTERN = /\*\*([^*]+?)\*\*/gu;

export function parseReasoningSummary(
  content: string,
): ReasoningSummarySegment[] {
  const text = content.replace(/\r\n?/gu, "\n");
  const segments: ReasoningSummarySegment[] = [];
  let lastIndex = 0;
  let pendingTitle: string | null = null;
  SEGMENT_PATTERN.lastIndex = 0;
  for (
    let match = SEGMENT_PATTERN.exec(text);
    match !== null;
    match = SEGMENT_PATTERN.exec(text)
  ) {
    const body = text.slice(lastIndex, match.index).trim();
    if (pendingTitle !== null || body) {
      segments.push({
        id: `${segments.length}`,
        title: pendingTitle,
        body,
      });
    }
    pendingTitle = match[1]!.trim();
    lastIndex = match.index + match[0].length;
  }
  const trailing = text.slice(lastIndex).trim();
  if (pendingTitle !== null || trailing) {
    segments.push({
      id: `${segments.length}`,
      title: pendingTitle,
      body: trailing,
    });
  }
  if (!segments.some(({ title }) => title !== null)) return [];
  return segments.filter(({ title, body }) => title !== null || body.length > 0);
}

export interface ReasoningLine {
  offset: number;
  text: string;
  complete: boolean;
}

const SENTENCE_END_PATTERN = /[.!?\u2026]["'\u2019\u201d)\]]*\s+/gu;
const FINISHED_SENTENCE_PATTERN = /[.!?\u2026]["'\u2019\u201d)\]]*$/u;

function readableText(value: string): string {
  return value.replace(/\*\*|`/gu, "").replace(/\s+/gu, " ").trim();
}

function pushReasoningLine(
  lines: ReasoningLine[],
  offset: number,
  raw: string,
  complete: boolean,
): void {
  const text = readableText(raw);
  if (!text) return;
  lines.push({
    offset: offset + raw.length - raw.trimStart().length,
    text,
    complete: complete || FINISHED_SENTENCE_PATTERN.test(raw.trimEnd()),
  });
}

function pushReasoningBody(
  lines: ReasoningLine[],
  content: string,
  start: number,
  end: number,
  closed: boolean,
): void {
  let lineStart = start;
  while (lineStart < end) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 || newline >= end ? end : newline;
    const line = content.slice(lineStart, lineEnd);
    let sentenceStart = 0;
    for (const match of line.matchAll(SENTENCE_END_PATTERN)) {
      pushReasoningLine(
        lines,
        lineStart + sentenceStart,
        line.slice(sentenceStart, match.index + match[0].trimEnd().length),
        true,
      );
      sentenceStart = match.index + match[0].length;
    }
    pushReasoningLine(
      lines,
      lineStart + sentenceStart,
      line.slice(sentenceStart),
      lineEnd < end || closed,
    );
    lineStart = lineEnd + 1;
  }
}

export function reasoningLines(content: string): ReasoningLine[] {
  const lines: ReasoningLine[] = [];
  let cursor = 0;
  for (const match of content.matchAll(SEGMENT_PATTERN)) {
    pushReasoningBody(lines, content, cursor, match.index, true);
    pushReasoningLine(lines, match.index, match[0], true);
    cursor = match.index + match[0].length;
  }
  pushReasoningBody(lines, content, cursor, content.length, false);
  return lines;
}

export function readableReasoningLine(
  lines: readonly ReasoningLine[],
  floor = 0,
): ReasoningLine | null {
  let unfinished: ReasoningLine | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.offset < floor) break;
    if (line.complete) return line;
    unfinished ??= line;
  }
  return unfinished;
}

export function reasoningLineAt(
  lines: readonly ReasoningLine[],
  offset: number,
): ReasoningLine | null {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const line = lines[middle]!;
    if (line.offset === offset) return line;
    if (line.offset < offset) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

export const THINKING_LINE_MIN_DWELL_MS = 2_400;
export const THINKING_LINE_MAX_DWELL_MS = 7_000;
export const THINKING_LINE_CHARACTER_MS = 45;

export function thinkingLineDwellMs(text: string): number {
  return Math.min(
    THINKING_LINE_MAX_DWELL_MS,
    Math.max(THINKING_LINE_MIN_DWELL_MS, text.length * THINKING_LINE_CHARACTER_MS),
  );
}

export interface ThinkingLineState {
  offset: number | null;
  previousOffset: number | null;
  shownAt: number;
  floor: number;
}

export const IDLE_THINKING_LINE: ThinkingLineState = {
  offset: null,
  previousOffset: null,
  shownAt: 0,
  floor: 0,
};

export interface ThinkingLineInput {
  active: boolean;
  length: number;
  now: number;
}

export function advanceThinkingLine(
  state: ThinkingLineState,
  lines: readonly ReasoningLine[],
  input: ThinkingLineInput,
): ThinkingLineState {
  const floor = state.floor <= input.length ? state.floor : 0;
  const shown = state.offset === null ? null : reasoningLineAt(lines, state.offset);
  const candidate = readableReasoningLine(lines, floor);
  if (!shown) {
    if (input.active && candidate) {
      return { offset: candidate.offset, previousOffset: null, shownAt: input.now, floor };
    }
    if (state.offset !== null) {
      return { ...IDLE_THINKING_LINE, floor: input.active ? floor : input.length };
    }
    return floor === state.floor ? state : { ...state, floor };
  }
  if (input.now < state.shownAt + thinkingLineDwellMs(shown.text)) {
    return floor === state.floor ? state : { ...state, floor };
  }
  if (!input.active) {
    return { ...IDLE_THINKING_LINE, shownAt: input.now, floor: input.length };
  }
  if (candidate && candidate.offset !== shown.offset) {
    return {
      offset: candidate.offset,
      previousOffset: shown.offset,
      shownAt: input.now,
      floor,
    };
  }
  return floor === state.floor ? state : { ...state, floor };
}

export function thinkingLineWakeAt(
  state: ThinkingLineState,
  lines: readonly ReasoningLine[],
  active: boolean,
): number | null {
  if (state.offset === null) return null;
  const shown = reasoningLineAt(lines, state.offset);
  if (!shown) return null;
  if (active) {
    const candidate = readableReasoningLine(lines, state.floor);
    if (!candidate || candidate.offset === shown.offset) return null;
  }
  return state.shownAt + thinkingLineDwellMs(shown.text);
}
