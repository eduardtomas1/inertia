import { realpath } from "node:fs/promises";

import {
  GIT_HISTORY_LIMITS,
  type GitLogCommit,
  type GitLogPage,
} from "../../shared/contracts/git-history";
import { literalPathspecs, validatedEntryPaths } from "./paths";
import {
  runGitInspection,
  type GitProcessResult,
  type RunGitInspectionOptions,
} from "./runner";
import { GitError } from "./types";

/** Per-invocation clock for history inspections; the caller's deadline still applies. */
export const GIT_HISTORY_TIMEOUT_MS = 5_000;
/** Log output is truncated here; only complete records are returned. */
export const GIT_LOG_OUTPUT_BYTES = 2 * 1024 * 1024;

export type GitHistoryRunner = (
  cwd: string,
  args: readonly string[],
  options: RunGitInspectionOptions,
) => Promise<GitProcessResult>;

export interface GitHistoryOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
  /** Test seam; production uses the bounded inspection runner. */
  runner?: GitHistoryRunner;
}

export interface GitLogOptions extends GitHistoryOptions {
  cursor?: string;
  limit?: number;
  path?: string;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const HISTORY_CHANGED = "The history changed while it was being read. Reload the history.";
const OUTPUT_LIMIT = "This commit is too large to list in the history view.";
const LOG_FIELDS = 6;
const LOG_FORMAT = ["%H", "%h", "%P", "%an", "%aI", "%s"].join("%x00");

interface LogCursor {
  head: string;
  skip: number;
  last: string;
}

export function historyRunOptions(
  options: GitHistoryOptions,
  extra: Omit<RunGitInspectionOptions, "deadlineAt" | "signal" | "timeoutMs">,
): RunGitInspectionOptions {
  return {
    timeoutMs: GIT_HISTORY_TIMEOUT_MS,
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...extra,
  };
}

export function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

export function encodeLogCursor(cursor: LogCursor): string {
  return Buffer.from(`v1:${cursor.head}:${cursor.skip}:${cursor.last}`, "utf8")
    .toString("base64url");
}

export function decodeLogCursor(value: string): LogCursor {
  const invalid = new GitError("invalid-input", "The history position is invalid. Reload the history.");
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(value)) throw invalid;
  const parts = Buffer.from(value, "base64url").toString("utf8").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw invalid;
  const [, head = "", skipText = "", last = ""] = parts;
  const skip = Number(skipText);
  if (
    !FULL_SHA.test(head)
    || !FULL_SHA.test(last)
    || !/^[1-9][0-9]{0,8}$/u.test(skipText)
    || !Number.isSafeInteger(skip)
  ) throw invalid;
  return { head, skip, last };
}

/** Splits NUL-separated output into complete fields, dropping a truncated tail. */
export function completeNulFields(output: Buffer): string[] {
  const text = output.toString("utf8");
  const fields = text.split("\0");
  // The final element follows the last NUL: empty for complete output,
  // otherwise a field cut by the output bound.
  fields.pop();
  return fields;
}

export function parseLogRecords(output: Buffer): GitLogCommit[] {
  const fields = completeNulFields(output);
  const commits: GitLogCommit[] = [];
  for (let index = 0; index + LOG_FIELDS <= fields.length; index += LOG_FIELDS) {
    const [rawSha = "", shortSha = "", parentText = "", authorName = "", authorDate = "", subject = ""] =
      fields.slice(index, index + LOG_FIELDS);
    const sha = rawSha.replace(/^\n/u, "");
    const parents = parentText ? parentText.split(" ") : [];
    if (
      !FULL_SHA.test(sha)
      || !/^[0-9a-f]{4,64}$/u.test(shortSha)
      || parents.some((parent) => !FULL_SHA.test(parent))
      || !Number.isFinite(Date.parse(authorDate))
    ) {
      throw new GitError("operation-failed", "Git returned unreadable history.");
    }
    commits.push({
      sha,
      shortSha,
      subject: boundedText(subject, GIT_HISTORY_LIMITS.subjectCharacters),
      authorName: boundedText(authorName, GIT_HISTORY_LIMITS.authorNameCharacters),
      authorDate,
      parents,
      isMerge: parents.length > 1,
    });
  }
  return commits;
}

