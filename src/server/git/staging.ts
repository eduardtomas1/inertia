import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { GIT_INDEX_REFRESH_WARNING } from "../../shared/git-staging";
import {
  GIT_INDEX_MUTATION_TIMEOUT_MS,
  GIT_READ_OPERATION_TIMEOUT_MS,
} from "../../shared/runtime-command-timeouts";
import { MAX_DIFF_FILES } from "./constants";
import {
  canonicalDirectoryPath,
  literalPathspecs,
  repositoryRoot,
  sameFilesystemPath,
  validatedEntryPaths,
  type GitPathInspectionOptions,
} from "./paths";
import { runGit, runGitInspection } from "./runner";
import { inspectRepositoryStatusAndHead } from "./status";
import {
  GitError,
  isGitProcessTreeTerminationFailure,
  type GitChangedFile,
  type GitRepositoryStatus,
} from "./types";

/** Upper bound for one stage/unstage request; matches the IPC contract. */
export const MAX_STAGING_PATHS = 200;
const STAGING_OUTPUT_BYTES = 16 * 1024;
const NUL = Buffer.from([0]);

export interface GitStagingOptions extends GitPathInspectionOptions {
  /**
   * Clock for each index update, started when that update starts. The
   * caller's `deadlineAt` bounds only the reads before it.
   */
  mutationTimeoutMs?: number;
  /** Clock for the status read after the index changed. */
  refreshTimeoutMs?: number;
}

export interface GitStagingResult {
  /** Repository-relative paths whose index entry was changed. */
  paths: string[];
  /**
   * Repository status read after the index changed, or the status read
   * before it when that refresh failed (see `refreshWarning`).
   */
  status: GitRepositoryStatus;
  /** The index changed, but the status could not be read again afterwards. */
  refreshWarning?: string;
}

const INDEX_TIMEOUT_MESSAGE =
  "Git took too long to update the index and was stopped. If .git/index.lock "
  + "remains, make sure no Git process is running before removing it.";

function nulPaths(paths: readonly string[]): Buffer {
  return Buffer.concat(paths.flatMap((path) => [Buffer.from(path), NUL]));
}

/**
 * Every index mutation reads its pathspecs as literal, NUL-separated input so
 * no path is interpreted as a glob, magic pathspec, or option, and so a long
 * selection never meets a platform command-line limit.
 */
function indexArguments(command: readonly string[]): string[] {
  return [
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    "--literal-pathspecs",
    ...command,
    "--pathspec-from-file=-",
    "--pathspec-file-nul",
  ];
}

async function runIndexCommand(
  root: string,
  command: readonly string[],
  paths: readonly string[],
  failureMessage: string,
  options: GitStagingOptions,
): Promise<void> {
  if (paths.length === 0) return;
  try {
    await runGit(root, indexArguments(command), {
      deadlineAt: Date.now()
        + (options.mutationTimeoutMs ?? GIT_INDEX_MUTATION_TIMEOUT_MS),
      signal: options.signal,
      input: nulPaths(paths),
      maxOutputBytes: STAGING_OUTPUT_BYTES,
      failureMessage,
    });
  } catch (error) {
    // A stopped index update can leave Git's lock file behind.
    if (error instanceof GitError && error.code === "timeout") {
      throw new GitError("timeout", INDEX_TIMEOUT_MESSAGE);
    }
    throw error;
  }
}

/**
 * Validates a bounded selection against the canonical repository root using
 * the same realpath and symbolic-link containment as reviewed commits.
 */
async function validatedStagingPaths(
  root: string,
  paths: readonly string[],
  options: GitStagingOptions,
): Promise<string[]> {
  if (
    !Array.isArray(paths)
    || paths.length === 0
    || paths.length > MAX_STAGING_PATHS
  ) {
    throw new GitError(
      "invalid-input",
      `Select between 1 and ${MAX_STAGING_PATHS} repository files.`,
    );
  }
  const selected = new Set<string>();
  for (let index = 0; index < paths.length; index += MAX_DIFF_FILES) {
    for (const path of await validatedEntryPaths(
      root,
      paths.slice(index, index + MAX_DIFF_FILES),
      options,
    )) {
      selected.add(path);
    }
  }
  return [...selected];
}

