import { MAX_DIFF_FILES } from "./constants";
import {
  canonicalDirectoryPath,
  repositoryRoot,
  sameFilesystemPath,
  validatedEntryPaths,
  type GitPathInspectionOptions,
} from "./paths";
import { runGit } from "./runner";
import { inspectRepositoryStatusAndHead } from "./status";
import {
  GitError,
  type GitChangedFile,
  type GitRepositoryStatus,
} from "./types";

/** Upper bound for one stage/unstage request; matches the IPC contract. */
export const MAX_STAGING_PATHS = 200;
const STAGING_OUTPUT_BYTES = 16 * 1024;
const NUL = Buffer.from([0]);

export interface GitStagingOptions extends GitPathInspectionOptions {}

export interface GitStagingResult {
  /** Repository-relative paths whose index entry was changed. */
  paths: string[];
  /** Repository status read after the index changed. */
  status: GitRepositoryStatus;
}

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
  await runGit(root, indexArguments(command), {
    deadlineAt: options.deadlineAt,
    signal: options.signal,
    input: nulPaths(paths),
    maxOutputBytes: STAGING_OUTPUT_BYTES,
    failureMessage,
  });
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

function changedEntries(
  status: GitRepositoryStatus,
  selected: readonly string[],
): GitChangedFile[] {
  const byPath = new Map(status.files.map((file) => [file.path, file]));
  return selected.map((path) => {
    // Status lists an embedded repository as one untracked directory with a
    // trailing slash. Adding it would record a gitlink, so it is refused.
    if (byPath.get(`${path}/`)?.path.endsWith("/")) {
      throw new GitError(
        "invalid-input",
        "A nested repository must be staged from its own repository scope.",
      );
    }
    const file = byPath.get(path);
    if (!file) {
      throw new GitError(
        "conflict",
        "A selected file is no longer changed. Refresh and try again.",
      );
    }
    if (file.status === "unmerged") {
      throw new GitError(
        "conflict",
        "Resolve merge conflicts in the terminal before staging or unstaging that file.",
      );
    }
    return file;
  });
}

async function refreshedStatus(
  root: string,
  options: GitStagingOptions,
): Promise<GitRepositoryStatus> {
  return (await inspectRepositoryStatusAndHead(root, options)).status;
}

/**
 * Adds the selected working-tree changes (including deletions and untracked
 * files) to the index. Only paths that the current status reports as changed
 * are accepted; other paths in the index and working tree are untouched.
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
    .filter((file) => file.unstaged)
    .map((file) => file.path);
  await runIndexCommand(
    root,
    ["add", "--all"],
    stageable,
    "Unable to stage the selected files.",
    options,
  );
  return { paths: stageable, status: await refreshedStatus(root, options) };
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
  const staged = changedEntries(status, selected).filter((file) => file.staged);
  const newlyAdded = staged.filter((file) =>
    file.indexStatus === "A"
    && (file.worktreeStatus === "." || file.worktreeStatus === "D")
  );
  const newlyAddedPaths = new Set(newlyAdded.map((file) => file.path));
  const restored = [...new Set(staged
    .filter((file) => !newlyAddedPaths.has(file.path))
    .flatMap((file) => file.previousPath && file.status === "renamed"
      ? [file.path, file.previousPath]
      : [file.path]))];
  await runIndexCommand(
    root,
    ["rm", "--cached", "--quiet"],
    newlyAdded.map((file) => file.path),
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
  return {
    paths: staged.map((file) => file.path),
    status: await refreshedStatus(root, options),
  };
}
