import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  GIT_HISTORY_LIMITS,
  type GitBlameLine,
  type GitBlamePage,
  type GitBlameState,
} from "../../shared/contracts/git-history";
import {
  boundedText,
  canonicalHistoryRoot,
  historyRunOptions,
  type GitHistoryOptions,
} from "./log";
import { isContained, literalPathspecs, validatedPaths } from "./paths";
import { runGitInspection } from "./runner";
import { GitError } from "./types";

/** Blame reads the working-tree file to count lines; larger files are not blamed. */
export const GIT_BLAME_MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Porcelain output is truncated here; only complete line entries are returned. */
export const GIT_BLAME_OUTPUT_BYTES = 8 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8_000;
const ZERO_SHA = /^0+$/u;
const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/u;

export interface GitBlameOptions extends GitHistoryOptions {
  path: string;
  startLine?: number;
  endLine?: number;
}

interface CommitHeader {
  authorName: string;
  authorTime: number | null;
  summary: string;
}

/**
 * Parses `git blame --porcelain`. Commit headers appear only the first time a
 * commit is seen, so headers are remembered by SHA. A line entry is complete
 * only once its TAB-prefixed content line is terminated by a newline, which
 * makes truncated output safe to parse.
 */
export function parseBlamePorcelain(output: Buffer): GitBlameLine[] {
  const text = output.toString("utf8");
  const end = text.lastIndexOf("\n");
  const rows = end < 0 ? [] : text.slice(0, end).split("\n");
  const commits = new Map<string, CommitHeader>();
  const lines: GitBlameLine[] = [];
  let current: { sha: string; line: number; header: CommitHeader } | null = null;
  for (const row of rows) {
    if (row.startsWith("\t")) {
      if (!current) throw new GitError("operation-failed", "Git returned unreadable blame output.");
      const { sha, line, header } = current;
      const uncommitted = ZERO_SHA.test(sha);
      lines.push({
        line,
        sha,
        shortSha: uncommitted ? "" : sha.slice(0, 7),
        authorName: uncommitted
          ? "Not committed"
          : boundedText(header.authorName, GIT_HISTORY_LIMITS.authorNameCharacters),
        authorDate: header.authorTime === null
          ? new Date(0).toISOString()
          : new Date(header.authorTime * 1_000).toISOString(),
        summary: uncommitted
          ? "Uncommitted change"
          : boundedText(header.summary, GIT_HISTORY_LIMITS.subjectCharacters),
        uncommitted,
      });
      current = null;
      continue;
    }
    const match = HEADER.exec(row);
    if (match) {
      const sha = match[1] ?? "";
      let header = commits.get(sha);
      if (!header) {
        header = { authorName: "", authorTime: null, summary: "" };
        commits.set(sha, header);
      }
      current = { sha, line: Number(match[3]), header };
      continue;
    }
    if (!current) continue;
    const space = row.indexOf(" ");
    const key = space < 0 ? row : row.slice(0, space);
    const value = space < 0 ? "" : row.slice(space + 1);
    // author-mail and committer fields are intentionally ignored.
    if (key === "author") current.header.authorName = value;
    else if (key === "author-time" && /^\d{1,12}$/u.test(value)) current.header.authorTime = Number(value);
    else if (key === "summary") current.header.summary = value;
  }
  return lines;
}

function emptyPage(
  path: string,
  state: GitBlameState,
  startLine: number,
  lineCount = 0,
): GitBlamePage {
  return {
    path,
    state,
    startLine,
    endLine: startLine - 1,
    lineCount,
    lines: [],
    nextStartLine: null,
  };
}

