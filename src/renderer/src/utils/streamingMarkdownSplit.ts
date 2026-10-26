export interface StreamingMarkdownSplit {
  readonly content: string;
  readonly blocks: readonly string[];
  readonly settledEnd: number;
  readonly lineStart: number;
  readonly scannedEnd: number;
  readonly blockStart: number;
  readonly blockIsList: boolean;
  readonly breakAt: number;
  readonly fence: string | null;
  readonly html: HtmlBlock | null;
}

interface HtmlBlock {
  readonly tag: string;
  readonly depth: number;
}

const FENCE = /^[ \t]*(`{3,}|~{3,})/u;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/u;
const LIST_MARKER_START = /^[-+*0-9]/u;
const REFERENCE_DEFINITION = /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*\S.*$/gmu;
const INDENTED_CODE = /^(?: {4}|\t)/u;
const HTML_BLOCK_OPEN = /^ {0,3}<(details|div|table|section|article|aside|figure|pre|ul|ol|dl|blockquote|center|nav|header|footer|main)(?=[\s/>]|$)/iu;
const EMPTY_SPLIT: StreamingMarkdownSplit = {
  content: "",
  blocks: [],
  settledEnd: 0,
  lineStart: 0,
  scannedEnd: 0,
  blockStart: -1,
  blockIsList: false,
  breakAt: -1,
  fence: null,
  html: null,
};

function closesFence(line: string, fence: string): boolean {
  const marker = FENCE.exec(line)?.[1];
  return marker !== undefined
    && marker[0] === fence[0]
    && marker.length >= fence.length
    && line.slice(line.indexOf(marker) + marker.length).trim() === "";
}

function htmlDepthChange(line: string, tag: string): number {
  const opens = line.match(new RegExp(`<${tag}(?=[\\s/>]|$)`, "giu"))?.length ?? 0;
  const closes = line.match(new RegExp(`</${tag}\\s*>`, "giu"))?.length ?? 0;
  return opens - closes;
}

function openedHtmlBlock(line: string): HtmlBlock | null {
  const tag = HTML_BLOCK_OPEN.exec(line)?.[1]?.toLowerCase();
  if (tag === undefined) return null;
  const depth = htmlDepthChange(line, tag);
  return depth > 0 ? { tag, depth } : null;
}

function continuesBlock(line: string, blockIsList: boolean): boolean {
  return /^[ \t]/u.test(line) || (blockIsList && LIST_ITEM.test(line));
}

function continuesFrom(previous: StreamingMarkdownSplit, content: string): boolean {
  return content.length >= previous.scannedEnd
    && content.startsWith(previous.content.slice(0, previous.scannedEnd));
}

export function splitStreamingMarkdown(
  content: string,
  previous: StreamingMarkdownSplit = EMPTY_SPLIT,
): StreamingMarkdownSplit {
  if (previous.content === content) return previous;
  const base = continuesFrom(previous, content) ? previous : EMPTY_SPLIT;
  let blocks: string[] | null = null;
  let { settledEnd, lineStart, blockStart, blockIsList, breakAt, fence, html } = base;
  const settle = (): void => {
    blocks ??= [...base.blocks];
    blocks.push(content.slice(blockStart, breakAt).replace(/\r?\n$/u, ""));
    settledEnd = lineStart;
    blockStart = lineStart;
    breakAt = -1;
  };
  for (let newline = content.indexOf("\n", lineStart); newline >= 0; newline = content.indexOf("\n", lineStart)) {
    const line = content.slice(lineStart, newline).replace(/\r$/u, "");
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
    } else if (html !== null) {
      const depth = html.depth + htmlDepthChange(line, html.tag);
      html = depth > 0 ? { tag: html.tag, depth } : null;
    } else if (line.trim() === "") {
      if (blockStart < 0) settledEnd = newline + 1;
      else if (breakAt < 0) breakAt = lineStart;
    } else {
      if (breakAt >= 0) {
        if (continuesBlock(line, blockIsList)) breakAt = -1;
        else settle();
      }
      if (blockStart < 0) blockStart = lineStart;
      if (blockStart === lineStart) {
        blockIsList = LIST_ITEM.test(line);
        html = openedHtmlBlock(line);
      }
      fence = FENCE.exec(line)?.[1] ?? null;
    }
    lineStart = newline + 1;
  }
  let scannedEnd = lineStart;
  const next = content[lineStart];
  if (
    breakAt >= 0
    && next !== undefined
    && /\S/u.test(next)
    && !(blockIsList && LIST_MARKER_START.test(next))
  ) {
    settle();
    blockStart = -1;
    scannedEnd = lineStart + 1;
  }
  return {
    content,
    blocks: blocks ?? base.blocks,
    settledEnd,
    lineStart,
    scannedEnd,
    blockStart,
    blockIsList,
    breakAt,
    fence,
    html,
  };
}

export function streamingMarkdownTail(split: StreamingMarkdownSplit): string {
  return split.content.slice(split.settledEnd);
}

export function markdownReferenceDefinitions(blocks: readonly string[]): string {
  return blocks
    .filter((block) => !FENCE.test(block) && !INDENTED_CODE.test(block))
    .flatMap((block) => block.match(REFERENCE_DEFINITION) ?? [])
    .join("\n");
}
