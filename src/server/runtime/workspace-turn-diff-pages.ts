import { createHash } from "node:crypto";

import type { TurnGitArtifactFile } from "../../shared/contracts";
import { parseUnifiedDiff } from "../../shared/diff-review";
import {
  jsonBytes,
  workspaceLabel,
  workspaceText,
  type WorkspaceTextScope,
} from "./workspace-host-tool-text";

/** Diff text one `inertia_turn_diff` result carries, before JSON encoding. */
export const MAX_TURN_DIFF_PAGE_BYTES = 24 * 1024;
/** Whole encoded result, under the 32 KiB host-tool result cap. */
export const MAX_WORKSPACE_RESULT_BYTES = 31 * 1024;
const MAX_FILES_PER_PAGE = 100;
const MAX_PATH_BYTES = 1_024;
const MAX_CURSOR_INDEX = 100_000;
const CURSOR_VERSION = 2;
const DIGEST_LENGTH = 22;

export class TurnDiffCursorError extends Error {}

interface DiffSection {
  path: string;
  oldPath: string;
  binary: boolean;
  text: string;
}

export interface TurnDiffPageInput {
  turnId: string;
  state: "live" | "settled";
  files: readonly TurnGitArtifactFile[];
  /** Null when the stored patch is unavailable; files are still listed. */
  patch: string | null;
  patchNote: string | null;
  /** The capture itself reached a size limit. */
  captureTruncated: boolean;
  cursor: string | undefined;
  scope: WorkspaceTextScope;
}

export interface TurnDiffPageFile {
  path: string;
  previousPath: string | null;
  status: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  /** Unified diff text for this file; null for binary files or a missing patch. */
  diff: string | null;
  diffTruncated: boolean;
}

/**
 * Where the next page starts. A live turn's file list can change between
 * calls, so the cursor names the list it paged (`d`) and the last file it
 * returned (`p`), both as digests, besides that file's position (`i`).
 */
export interface TurnDiffCursor {
  turnId: string;
  listDigest: string;
  lastPathDigest: string;
  index: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url").slice(0, DIGEST_LENGTH);
}

/** Digest of the file list's paths in order; insertion counts do not move a page. */
export function turnDiffListDigest(files: readonly TurnGitArtifactFile[]): string {
  return digest(JSON.stringify(files.map(({ path, previousPath }) => [path, previousPath])));
}

export function encodeTurnDiffCursor(cursor: TurnDiffCursor): string {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    t: cursor.turnId,
    d: cursor.listDigest,
    p: cursor.lastPathDigest,
    i: cursor.index,
  }), "utf8").toString("base64url");
}

const NOT_A_CURSOR = "The cursor is not one this tool returned. Call it again without a cursor.";

export function decodeTurnDiffCursor(cursor: string, turnId: string): TurnDiffCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TurnDiffCursorError(NOT_A_CURSOR);
  }
  const value = decoded as { v?: unknown; t?: unknown; d?: unknown; p?: unknown; i?: unknown } | null;
  const isDigest = (part: unknown): part is string =>
    typeof part === "string" && part.length === DIGEST_LENGTH && /^[\w-]+$/u.test(part);
  if (
    !value
    || value.v !== CURSOR_VERSION
    || typeof value.i !== "number"
    || !Number.isSafeInteger(value.i)
    || value.i < 1
    || value.i > MAX_CURSOR_INDEX
    || !isDigest(value.d)
    || !isDigest(value.p)
  ) {
    throw new TurnDiffCursorError(NOT_A_CURSOR);
  }
  if (value.t !== turnId) {
    throw new TurnDiffCursorError("The cursor belongs to another turn. Pass the turnId it was returned for, or omit the cursor.");
  }
  return { turnId, listDigest: value.d, lastPathDigest: value.p, index: value.i };
}

/**
 * The first file of the requested page. When the list the cursor paged has
 * changed, or no longer holds the last file returned, paging restarts from
 * the first file instead of skipping or repeating files.
 */
function pageStart(
  cursor: string | undefined,
  turnId: string,
  files: readonly TurnGitArtifactFile[],
  listDigest: string,
): { start: number; restarted: boolean } {
  if (cursor === undefined) return { start: 0, restarted: false };
  const decoded = decodeTurnDiffCursor(cursor, turnId);
  if (decoded.listDigest !== listDigest) return { start: 0, restarted: true };
  const previous = files[decoded.index - 1];
  if (!previous || digest(previous.path) !== decoded.lastPathDigest || decoded.index >= files.length) {
    return { start: 0, restarted: true };
  }
  return { start: decoded.index, restarted: false };
}

