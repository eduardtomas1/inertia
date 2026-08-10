import { createHash, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureRawWorktreeTree } from "../checkpoints";
import { MAX_DIFF_BYTES, MAX_DIFF_FILES } from "./constants";
import {
  repositoryRoot,
  validatedPaths,
  type GitPathInspectionOptions,
} from "./paths";
import { getRepositoryStatus } from "./status";
import { runGit, runGitInspection } from "./runner";
import {
  GitError,
  type GitRepositoryStatus,
} from "./types";

const RECEIPT_FINGERPRINT = /^[0-9a-f]{64}$/u;
const NUL = Buffer.from([0]);

function tempIndexArguments(args: readonly string[]): string[] {
  return ["--no-pager", "-c", "core.fsmonitor=false", ...args];
}

function stripTerminalEol(value: string): string {
  return value.replace(/(?:\r\n|\n)$/u, "");
}

interface CanonicalReviewFile {
  path: string;
  previousPath: string | null;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
}

export interface GitCommitReviewCapture {
  fingerprint: string;
  status: GitRepositoryStatus;
  mutationPaths: string[];
  removalPaths: string[];
  head: string | null;
  headRef: string | null;
  rawTree: string;
  prospectiveTree: string;
}

export interface GitCommitSelection {
  tree: string;
  environment: NodeJS.ProcessEnv;
  directory: string;
  indexPath: string;
  dispose(): Promise<void>;
}

export interface GitPreparedCommitReview {
  capture: GitCommitReviewCapture;
  selection: GitCommitSelection;
}

export interface GitDerivedCommitSelection {
  tree: string;
  environment: NodeJS.ProcessEnv;
}

function canonicalFiles(status: GitRepositoryStatus): CanonicalReviewFile[] {
  return status.files.map((file) => ({
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    indexStatus: file.indexStatus,
    worktreeStatus: file.worktreeStatus,
    staged: file.staged,
    unstaged: file.unstaged,
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.path),
    Buffer.from(right.path),
  ));
}

function unavailable(message: string): GitError {
  return new GitError("conflict", message);
}

async function changedPaths(
  root: string,
  status: GitRepositoryStatus,
  options: GitPathInspectionOptions,
): Promise<string[]> {
  if (status.truncated || status.files.length > MAX_DIFF_FILES) {
    throw new GitError(
      "output-limit",
      "The complete repository state is too large to verify for commit.",
    );
  }
  const paths = await validatedPaths(
    root,
    status.files.map((file) => file.path),
    options,
  );
  const previousInputs = status.files.flatMap((file) =>
    file.previousPath ? [file.previousPath] : []
  );
  const previous = previousInputs.length > 0
    ? await validatedPaths(root, previousInputs, options)
    : [];
  return [...new Set([...paths, ...previous])].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  );
}

function nulPaths(paths: readonly string[]): Buffer {
  return Buffer.concat(paths.flatMap((path) => [Buffer.from(path), NUL]));
}

function removedMutationPaths(
  status: GitRepositoryStatus,
  mutationPaths: readonly string[],
): string[] {
  const present = new Set(status.files.filter(
    (file) => file.status !== "deleted" && file.worktreeStatus !== "D",
  ).map((file) => file.path));
  const removed = new Set(status.files.flatMap((file) => [
    ...(file.status === "renamed" && file.previousPath
      ? [file.previousPath]
      : []),
    ...(file.status === "deleted" || file.worktreeStatus === "D"
      ? [file.path]
      : []),
  ]));
  return mutationPaths.filter(
    (path) => removed.has(path) && !present.has(path),
  );
}

/**
 * Captures source bytes and Git path semantics independently of presentation
 * whitespace settings and repository-provided clean filters.
 */
