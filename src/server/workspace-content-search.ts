import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

import { FILE_OPEN_NO_FOLLOW } from "../node/platform-file-open-flags";
import {
  WORKSPACE_CONTENT_SEARCH_LIMITS,
  type WorkspaceContentMatch,
} from "../shared/contracts/workspace";
import type { WorkspaceEntryIdentity } from "./workspace-traversal";

export const WORKSPACE_CONTENT_READ_CONCURRENCY = 8;

const utf8Decoder = new TextDecoder("utf-8");
const contentMatchPathCollator = new Intl.Collator("en", { numeric: true });

export function compareContentMatches(
  left: WorkspaceContentMatch,
  right: WorkspaceContentMatch,
): number {
  return contentMatchPathCollator.compare(left.projectPath, right.projectPath)
    || left.line - right.line;
}

function sameIdentity(
  left: WorkspaceEntryIdentity,
  right: WorkspaceEntryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export type SearchableFileRead =
  | { status: "text"; text: string; bytes: number }
  | { status: "skipped"; bytes: number }
  | { status: "budget" };

export interface SearchableFileCandidate {
  absolute: string;
  projectPath: string;
  identity: WorkspaceEntryIdentity;
  estimatedSize: number;
}

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
  openFile: typeof open = open,
): Promise<SearchableFileRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let offset = 0;
  try {
    handle = await openFile(absolute, fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
    const info = await handle.stat();
    // The opened inode must be the entry described inside its stable,
    // contained parent; a swapped link or replaced file is skipped.
    if (!info.isFile() || !sameIdentity(identity, info)) {
      return { status: "skipped", bytes: 0 };
    }
    if (info.size > maxFileBytes) return { status: "skipped", bytes: 0 };
    if (info.size > remainingBytes) return { status: "budget" };
    const sniffBytes = WORKSPACE_CONTENT_SEARCH_LIMITS.binarySniffBytes;
    const boundedSize = Math.min(info.size, maxFileBytes);
    // Cap the allocation at remainingBytes so the +1 growth probe never reads
    // past the physical I/O budget; when no probe byte fits, re-stat after read.
    const bufferLength = Math.min(boundedSize + 1, remainingBytes);
    const buffer = Buffer.allocUnsafe(bufferLength);
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
    if (bufferLength === info.size && offset === info.size) {
      const after = await handle.stat();
      if (!after.isFile() || !sameIdentity(identity, after) || after.size > info.size) {
        return { status: "skipped", bytes: offset };
      }
    }
    const bytes = buffer.subarray(0, offset);
    if (!sniffed && bytes.subarray(0, sniffBytes).includes(0)) {
      return { status: "skipped", bytes: offset };
    }
    return {
      status: "text",
      text: utf8Decoder.decode(bytes),
      bytes: offset,
    };
  } catch {
    // Unreadable, vanished, or link-replaced files are skipped; a content
    // search never fails the whole project because of one entry. Preserve any
    // physical bytes already read before the failure so budget accounting stays exact.
    return { status: "skipped", bytes: offset };
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

/**
 * Reads described candidate files in bounded concurrent waves and commits
 * byte accounting and matches strictly in deterministic candidate order.
 */
export async function searchCandidateFilesInWaves(
  candidates: readonly SearchableFileCandidate[],
  options: {
    concurrency: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    bytesRead: number;
    pattern: RegExp;
    matches: WorkspaceContentMatch[];
    maxResults: number;
    deadline: number;
    now: () => number;
    signal?: AbortSignal;
    onCancelled: () => never;
    openFile?: typeof open;
  },
): Promise<{
  bytesRead: number;
  filesSearched: number;
  truncated: boolean;
  stopped: boolean;
}> {
  const openFile = options.openFile ?? open;
  let physicalBytesRead = options.bytesRead;
  let filesSearched = 0;
  let index = 0;

  while (index < candidates.length) {
    if (options.signal?.aborted) options.onCancelled();
    if (options.now() > options.deadline || options.matches.length >= options.maxResults) {
      return { bytesRead: physicalBytesRead, filesSearched, truncated: true, stopped: true };
    }
    const remaining = options.maxTotalBytes - physicalBytesRead;
    const wave: Array<{ candidate: SearchableFileCandidate; hardLimit: number }> = [];
    let reserved = 0;
    while (index < candidates.length && wave.length < options.concurrency) {
      const candidate = candidates[index]!;
      const required = candidate.estimatedSize;
      if (wave.length > 0 && reserved + required > remaining) break;
      const hardLimit = Math.max(0, Math.min(required, remaining - reserved));
      wave.push({ candidate, hardLimit });
      reserved += hardLimit;
      index += 1;
    }
    const reads = wave.length === 1
      ? [await readSearchableFile(wave[0]!.candidate.absolute, wave[0]!.candidate.identity, options.maxFileBytes, Math.max(0, remaining), openFile)]
      : await Promise.all(wave.map(({ candidate, hardLimit }) =>
          readSearchableFile(candidate.absolute, candidate.identity, options.maxFileBytes, hardLimit, openFile)));
    for (const read of reads) {
      if (read.status !== "budget") physicalBytesRead += read.bytes;
    }
    for (let i = 0; i < reads.length; i += 1) {
      if (options.signal?.aborted) options.onCancelled();
      if (options.now() > options.deadline) {
        return { bytesRead: physicalBytesRead, filesSearched, truncated: true, stopped: true };
      }
      let read = reads[i]!;
      const { candidate, hardLimit } = wave[i]!;
      const retryBudget = options.maxTotalBytes - physicalBytesRead;
      if (
        wave.length > 1
        && read.status === "budget"
        && retryBudget > hardLimit
      ) {
        // The file grew past its pre-reserved slice; retry sequentially with the
        // remaining physical I/O budget so concurrent reads already completed in
        // this wave are counted and total physical reads never exceed maxTotalBytes.
        read = await readSearchableFile(
          candidate.absolute,
          candidate.identity,
          options.maxFileBytes,
          retryBudget,
          openFile,
        );
        if (read.status !== "budget") physicalBytesRead += read.bytes;
      }
      if (read.status === "budget") {
        return { bytesRead: physicalBytesRead, filesSearched, truncated: true, stopped: true };
      }
      if (read.status !== "text") continue;
      filesSearched += 1;
      if (
        appendContentMatches(
          read.text,
          candidate.projectPath,
          options.pattern,
          options.matches,
          options.maxResults,
        ) === "capped"
      ) {
        return { bytesRead: physicalBytesRead, filesSearched, truncated: true, stopped: true };
      }
    }
  }
  return { bytesRead: physicalBytesRead, filesSearched, truncated: false, stopped: false };
}