/** Splits a unified patch into one section per `diff --git` header. */
function patchSections(patch: string): Map<string, DiffSection> {
  const sections = new Map<string, DiffSection>();
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.join("\n");
    current = [];
    const parsed = parseUnifiedDiff(text).files[0];
    if (!parsed) return;
    const path = parsed.newPath === "/dev/null" ? parsed.oldPath : parsed.path;
    sections.set(path, {
      path,
      oldPath: parsed.oldPath,
      binary: parsed.binary === true,
      text: text.endsWith("\n") ? text : `${text}\n`,
    });
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) flush();
    current.push(line);
  }
  flush();
  return sections;
}

function cutAtLine(text: string, maximumBytes: number, scope: WorkspaceTextScope): string {
  const bounded = workspaceText(text, maximumBytes, scope).text;
  const end = bounded.lastIndexOf("\n");
  return end >= bounded.length / 2 ? bounded.slice(0, end + 1) : bounded;
}

/**
 * One page of a turn's diff, by file. A page holds whole files while they
 * fit; a single file larger than the page is cut at a line boundary and
 * marked `diffTruncated`. Binary files are listed by name only.
 */
export function turnDiffPage(input: TurnDiffPageInput): Record<string, unknown> {
  const listDigest = turnDiffListDigest(input.files);
  const { start, restarted } = pageStart(input.cursor, input.turnId, input.files, listDigest);
  const sections = input.patch === null ? new Map<string, DiffSection>() : patchSections(input.patch);
  const page: TurnDiffPageFile[] = [];
  const cursorAfter = (index: number, lastPath: string) => encodeTurnDiffCursor({
    turnId: input.turnId,
    listDigest,
    lastPathDigest: digest(lastPath),
    index,
  });
  const result = (files: TurnDiffPageFile[], next: string | null) => ({
    turnId: input.turnId,
    state: input.state,
    totalFiles: input.files.length,
    firstFile: start,
    restarted,
    files,
    patchAvailable: input.patch !== null,
    ...(input.patchNote ? { patchNote: input.patchNote } : {}),
    captureTruncated: input.captureTruncated,
    nextCursor: next,
  });
  // Measure with a cursor of the longest possible length.
  const longestCursor = cursorAfter(MAX_CURSOR_INDEX, "");
  const measure = (files: TurnDiffPageFile[]) => jsonBytes(result(files, longestCursor));
  let diffBytes = 0;
  let index = start;
  for (; index < input.files.length && page.length < MAX_FILES_PER_PAGE; index += 1) {
    const file = input.files[index]!;
    const section = sections.get(file.path)
      ?? (file.previousPath ? sections.get(file.previousPath) : undefined);
    const binary = file.binary || section?.binary === true;
    const entry: TurnDiffPageFile = {
      path: workspaceLabel(file.path, MAX_PATH_BYTES, input.scope),
      previousPath: file.previousPath === null ? null : workspaceLabel(file.previousPath, MAX_PATH_BYTES, input.scope),
      status: file.status,
      insertions: file.insertions,
      deletions: file.deletions,
      binary,
      diff: null,
      diffTruncated: !binary && input.patch !== null && section === undefined,
    };
    if (!binary && section) {
      const full = workspaceText(section.text, Number.MAX_SAFE_INTEGER, input.scope).text;
      const fullBytes = Buffer.byteLength(full, "utf8");
      const remaining = MAX_TURN_DIFF_PAGE_BYTES - diffBytes;
      if (fullBytes > remaining && page.length > 0) break;
      entry.diff = fullBytes > remaining ? cutAtLine(section.text, remaining, input.scope) : full;
      entry.diffTruncated = fullBytes > remaining;
    }
    if (measure([...page, entry]) > MAX_WORKSPACE_RESULT_BYTES) {
      if (page.length > 0) break;
      // A lone file whose encoded diff is too large: shrink it until it fits.
      let budget = Buffer.byteLength(entry.diff ?? "", "utf8");
      while (entry.diff !== null && measure([entry]) > MAX_WORKSPACE_RESULT_BYTES) {
        budget -= measure([entry]) - MAX_WORKSPACE_RESULT_BYTES + 256;
        entry.diff = budget > 0 && section ? cutAtLine(section.text, budget, input.scope) : null;
        entry.diffTruncated = true;
      }
    }
    diffBytes += Buffer.byteLength(entry.diff ?? "", "utf8");
    page.push(entry);
  }
  return result(page, index < input.files.length && index > 0 ? cursorAfter(index, input.files[index - 1]!.path) : null);
}