async function captureRawReview(
  repositoryPath: string,
  options: GitPathInspectionOptions = {},
): Promise<Omit<GitCommitReviewCapture, "fingerprint" | "prospectiveTree"> & {
  rawFingerprint: string;
}> {
  const root = await repositoryRoot(repositoryPath, options);
  const status = await getRepositoryStatus(root, {
    deadlineAt: options.deadlineAt,
  });
  if (status.clean) {
    throw unavailable("There are no changes to review for commit.");
  }
  const paths = await changedPaths(root, status, options);
  const removalPaths = removedMutationPaths(status, paths);
  const removalSet = new Set(removalPaths);
  const raw = await captureRawWorktreeTree(
    root,
    nulPaths(paths.filter((path) => !removalSet.has(path))),
    {
      deadlineAt: options.deadlineAt,
      removedPaths: nulPaths(removalPaths),
    },
  );
  let headRef: string | null = null;
  try {
    const symbolicHead = await runGitInspection(
      root,
      ["symbolic-ref", "--quiet", "HEAD"],
      {
        deadlineAt: options.deadlineAt,
        maxOutputBytes: 4_096,
        failureMessage: "Unable to verify the reviewed branch.",
      },
    );
    headRef = stripTerminalEol(symbolicHead.stdout.toString("utf8")) || null;
  } catch (error) {
    if (!(error instanceof GitError && error.code === "operation-failed")) {
      throw error;
    }
  }
  const canonical = {
    head: raw.head,
    headRef,
    branch: status.branch,
    tree: raw.tree,
    files: canonicalFiles(status),
  };
  return {
    rawFingerprint: createHash("sha256")
      .update(JSON.stringify(canonical)).digest("hex"),
    status,
    mutationPaths: paths,
    removalPaths,
    head: raw.head,
    headRef,
    rawTree: raw.tree,
  };
}

export async function prepareGitCommitReview(
  repositoryPath: string,
  options: GitPathInspectionOptions = {},
): Promise<GitPreparedCommitReview> {
  const root = await repositoryRoot(repositoryPath, options);
  const before = await captureRawReview(root, options);
  const selection = await prepareGitCommitSelection(
    root,
    before.head,
    before.mutationPaths,
    options,
    true,
    before.removalPaths,
  );
  try {
    const after = await captureRawReview(root, options);
    if (!gitCommitReviewFingerprintsEqual(
      before.rawFingerprint,
      after.rawFingerprint,
    )) {
      throw unavailable(
        "The repository changed while its complete commit state was being prepared. Refresh and try again.",
      );
    }
    return {
      selection,
      capture: {
        status: after.status,
        mutationPaths: after.mutationPaths,
        removalPaths: after.removalPaths,
        head: after.head,
        headRef: after.headRef,
        rawTree: after.rawTree,
        prospectiveTree: selection.tree,
        fingerprint: createHash("sha256").update(JSON.stringify({
          source: after.rawFingerprint,
          prospectiveTree: selection.tree,
        })).digest("hex"),
      },
    };
  } catch (error) {
    await selection.dispose().catch(() => undefined);
    throw error;
  }
}

export async function captureGitCommitReview(
  repositoryPath: string,
  options: GitPathInspectionOptions = {},
): Promise<GitCommitReviewCapture> {
  const prepared = await prepareGitCommitReview(repositoryPath, options);
  try {
    return prepared.capture;
  } finally {
    await prepared.selection.dispose().catch(() => undefined);
  }
}

export async function prepareGitCommitSelection(
  root: string,
  head: string | null,
  paths: readonly string[],
  options: GitPathInspectionOptions = {},
  isolateObjects = true,
  removalPaths: readonly string[] = [],
): Promise<GitCommitSelection> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-commit-selection-"));
  const indexPath = join(directory, "index");
  const objectDirectory = join(directory, "objects");
  const realObjects = isolateObjects
    ? stripTerminalEol((await runGitInspection(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ], {
        deadlineAt: options.deadlineAt,
        maxOutputBytes: 4_096,
        failureMessage: "Unable to isolate the reviewed commit objects.",
      })).stdout.toString("utf8"))
    : null;
  const environment = {
    GIT_INDEX_FILE: indexPath,
    ...(realObjects
      ? {
          GIT_OBJECT_DIRECTORY: objectDirectory,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(realObjects),
        }
      : {}),
  };
  let retained = false;
  try {
    if (realObjects) await mkdir(objectDirectory, { mode: 0o700 });
    await runGit(root, tempIndexArguments(head
      ? ["read-tree", head]
      : ["read-tree", "--empty"]), {
      deadlineAt: options.deadlineAt,
      environment,
      maxOutputBytes: 1_024,
      failureMessage: "Unable to prepare the selected commit state.",
    });
    if (removalPaths.length > 0) {
      await runGit(root, tempIndexArguments([
        "update-index",
        "--force-remove",
        "-z",
        "--stdin",
      ]), {
        deadlineAt: options.deadlineAt,
        environment,
        input: nulPaths(removalPaths),
        maxOutputBytes: 1_024,
        failureMessage: "Unable to prepare the selected commit state.",
      });
    }
    const removalSet = new Set(removalPaths);
    const additions = paths.filter((path) => !removalSet.has(path));
    if (additions.length > 0) {
      await runGit(root, tempIndexArguments([
        "--literal-pathspecs",
        "add",
        "-A",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ]), {
        deadlineAt: options.deadlineAt,
        environment,
        input: nulPaths(additions),
        maxOutputBytes: 1_024,
        failureMessage: "Unable to prepare the selected commit state.",
      });
    }
    const result = await runGit(root, tempIndexArguments(["write-tree"]), {
      deadlineAt: options.deadlineAt,
      environment,
      maxOutputBytes: 256,
      failureMessage: "Unable to verify the selected commit state.",
    });
    const tree = result.stdout.toString("utf8").trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tree)) {
      throw unavailable("The selected commit state could not be verified.");
    }
    retained = true;
    return {
      tree,
      environment,
      directory,
      indexPath,
      dispose: async () => await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 2,
      }),
    };
  } finally {
    if (!retained) {
      await rm(directory, { recursive: true, force: true, maxRetries: 2 });
    }
  }
}