async function readCandidate(
  absolute: string,
): Promise<{ state: "ready"; lineCount: number } | { state: Exclude<GitBlameState, "ready" | "untracked"> }> {
  const info = await lstat(absolute).catch(() => null);
  if (!info) throw new GitError("not-found", "The file no longer exists.");
  if (info.isSymbolicLink() || !info.isFile() || info.size > GIT_BLAME_MAX_FILE_BYTES) {
    return { state: "unsupported" };
  }
  const handle = await open(absolute, "r");
  try {
    const content = await handle.readFile();
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { state: "binary" };
    let lineCount = 0;
    for (let index = content.indexOf(10); index >= 0; index = content.indexOf(10, index + 1)) {
      lineCount += 1;
    }
    if (content.length > 0 && content[content.length - 1] !== 10) lineCount += 1;
    return { state: "ready", lineCount };
  } finally {
    await handle.close();
  }
}

/**
 * Blames up to 2,000 lines of a working-tree file. The path must stay inside
 * the repository after realpath resolution (symbolic links cannot escape it);
 * untracked files return an empty "untracked" page rather than an error.
 */
export async function blameGitFile(
  root: string,
  options: GitBlameOptions,
): Promise<GitBlamePage> {
  const run = options.runner ?? runGitInspection;
  const startLine = options.startLine ?? 1;
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw new GitError("invalid-input", "The blame range is invalid.");
  }
  const requestedEnd = options.endLine ?? startLine + GIT_HISTORY_LIMITS.blameLinesPerPage - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < startLine) {
    throw new GitError("invalid-input", "The blame range is invalid.");
  }
  const canonicalRoot = await canonicalHistoryRoot(root);
  const [path] = await validatedPaths(canonicalRoot, [options.path], options);
  if (!path) throw new GitError("invalid-input", "A selected file path is invalid.");
  const absolute = join(canonicalRoot, path);
  // validatedPaths has already proved realpath containment; re-check the
  // resolved entry right before reading so a swapped link is still refused.
  const resolved = await realpath(absolute).catch(() => {
    throw new GitError("not-found", "The file no longer exists.");
  });
  if (!isContained(canonicalRoot, resolved)) {
    throw new GitError("invalid-input", "A selected file resolves outside the repository.");
  }

  const tracked = await run(
    canonicalRoot,
    ["ls-files", "-z", "--", ...literalPathspecs([path])],
    historyRunOptions(options, {
      maxOutputBytes: 64 * 1024,
      truncateOutput: true,
      failureMessage: "Unable to inspect this file in Git.",
    }),
  );
  if (tracked.stdout.length === 0) return emptyPage(path, "untracked", startLine);

  const candidate = await readCandidate(absolute);
  if (candidate.state !== "ready") return emptyPage(path, candidate.state, startLine);
  const { lineCount } = candidate;
  const endLine = Math.min(
    requestedEnd,
    startLine + GIT_HISTORY_LIMITS.blameLinesPerPage - 1,
    lineCount,
  );
  if (lineCount === 0 || startLine > lineCount) {
    return emptyPage(path, "ready", startLine, lineCount);
  }
  const result = await run(
    canonicalRoot,
    [
      "blame",
      "--porcelain",
      "--no-textconv",
      "--encoding=UTF-8",
      `-L${startLine},${endLine}`,
      "--",
      path,
    ],
    historyRunOptions(options, {
      maxOutputBytes: GIT_BLAME_OUTPUT_BYTES,
      truncateOutput: true,
      failureMessage: "Unable to read blame for this file.",
    }),
  );
  const lines = parseBlamePorcelain(result.stdout)
    .filter(({ line }) => line >= startLine && line <= endLine)
    .sort((left, right) => left.line - right.line);
  if (result.truncated && lines.length === 0) {
    throw new GitError("output-limit", "This file's lines are too long to blame here.");
  }
  const lastLine = result.truncated ? (lines.at(-1)?.line ?? startLine - 1) : endLine;
  return {
    path,
    state: "ready",
    startLine,
    endLine: lastLine,
    lineCount,
    lines,
    nextStartLine: lastLine < lineCount ? lastLine + 1 : null,
  };
}
