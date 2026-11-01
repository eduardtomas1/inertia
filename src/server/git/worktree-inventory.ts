import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

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
/** `git ls-files -v` lists every tracked file; larger indexes stay unconfirmed. */
const MAX_WORKTREE_INDEX_LISTING_BYTES = 32 * 1024 * 1024;
/** Skip-worktree entries checked on disk before the answer becomes unknown. */
const MAX_SKIP_WORKTREE_PROBES = 2_000;
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
  /**
   * Tracked files marked assume-unchanged, or skip-worktree files present on
   * disk. Status cannot see their edits, so removal could delete them. Null
   * when Git could not tell or when other changes already block removal.
   */
  hiddenEdits?: boolean | null;
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
  inspectHiddenEdits = true,
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
  const changes = parseWorktreeStatusPorcelain(
    result.stdout.toString("utf8"),
    result.truncated,
  );
  // Only a worktree that is otherwise removable needs the full index listing.
  if (!inspectHiddenEdits || changes.dirty !== false || changes.ignored !== false) {
    return changes;
  }
  return {
    ...changes,
    hiddenEdits: await inspectHiddenWorktreeEdits(worktreePath, deadlineAt)
      .catch(() => null),
  };
}

/**
 * Parses `git ls-files -v -z`. A lowercase tag marks an assume-unchanged
 * entry; `S` marks a skip-worktree entry, which only matters when its file is
 * on disk. Reports whether any assume-unchanged entry exists and lists the
 * skip-worktree paths that still need a disk check.
 */
export function parseIndexFlagListing(
  output: string,
  outputTruncated: boolean,
): { assumeUnchanged: boolean; skipWorktree: string[]; truncated: boolean } {
  const fields = output.split("\0");
  // The final element follows the last NUL: empty for complete output.
  fields.pop();
  const skipWorktree: string[] = [];
  for (const field of fields) {
    if (field.length < 3 || field[1] !== " ") continue;
    const tag = field[0]!;
    if (tag !== tag.toUpperCase()) {
      return { assumeUnchanged: true, skipWorktree, truncated: outputTruncated };
    }
    if (tag === "S") skipWorktree.push(field.slice(2));
  }
  return { assumeUnchanged: false, skipWorktree, truncated: outputTruncated };
}

async function inspectHiddenWorktreeEdits(
  worktreePath: string,
  deadlineAt?: number,
): Promise<boolean | null> {
  const result = await runGitInspection(
    worktreePath,
    ["ls-files", "-v", "-z"],
    {
      timeoutMs: WORKTREE_INSPECTION_TIMEOUT_MS,
      deadlineAt,
      maxOutputBytes: MAX_WORKTREE_INDEX_LISTING_BYTES,
      truncateOutput: true,
      failureMessage: "Unable to inspect this worktree's index.",
    },
  );
  const listing = parseIndexFlagListing(
    result.stdout.toString("utf8"),
    result.truncated,
  );
  if (listing.assumeUnchanged) return true;
  if (listing.truncated || listing.skipWorktree.length > MAX_SKIP_WORKTREE_PROBES) {
    return null;
  }
  for (const path of listing.skipWorktree) {
    const target = join(worktreePath, path);
    const child = relative(worktreePath, target);
    if (child === "" || isAbsolute(child) || child.split(sep)[0] === "..") return null;
    const present = await lstat(target).then(() => true, (error: unknown) =>
      error && typeof error === "object" && "code" in error
        && (error.code === "ENOENT" || error.code === "ENOTDIR")
        ? false
        : null);
    if (present !== false) return present;
  }
  return false;
}

/**
 * Never forced: Git itself refuses locked worktrees and unclean files. A
 * failure does not prove the folder is intact; Git may already have deleted
 * part of it (for example when a file is held open on Windows), so the
 * caller re-inspects before describing what is left.
 */
export async function removeRegisteredWorktree(
  repositoryRootPath: string,
  registeredPath: string,
): Promise<void> {
  await runGit(
    repositoryRootPath,
    ["worktree", "remove", "--", registeredPath],
    { failureMessage: "Git could not remove the worktree." },
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

/**
 * Removes the administrative entry of one registered worktree whose folder
 * is gone. Unlike `git worktree prune`, this touches no other entry, so a
 * worktree on a disconnected drive keeps its registration and index. The
 * folder is checked immediately before Git runs; `git worktree remove` is
 * never forced, so a folder that reappears is still checked by Git itself.
 */
export async function removeMissingWorktreeEntry(
  repositoryRootPath: string,
  registeredPath: string,
): Promise<boolean> {
  if (!isAbsolute(registeredPath) || registeredPath.includes("\0")) {
    throw new GitError("invalid-input", "The worktree path must be an absolute path.");
  }
  const missing = await lstat(registeredPath).then(() => false, (error: unknown) =>
    Boolean(error && typeof error === "object" && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR")));
  if (!missing) return false;
  await runGit(
    repositoryRootPath,
    ["worktree", "remove", "--", registeredPath],
    {
      timeoutMs: WORKTREE_INSPECTION_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      failureMessage: "Unable to clear the stale worktree entry.",
    },
  );
  return true;
}
