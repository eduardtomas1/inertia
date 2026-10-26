export interface StreamingMarkdownSplit {
  readonly content: string;
  readonly blocks: readonly string[];
  readonly settledEnd: number;
  readonly lineStart: number;
  readonly blockStart: number;
  readonly fence: string | null;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const EMPTY_SPLIT: StreamingMarkdownSplit = {
  content: "",
  blocks: [],
  settledEnd: 0,
  lineStart: 0,
  blockStart: -1,
  fence: null,
};

function closesFence(line: string, fence: string): boolean {
  const marker = FENCE.exec(line)?.[1];
  return marker !== undefined
    && marker[0] === fence[0]
    && marker.length >= fence.length
    && line.slice(line.indexOf(marker) + marker.length).trim() === "";
}

function continuesFrom(previous: StreamingMarkdownSplit, content: string): boolean {
  return content.length >= previous.lineStart
    && content.startsWith(previous.content.slice(0, previous.lineStart));
}

export function splitStreamingMarkdown(
  content: string,
  previous: StreamingMarkdownSplit = EMPTY_SPLIT,
): StreamingMarkdownSplit {
  if (previous.content === content) return previous;
  const base = continuesFrom(previous, content) ? previous : EMPTY_SPLIT;
  let blocks: string[] | null = null;
  let { settledEnd, lineStart, blockStart, fence } = base;
  for (let newline = content.indexOf("\n", lineStart); newline >= 0; newline = content.indexOf("\n", lineStart)) {
    const line = content.slice(lineStart, newline).replace(/\r$/u, "");
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
    } else if (line.trim() === "") {
      if (blockStart >= 0) {
        blocks ??= [...base.blocks];
        blocks.push(content.slice(blockStart, lineStart).replace(/\r?\n$/u, ""));
        blockStart = -1;
      }
      settledEnd = newline + 1;
    } else {
      if (blockStart < 0) blockStart = lineStart;
      fence = FENCE.exec(line)?.[1] ?? null;
    }
    lineStart = newline + 1;
  }
  return {
    content,
    blocks: blocks ?? base.blocks,
    settledEnd,
    lineStart,
    blockStart,
    fence,
  };
}

export function streamingMarkdownTail(split: StreamingMarkdownSplit): string {
  return split.content.slice(split.settledEnd);
}