async function resolveHead(
  root: string,
  run: GitHistoryRunner,
  options: GitHistoryOptions,
): Promise<string | null> {
  try {
    const result = await run(
      root,
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      historyRunOptions(options, {
        maxOutputBytes: 1_024,
        failureMessage: "Unable to read the current branch.",
      }),
    );
    const head = result.stdout.toString("utf8").trim();
    if (!FULL_SHA.test(head)) {
      throw new GitError("operation-failed", "Git returned an unreadable commit.");
    }
    return head;
  } catch (error) {
    // An unborn branch has no history; `--quiet` exits 1 without output.
    if (error instanceof GitError && error.code === "operation-failed" && error.exitCode === 1) {
      return null;
    }
    throw error;
  }
}

/** Canonical repository root used for containment; callers pass a resolved scope. */
export async function canonicalHistoryRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    throw new GitError("not-found", "The repository folder could not be found.");
  }
}

/**
 * Reads one page of first-parent-agnostic commit history for the current
 * branch, or for one path. The first page anchors the walk at HEAD; later
 * pages reuse that anchor with a skip count, so a moving branch cannot shift
 * or duplicate entries. The previous page's last commit is re-read and
 * compared, so a rewritten anchor is reported instead of silently skipped.
 */
export async function readGitLog(
  root: string,
  options: GitLogOptions = {},
): Promise<GitLogPage> {
  const run = options.runner ?? runGitInspection;
  const limit = options.limit ?? GIT_HISTORY_LIMITS.logPageDefault;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GIT_HISTORY_LIMITS.logPageMax) {
    throw new GitError("invalid-input", "The requested history page size is invalid.");
  }
  const canonicalRoot = await canonicalHistoryRoot(root);
  const path = options.path === undefined
    ? null
    : (await validatedEntryPaths(canonicalRoot, [options.path], options))[0] ?? null;
  const cursor = options.cursor ? decodeLogCursor(options.cursor) : null;
  const head = cursor?.head ?? await resolveHead(canonicalRoot, run, options);
  if (!head) return { head: null, path, commits: [], nextCursor: null };

  // Re-read the previous page's last commit as a continuity check.
  const skip = cursor ? cursor.skip - 1 : 0;
  const count = limit + 1 + (cursor ? 1 : 0);
  const result = await run(
    canonicalRoot,
    [
      "log",
      "-z",
      "--no-color",
      "--no-show-signature",
      "--encoding=UTF-8",
      `--format=${LOG_FORMAT}`,
      `--max-count=${count}`,
      ...(skip > 0 ? [`--skip=${skip}`] : []),
      head,
      "--",
      ...(path ? literalPathspecs([path]) : []),
    ],
    historyRunOptions(options, {
      maxOutputBytes: GIT_LOG_OUTPUT_BYTES,
      truncateOutput: true,
      failureMessage: "Unable to read the commit history.",
    }),
  ).catch((error: unknown) => {
    // A continuation anchored to a commit this repository no longer has
    // cannot be resumed; the first page re-anchors at the current branch.
    if (
      cursor
      && error instanceof GitError
      && error.code === "operation-failed"
      && error.exitCode === 128
    ) {
      throw new GitError("conflict", HISTORY_CHANGED);
    }
    throw error;
  });
  let commits = parseLogRecords(result.stdout);
  // Check the output bound first: a cut-off page that holds no complete
  // record says nothing about whether the history changed.
  if (result.truncated && commits.length === 0) {
    throw new GitError("output-limit", OUTPUT_LIMIT);
  }
  if (cursor) {
    if (commits[0]?.sha !== cursor.last) {
      throw new GitError("conflict", HISTORY_CHANGED);
    }
    commits = commits.slice(1);
  }
  if (result.truncated && commits.length === 0) {
    throw new GitError("output-limit", OUTPUT_LIMIT);
  }
  // A truncated read returns only complete records and always offers more.
  const hasMore = commits.length > limit || result.truncated;
  const page = commits.slice(0, limit);
  const last = page.at(-1);
  const consumed = (cursor?.skip ?? 0) + page.length;
  return {
    head,
    path,
    commits: page,
    nextCursor: hasMore && last
      ? encodeLogCursor({ head, skip: consumed, last: last.sha })
      : null,
  };
}
