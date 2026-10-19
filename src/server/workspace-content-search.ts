import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

import { FILE_OPEN_NO_FOLLOW } from "../node/platform-file-open-flags";
import {
  WORKSPACE_CONTENT_SEARCH_LIMITS,
  type WorkspaceContentMatch,
} from "../shared/contracts/workspace";
import type { WorkspaceEntryIdentity } from "./workspace-traversal";

function sameIdentity(
  left: WorkspaceEntryIdentity,
  right: WorkspaceEntryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type SearchableFileRead =
  | { status: "text"; text: string; bytes: number }
  | { status: "skipped"; bytes: number }
  | { status: "budget" };

export function literalSearchPattern(query: string): RegExp {
  // The user's text is always a literal: every RegExp syntax character is
  // escaped, so no user-controlled pattern semantics or backtracking exist.
  return new RegExp(query.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&"), "giu");
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function contentSnippet(line: string, index: number, length: number): string {
  const limit = WORKSPACE_CONTENT_SEARCH_LIMITS.snippetCharacters;
  if (line.length <= limit) return line.trim();
  // Reserve room for an ellipsis on each side so the result stays in bounds.
  const window = limit - 2;
  let start = Math.max(0, index - Math.floor(Math.max(0, window - length) / 2));
  let end = Math.min(line.length, start + window);
  start = Math.max(0, end - window);
  if (start > 0 && isLowSurrogate(line.charCodeAt(start))) start += 1;
  if (end < line.length && isLowSurrogate(line.charCodeAt(end))) end -= 1;
  const excerpt = line.slice(start, end);
  return `${start > 0 ? "…" : ""}${start > 0 ? excerpt : excerpt.trimStart()}${end < line.length ? "…" : ""}`;
}

export async function readSearchableFile(
  absolute: string,
  identity: WorkspaceEntryIdentity,
  maxFileBytes: number,
  remainingBytes: number,
): Promise<SearchableFileRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
    const info = await handle.stat();
    // The opened inode must be the entry described inside its stable,
    // contained parent; a swapped link or replaced file is skipped.
    if (!info.isFile() || !sameIdentity(identity, info)) {
      return { status: "skipped", bytes: 0 };
    }
    if (info.size > maxFileBytes) return { status: "skipped", bytes: 0 };
    if (info.size > remainingBytes) return { status: "budget" };
    const sniffBytes = WORKSPACE_CONTENT_SEARCH_LIMITS.binarySniffBytes;
    const buffer = Buffer.alloc(Math.min(info.size, maxFileBytes) + 1);
    let offset = 0;
    let sniffed = false;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (!sniffed && offset >= Math.min(sniffBytes, buffer.length)) {
        sniffed = true;
        if (buffer.subarray(0, Math.min(offset, sniffBytes)).includes(0)) {
          return { status: "skipped", bytes: offset };
        }
      }
    }
    // A file that grew past its stat size is either over the size bound or
    // changing underneath the search; neither is reported.
    if (offset > maxFileBytes || offset > info.size) {
      return { status: "skipped", bytes: offset };
    }
    const bytes = buffer.subarray(0, offset);
    if (!sniffed && bytes.subarray(0, sniffBytes).includes(0)) {
      return { status: "skipped", bytes: offset };
    }
    return {
      status: "text",
      text: new TextDecoder("utf-8").decode(bytes),
      bytes: offset,
    };
  } catch {
    // Unreadable, vanished, or link-replaced files are skipped; a content
    // search never fails the whole project because of one entry.
    return { status: "skipped", bytes: 0 };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Appends one match per matching line, counting lines exactly like the
 * preview (split on "\n", trailing "\r" removed). Returns "capped" when a
 * further match exists beyond `maxResults`.
 */
export function appendContentMatches(
  text: string,
  projectPath: string,
  pattern: RegExp,
  matches: WorkspaceContentMatch[],
  maxResults: number,
): "complete" | "capped" {
  pattern.lastIndex = 0;
  let lineNumber = 1;
  let countedTo = 0;
  for (;;) {
    const match = pattern.exec(text);
    if (!match) return "complete";
    if (matches.length >= maxResults) return "capped";
    for (
      let newline = text.indexOf("\n", countedTo);
      newline !== -1 && newline < match.index;
      newline = text.indexOf("\n", newline + 1)
    ) {
      lineNumber += 1;
      countedTo = newline + 1;
    }
    const lineStart = countedTo;
    const newline = text.indexOf("\n", match.index);
    const lineEnd = newline === -1 ? text.length : newline;
    const rawLine = text.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const column = match.index - lineStart;
    matches.push({
      projectPath,
      line: lineNumber,
      column: column + 1,
      snippet: contentSnippet(line, column, match[0].length),
    });
    if (newline === -1) return "complete";
    // One result per line: continue on the next line.
    pattern.lastIndex = newline + 1;
  }
}