async function requireRepositoryTopLevel(
  root: string,
  options: GitStagingOptions,
): Promise<string> {
  const canonical = await canonicalDirectoryPath(root, options);
  if (!await sameFilesystemPath(
    await repositoryRoot(canonical, options),
    canonical,
    options,
  )) {
    throw new GitError(
      "conflict",
      "The repository changed after its status was loaded. Refresh and try again.",
    );
  }
  return canonical;
}

/**
 * Returns every status record for the selected paths. One path can carry two
 * records, such as a staged deletion and an untracked file of the same name,
 * so the records are kept per path rather than collapsed.
 */
function changedEntries(
  status: GitRepositoryStatus,
  selected: readonly string[],
): GitChangedFile[] {
  if (status.truncated) {
    throw new GitError(
      "output-limit",
      "This repository has too many changes to read completely, so Inertia cannot stage or unstage safely. Use Git in the terminal.",
    );
  }
  const byPath = new Map<string, GitChangedFile[]>();
  for (const file of status.files) {
    const records = byPath.get(file.path);
    if (records) records.push(file);
    else byPath.set(file.path, [file]);
  }
  return selected.flatMap((path) => {
    // Status lists an embedded repository as one untracked directory with a
    // trailing slash. Adding it would record a gitlink, so it is refused.
    if (byPath.has(`${path}/`)) {
      throw new GitError(
        "invalid-input",
        "A nested repository must be staged from its own repository scope.",
      );
    }
    const records = byPath.get(path);
    if (!records) {
      throw new GitError(
        "conflict",
        "A selected file is no longer changed. Refresh and try again.",
      );
    }
    if (records.some((file) => file.status === "unmerged")) {
      throw new GitError(
        "conflict",
        "Resolve merge conflicts in the terminal before staging or unstaging that file.",
      );
    }
    return records;
  });
}

/**
 * A pathspec also matches index entries below a folder of the same name.
 * Refuse an index update that would reach such entries when the user did not
 * select them, for example after a file was replaced by a folder or the
 * reverse. `reachable` names the records the Git command could change.
 */
function refuseWidenedPathspecs(
  status: GitRepositoryStatus,
  pathspecs: readonly string[],
  reachable: (file: GitChangedFile) => boolean,
): void {
  const covered = new Set(pathspecs);
  for (const pathspec of covered) {
    const prefix = `${pathspec}/`;
    if (status.files.some((file) =>
      reachable(file)
      && file.path.startsWith(prefix)
      && !covered.has(file.path))) {
      throw new GitError(
        "conflict",
        `“${pathspec}” is also a folder with other changes. Select the files inside it instead.`,
      );
    }
  }
}

/**
 * Staging a path that is now a folder would add every file inside it. Only a
 * submodule, which the index records as one gitlink entry, may be a folder.
 */
async function refuseFolderPaths(
  root: string,
  paths: readonly string[],
  options: GitStagingOptions,
): Promise<void> {
  const folders: string[] = [];
  for (const path of paths) {
    const info = await lstat(join(root, path)).catch(() => null);
    if (info?.isDirectory()) folders.push(path);
  }
  if (folders.length === 0) return;
  const gitlinks = new Set<string>();
  for (let index = 0; index < folders.length; index += MAX_DIFF_FILES) {
    const result = await runGitInspection(
      root,
      [
        "ls-files",
        "--stage",
        "-z",
        "--",
        ...literalPathspecs(folders.slice(index, index + MAX_DIFF_FILES)),
      ],
      {
        deadlineAt: options.deadlineAt,
        signal: options.signal,
        maxOutputBytes: 64 * 1024,
        truncateOutput: true,
        failureMessage: "Unable to inspect the selected folder in Git.",
      },
    );
    for (const record of result.stdout.toString("utf8").split("\0")) {
      const tab = record.indexOf("\t");
      if (tab > 0 && record.startsWith("160000 ")) {
        gitlinks.add(record.slice(tab + 1));
      }
    }
  }
  const folder = folders.find((path) => !gitlinks.has(path));
  if (folder !== undefined) {
    throw new GitError(
      "conflict",
      `“${folder}” is now a folder. Stage the files inside it instead.`,
    );
  }
}

/**
 * Reads the status after the index changed. The index update has already
 * succeeded, so a failed refresh is reported as a warning, not a failure.
 */
