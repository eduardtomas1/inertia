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

export function encodeTurnDiffCursor(turnId: string, index: number): string {
  return Buffer.from(JSON.stringify({ v: 1, t: turnId, i: index }), "utf8").toString("base64url");
}

export function decodeTurnDiffCursor(cursor: string, turnId: string): number {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TurnDiffCursorError("The cursor is not one this tool returned. Call it again without a cursor.");
  }
  const value = decoded as { v?: unknown; t?: unknown; i?: unknown } | null;
  if (
    !value
    || value.v !== 1
    || typeof value.i !== "number"
    || !Number.isSafeInteger(value.i)
    || value.i < 1
    || value.i > MAX_CURSOR_INDEX
  ) {
    throw new TurnDiffCursorError("The cursor is not one this tool returned. Call it again without a cursor.");
  }
  if (value.t !== turnId) {
    throw new TurnDiffCursorError("The cursor belongs to another turn. Pass the turnId it was returned for, or omit the cursor.");
  }
  return value.i;
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
  const start = input.cursor === undefined ? 0 : decodeTurnDiffCursor(input.cursor, input.turnId);
  if (start > input.files.length || (start === input.files.length && start > 0)) {
    throw new TurnDiffCursorError("The cursor is past the end of this turn's changes. Call the tool again without a cursor.");
  }
  const sections = input.patch === null ? new Map<string, DiffSection>() : patchSections(input.patch);
  const page: TurnDiffPageFile[] = [];
  const result = (files: TurnDiffPageFile[], next: number | null) => ({
    turnId: input.turnId,
    state: input.state,
    totalFiles: input.files.length,
    firstFile: start,
    files,
    patchAvailable: input.patch !== null,
    ...(input.patchNote ? { patchNote: input.patchNote } : {}),
    captureTruncated: input.captureTruncated,
    nextCursor: next === null ? null : encodeTurnDiffCursor(input.turnId, next),
  });
  // Measure with a cursor of the longest possible length.
  const measure = (files: TurnDiffPageFile[]) => jsonBytes(result(files, MAX_CURSOR_INDEX));
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
  return result(page, index < input.files.length ? index : null);
}
