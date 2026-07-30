import { DEFAULT_OUTPUT_BYTES } from "./constants";
import { repositoryRoot } from "./paths";
import { runGitInspection } from "./runner";
import {
  GitError,
  type GitChangedFile,
  type GitFileStatus,
  type GitRepositoryStatus,
} from "./types";

interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
  truncated: boolean;
}

function primaryStatus(
  indexStatus: string,
  worktreeStatus: string,
): GitFileStatus {
  const codes = `${indexStatus}${worktreeStatus}`;
  if (codes.includes("U") || codes === "AA" || codes === "DD") {
    return "unmerged";
  }
  if (codes.includes("R")) return "renamed";
  if (codes.includes("C")) return "copied";
  if (codes.includes("A") || codes.includes("?")) {
    return codes.includes("?") ? "untracked" : "added";
  }
  if (codes.includes("D")) return "deleted";
  if (codes.includes("T")) return "type-changed";
  if (codes.includes("M")) return "modified";
  return "unknown";
}

function changedFile(
  path: string,
  indexStatus: string,
  worktreeStatus: string,
  previousPath: string | null,
): GitChangedFile {
  return {
    path,
    previousPath,
    status: primaryStatus(indexStatus, worktreeStatus),
    indexStatus,
    worktreeStatus,
    staged: indexStatus !== "." && indexStatus !== " " && indexStatus !== "?",
    unstaged: worktreeStatus !== "." && worktreeStatus !== " ",
    insertions: 0,
    deletions: 0,
    binary: false,
  };
}

function parsePorcelain(buffer: Buffer): ParsedStatus {
  const fields = buffer.toString("utf8").split("\0");
  const files: GitChangedFile[] = [];
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      const head = record.slice(14);
      detached = head === "(detached)";
      branch = detached || head === "(unknown)" ? null : head;
    } else if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice(18) || null;
    } else if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (record.startsWith("1 ") || record.startsWith("u ")) {
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(record.startsWith("u ") ? 10 : 8).join(" ");
      if (path) {
        files.push(changedFile(path, xy[0] ?? ".", xy[1] ?? ".", null));
      }
    } else if (record.startsWith("2 ")) {
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(9).join(" ");
      const previousPath = fields[index + 1] ?? null;
      index += 1;
      if (path) {
        files.push(
          changedFile(path, xy[0] ?? ".", xy[1] ?? ".", previousPath),
        );
      }
    } else if (record.startsWith("? ")) {
      files.push(changedFile(record.slice(2), "?", "?", null));
    }
  }
  return {
    branch,
    detached,
    upstream,
    ahead,
    behind,
    files,
    truncated: false,
  };
}

export function parseNumstat(
  buffer: Buffer,
): Map<string, { insertions: number; deletions: number; binary: boolean }> {
  const values = buffer.toString("utf8").split("\0");
  const result = new Map<
    string,
    { insertions: number; deletions: number; binary: boolean }
  >();
  for (let index = 0; index < values.length; index += 1) {
    const record = values[index];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (!path) {
      index += 2;
      path = values[index] ?? "";
    }
    if (!path) continue;
    const binary = added === "-" || deleted === "-";
    result.set(path, {
      insertions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      binary,
    });
  }
  return result;
}

export interface GitStatusOptions {
  deadlineAt?: number;
}

export async function hasHead(
  root: string,
  options: GitStatusOptions = {},
): Promise<boolean> {
  try {
    await runGitInspection(root, ["rev-parse", "--verify", "HEAD"], {
      deadlineAt: options.deadlineAt,
      maxOutputBytes: 256,
      failureMessage: "Unable to inspect the current commit.",
    });
    return true;
  } catch (error) {
    if (error instanceof GitError && error.code === "operation-failed") {
      return false;
    }
    throw error;
  }
}

export async function getRepositoryStatus(
  repositoryPath: string,
  options: GitStatusOptions = {},
): Promise<GitRepositoryStatus> {
  const root = await repositoryRoot(repositoryPath, options);
  const statusResult = await runGitInspection(
    root,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    {
      deadlineAt: options.deadlineAt,
      maxOutputBytes: DEFAULT_OUTPUT_BYTES,
      truncateOutput: true,
      failureMessage: "Unable to read the repository status.",
    },
  );
  const parsed = parsePorcelain(statusResult.stdout);
  const statsResult = await runGitInspection(
    root,
    (await hasHead(root, options))
      ? [
          "diff",
          "--numstat",
          "-z",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
          "--",
        ]
      : [
          "diff",
          "--numstat",
          "-z",
          "--no-ext-diff",
          "--no-textconv",
          "--cached",
          "--",
        ],
    {
      deadlineAt: options.deadlineAt,
      maxOutputBytes: DEFAULT_OUTPUT_BYTES,
      truncateOutput: true,
      failureMessage: "Unable to calculate repository change totals.",
    },
  );
  const stats = parseNumstat(statsResult.stdout);
  for (const file of parsed.files) {
    const values = stats.get(file.path);
    if (values) Object.assign(file, values);
  }
  return {
    root,
    branch: parsed.branch,
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    files: parsed.files,
    insertions: parsed.files.reduce(
      (total, file) => total + file.insertions,
      0,
    ),
    deletions: parsed.files.reduce(
      (total, file) => total + file.deletions,
      0,
    ),
    clean: parsed.files.length === 0,
    truncated:
      parsed.truncated || statusResult.truncated || statsResult.truncated,
  };
}

export function refreshRepositoryStatus(
  repositoryPath: string,
): Promise<GitRepositoryStatus> {
  return getRepositoryStatus(repositoryPath);
}