async function stagingResult(
  root: string,
  paths: string[],
  before: GitRepositoryStatus,
  options: GitStagingOptions,
): Promise<GitStagingResult> {
  if (paths.length === 0) return { paths, status: before };
  try {
    const { status } = await inspectRepositoryStatusAndHead(root, {
      deadlineAt: Date.now()
        + (options.refreshTimeoutMs ?? GIT_READ_OPERATION_TIMEOUT_MS),
      signal: options.signal,
    });
    return { paths, status };
  } catch (error) {
    if (isGitProcessTreeTerminationFailure(error)) throw error;
    return { paths, status: before, refreshWarning: GIT_INDEX_REFRESH_WARNING };
  }
}

/**
 * Adds the selected working-tree changes (including deletions and untracked
 * files) to the index. Only paths that the current status reports as changed
 * are accepted; other paths in the index and working tree are untouched.
 *
 * Tracked entries are updated with `git add --update`, which never consults
 * ignore rules, so a tracked file inside an ignored folder stages cleanly.
 * Only untracked entries go through a plain `git add`.
 */
export async function stageRepositoryPaths(
  repository: string,
  paths: readonly string[],
  options: GitStagingOptions = {},
): Promise<GitStagingResult> {
  const root = await requireRepositoryTopLevel(repository, options);
  const selected = await validatedStagingPaths(root, paths, options);
  const { status } = await inspectRepositoryStatusAndHead(root, options);
  const stageable = changedEntries(status, selected)
    .filter((file) => file.unstaged);
  const tracked = [...new Set(stageable
    .filter((file) => file.indexStatus !== "?")
    .map((file) => file.path))];
  const untracked = [...new Set(stageable
    .filter((file) => file.indexStatus === "?")
    .map((file) => file.path))];
  const stagedPaths = [...new Set([...tracked, ...untracked])];
  refuseWidenedPathspecs(status, stagedPaths, (file) => file.indexStatus !== "?");
  await refuseFolderPaths(root, stagedPaths, options);
  await runIndexCommand(
    root,
    ["add", "--update"],
    tracked,
    "Unable to stage the selected files.",
    options,
  );
  await runIndexCommand(
    root,
    ["add"],
    untracked,
    "Unable to stage the selected files.",
    options,
  );
  return await stagingResult(root, stagedPaths, status, options);
}

/**
 * Moves the selected staged changes back out of the index while leaving every
 * working-tree file exactly as it is.
 *
 * - A newly added file whose working copy still matches the index (or has
 *   since been deleted) is removed from the index with `git rm --cached`.
 * - Other staged entries are restored from HEAD with `git restore --staged`,
 *   including the source path of a staged rename.
 * - Before the first commit there is no HEAD to restore from, so a newly
 *   added file with further edits is reset against the empty tree with a
 *   path-limited `git reset`, which also changes only the index.
 */
export async function unstageRepositoryPaths(
  repository: string,
  paths: readonly string[],
  options: GitStagingOptions = {},
): Promise<GitStagingResult> {
  const root = await requireRepositoryTopLevel(repository, options);
  const selected = await validatedStagingPaths(root, paths, options);
  const { status, hasCurrentHead } = await inspectRepositoryStatusAndHead(
    root,
    options,
  );
  // An untracked record is never staged, so a path that also has a staged
  // deletion is unstaged through its tracked record.
  const staged = changedEntries(status, selected).filter((file) => file.staged);
  const newlyAdded = [...new Set(staged
    .filter((file) =>
      file.indexStatus === "A"
      && (file.worktreeStatus === "." || file.worktreeStatus === "D"))
    .map((file) => file.path))];
  const newlyAddedPaths = new Set(newlyAdded);
  const restored = [...new Set(staged
    .filter((file) => !newlyAddedPaths.has(file.path))
    .flatMap((file) => file.previousPath && file.status === "renamed"
      ? [file.path, file.previousPath]
      : [file.path]))];
  refuseWidenedPathspecs(status, [...newlyAdded, ...restored], (file) => file.staged);
  await runIndexCommand(
    root,
    ["rm", "--cached", "--quiet"],
    newlyAdded,
    "Unable to unstage the selected files.",
    options,
  );
  await runIndexCommand(
    root,
    hasCurrentHead ? ["restore", "--staged"] : ["reset", "--quiet"],
    restored,
    "Unable to unstage the selected files.",
    options,
  );
  return await stagingResult(
    root,
    [...new Set(staged.map((file) => file.path))],
    status,
    options,
  );
}