/** Renders the exact prospective Git tree captured for the commit receipt. */
export async function renderGitCommitReviewDiff(
  root: string,
  prepared: GitPreparedCommitReview,
  options: GitPathInspectionOptions = {},
): Promise<string> {
  let base = prepared.capture.head;
  if (!base) {
    base = (await runGit(root, ["mktree"], {
      deadlineAt: options.deadlineAt,
      environment: prepared.selection.environment,
      input: Buffer.alloc(0),
      maxOutputBytes: 256,
      failureMessage: "Unable to prepare the reviewed commit diff.",
    })).stdout.toString("utf8").trim();
  }
  return (await runGit(root, [
    "--no-pager",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    base,
    prepared.capture.prospectiveTree,
    "--",
  ], {
    deadlineAt: options.deadlineAt,
    environment: prepared.selection.environment,
    maxOutputBytes: MAX_DIFF_BYTES,
    failureMessage: "Unable to render the complete reviewed commit diff.",
  })).stdout.toString("utf8");
}

export async function deriveGitCommitSelection(
  root: string,
  full: GitCommitSelection,
  selectedPaths: readonly string[],
  mutationPaths: readonly string[],
  head: string | null,
  options: GitPathInspectionOptions = {},
): Promise<GitDerivedCommitSelection> {
  const selected = new Set(selectedPaths);
  const unselected = mutationPaths.filter((path) => !selected.has(path));
  const indexPath = join(full.directory, "selected.index");
  await copyFile(full.indexPath, indexPath);
  const environment = { ...full.environment, GIT_INDEX_FILE: indexPath };
  if (unselected.length > 0) {
    let resetTarget = head;
    if (!resetTarget) {
      resetTarget = (await runGit(root, ["mktree"], {
        deadlineAt: options.deadlineAt,
        environment,
        input: Buffer.alloc(0),
        maxOutputBytes: 256,
        failureMessage: "Unable to prepare the selected commit state.",
      })).stdout.toString("utf8").trim();
    }
    await runGit(root, tempIndexArguments([
      "reset",
      resetTarget,
      "--pathspec-from-file=-",
      "--pathspec-file-nul",
    ]), {
      deadlineAt: options.deadlineAt,
      environment,
      input: nulPaths(unselected),
      maxOutputBytes: 1_024,
      failureMessage: "Unable to prepare the selected commit state.",
    });
  }
  const tree = (await runGit(root, tempIndexArguments(["write-tree"]), {
    deadlineAt: options.deadlineAt,
    environment,
    maxOutputBytes: 256,
    failureMessage: "Unable to verify the selected commit state.",
  })).stdout.toString("utf8").trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tree)) {
    throw unavailable("The selected commit state could not be verified.");
  }
  return { tree, environment };
}

export function requireGitCommitReviewFingerprint(value: string): string {
  if (!RECEIPT_FINGERPRINT.test(value)) {
    throw new GitError(
      "invalid-input",
      "The reviewed repository receipt is invalid. Refresh and try again.",
    );
  }
  return value;
}

export function gitCommitReviewFingerprintsEqual(
  left: string,
  right: string,
): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function gitCommitReviewStatusMatches(
  capture: GitCommitReviewCapture,
  status: GitRepositoryStatus,
): boolean {
  return JSON.stringify(canonicalFiles(capture.status))
    === JSON.stringify(canonicalFiles(status));
}
