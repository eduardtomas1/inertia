import { MAX_WORKTREE_STATUS_ENTRIES } from "../../shared/worktrees";
import { MAX_PATH_LENGTH } from "./constants";
import { validateBranch } from "./paths";
import { runGit, runGitInspection } from "./runner";
import { requireGitWorktreeSupport } from "./worktree-support";
import { GitError } from "./types";

/** Every inventory inspection is a short local read. */
export const WORKTREE_INSPECTION_TIMEOUT_MS = 5_000;
const MAX_WORKTREE_LIST_BYTES = 1024 * 1024;
const MAX_WORKTREE_STATUS_BYTES = 512 * 1024;
const OBJECT_ID = /^[0-9a-f]{40,64}$/u;

export interface GitWorktreeRecord {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface GitWorktreeInventory {
  worktrees: GitWorktreeRecord[];
  truncated: boolean;
}

export interface GitWorktreeChanges {
  /** Modified, staged or untracked entries; null when Git could not tell. */
  dirty: boolean | null;
  changeCount: number | null;
  truncated: boolean;
  /** Ignored entries that `git worktree remove` would delete with the folder. */
  ignored: boolean | null;
}

/** Parses `git worktree list --porcelain -z`; the first record is the main worktree. */
export function parseWorktreeListPorcelain(
  output: string,
  limit: number,
): GitWorktreeInventory {
  const worktrees: GitWorktreeRecord[] = [];
  let truncated = false;
  let current: GitWorktreeRecord | null = null;
  const flush = (): void => {
    if (!current) return;
    if (worktrees.length >= limit) truncated = true;
    else worktrees.push(current);
    current = null;
  };
  for (const field of output.split("\0")) {
    if (field === "") {
      flush();
      continue;
    }
    if (field.startsWith("worktree ")) {
      flush();
      const path = field.slice("worktree ".length);
      if (!path || path.length > MAX_PATH_LENGTH) {
        throw new GitError("operation-failed", "Git returned an invalid worktree path.");
      }
      current = {
        path,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        isMain: worktrees.length === 0 && !truncated,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    const record: GitWorktreeRecord = current;
    if (field.startsWith("HEAD ")) {
      const head = field.slice(5);
      record.head = OBJECT_ID.test(head) ? head : null;
    } else if (field.startsWith("branch refs/heads/")) {
      record.branch = field.slice("branch refs/heads/".length) || null;
    } else if (field === "detached") {
      record.detached = true;
    } else if (field === "bare") {
      record.bare = true;
    } else if (field === "locked" || field.startsWith("locked ")) {
      record.locked = true;
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      record.prunable = true;
    }
  }
  flush();
  return { worktrees, truncated };
}

export async function listGitWorktrees(
  repositoryRootPath: string,
  limit: number,
): Promise<GitWorktreeInventory> {
  await requireGitWorktreeSupport(repositoryRootPath);
  const result = await runGitInspection(
    repositoryRootPath,
    ["worktree", "list", "--porcelain", "-z"],
    {
      timeoutMs: WORKTREE_INSPECTION_TIMEOUT_MS,
      maxOutputBytes: MAX_WORKTREE_LIST_BYTES,
      failureMessage: "Unable to list this repository's worktrees.",
    },
  );
  return parseWorktreeListPorcelain(result.stdout.toString("utf8"), limit);
}

/** Counts `git status --porcelain=v1 -z` entries up to the shared bound. */
export function parseWorktreeStatusPorcelain(
  output: string,
  outputTruncated: boolean,
): GitWorktreeChanges {
  const fields = output.split("\0");
  // A truncated stream may end inside a record, so drop the partial tail.
  if (outputTruncated) fields.pop();
  let changes = 0;
  let ignored = false;
  let truncated = outputTruncated;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    if (code === "!!") {
      ignored = true;
      continue;
    }
    if (code.includes("R") || code.includes("C")) index += 1;
    if (changes >= MAX_WORKTREE_STATUS_ENTRIES) {
      truncated = true;
      break;
    }
    changes += 1;
  }
  if (changes > 0) {
    return { dirty: true, changeCount: changes, truncated, ignored: ignored || (truncated ? null : false) };
  }
  if (truncated) return { dirty: null, changeCount: null, truncated, ignored: ignored || null };
  return { dirty: false, changeCount: 0, truncated: false, ignored };
}

export async function inspectWorktreeChanges(
  worktreePath: string,
  deadlineAt?: number,
): Promise<GitWorktreeChanges> {
  const result = await runGitInspection(
    worktreePath,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
      "--ignored=traditional",
      "--ignore-submodules=none",
    ],
    {
      timeoutMs: WORKTREE_INSPECTION_TIMEOUT_MS,
      deadlineAt,
      maxOutputBytes: MAX_WORKTREE_STATUS_BYTES,
      truncateOutput: true,
      failureMessage: "Unable to inspect this worktree's changes.",
    },
  );
  return parseWorktreeStatusPorcelain(
    result.stdout.toString("utf8"),
    result.truncated,
  );
}

/** Never forced: Git itself refuses locked worktrees and unclean files. */
export async function removeRegisteredWorktree(
  repositoryRootPath: string,
  registeredPath: string,
): Promise<void> {
  await runGit(
    repositoryRootPath,
    ["worktree", "remove", "--", registeredPath],
    { failureMessage: "Git refused to remove the worktree. Its files were kept." },
  );
}

/**
 * Deletes a generated branch only when its tip is already contained in the
 * source branch. `git branch -d` repeats Git's own merge check; `-D` is never used.
 */
export async function deleteMergedBranch(
  repositoryRootPath: string,
  branchName: string,
  sourceBranchName: string,
): Promise<boolean> {
  const branch = await validateBranch(repositoryRootPath, branchName);
  const source = await validateBranch(repositoryRootPath, sourceBranchName);
  if (branch === source) return false;
  const ref = `refs/heads/${branch}`;
  const merged = await runGitInspection(
    repositoryRootPath,
    ["for-each-ref", `--merged=refs/heads/${source}`, "--format=%(refname)", ref],
    {
      timeoutMs: WORKTREE_INSPECTION_TIMEOUT_MS,
      maxOutputBytes: MAX_PATH_LENGTH,
      failureMessage: "Unable to inspect whether the worktree branch is merged.",
    },
  );
  if (!merged.stdout.toString("utf8").split("\n").includes(ref)) return false;
  try {
    await runGit(
      repositoryRootPath,
      ["branch", "-d", "--", branch],
      { timeoutMs: WORKTREE_INSPECTION_TIMEOUT_MS, failureMessage: "Git kept the worktree branch." },
    );
  } catch {
    return false;
  }
  return true;
}

/** Removes administrative entries for worktrees whose folders are gone. */
export async function pruneWorktreeMetadata(
  repositoryRootPath: string,
): Promise<void> {
  await requireGitWorktreeSupport(repositoryRootPath);
  await runGit(
    repositoryRootPath,
    ["worktree", "prune"],
    {
      timeoutMs: WORKTREE_INSPECTION_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      failureMessage: "Unable to prune stale worktree entries.",
    },
  );
}
