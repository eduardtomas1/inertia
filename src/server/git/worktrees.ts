import {
  access,
  lstat,
  realpath,
  stat,
} from "node:fs/promises";
import {
  isAbsolute,
  parse,
  relative,
  resolve,
} from "node:path";

import { MAX_PATH_LENGTH } from "./constants";
import {
  repositoryRoot,
  validateBranch,
  validateName,
} from "./paths";
import { runGit } from "./runner";
import { getRepositoryStatus } from "./status";
import {
  GitError,
  type CreateWorktreeOptions,
  type GitMutationResult,
  type GitRepositoryStatus,
} from "./types";

export interface RegisteredWorktreeOwnership {
  branch: string;
  head: string;
  path: string;
}

export interface OwnedWorktreeCreationHooks {
  added(ownership: RegisteredWorktreeOwnership): void;
  beforeAdd(): void;
  notAdded(): void;
}

export interface OwnedWorktreeRemovalHooks {
  beforeRemove(): void;
  removed(): void;
}

function pathsEqual(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === "";
}

async function validateNewAbsolutePath(
  path: string,
  repositoryRootPath: string,
): Promise<string> {
  if (
    typeof path !== "string"
    || !isAbsolute(path)
    || path.length > MAX_PATH_LENGTH
    || path.includes("\0")
    || resolve(path) === parse(resolve(path)).root
  ) {
    throw new GitError(
      "invalid-input",
      "The worktree path must be a safe absolute path.",
    );
  }
  const target = resolve(path);
  if (target === repositoryRootPath) {
    throw new GitError(
      "invalid-input",
      "The main repository cannot be used as a new worktree path.",
    );
  }
  try {
    await access(target);
    throw new GitError(
      "invalid-input",
      "The new worktree path already exists.",
    );
  } catch (error) {
    if (error instanceof GitError) throw error;
  }
  let existing = resolve(target, "..");
  while (true) {
    try {
      await lstat(existing);
      const canonicalParent = await realpath(existing);
      if (!(await stat(canonicalParent)).isDirectory()) {
        throw new GitError(
          "invalid-input",
          "The worktree path has an unsafe parent folder.",
        );
      }
      const suffix = relative(existing, target);
      return resolve(canonicalParent, suffix);
    } catch (error) {
      if (error instanceof GitError) throw error;
      const parent = resolve(existing, "..");
      if (parent === existing) {
        throw new GitError(
          "invalid-input",
          "The worktree parent folder could not be found.",
        );
      }
      existing = parent;
    }
  }
}

export async function createWorktree(
  repositoryPath: string,
  worktreePath: string,
  options: CreateWorktreeOptions = {},
): Promise<GitRepositoryStatus> {
  const root = await repositoryRoot(repositoryPath);
  const target = await validateNewAbsolutePath(worktreePath, root);
  const args = ["worktree", "add"];
  if (options.createBranch) {
    if (!options.branch) {
      throw new GitError(
        "invalid-input",
        "A branch name is required for the new worktree.",
      );
    }
    args.push("-b", await validateBranch(root, options.branch));
  }
  args.push("--", target);
  if (options.startPoint) {
    args.push(validateName(options.startPoint, "The starting revision"));
  } else if (options.branch && !options.createBranch) {
    args.push(await validateBranch(root, options.branch));
  }
  await runGit(root, args, {
    failureMessage: "Unable to create the worktree.",
  });
  return getRepositoryStatus(target);
}

export async function createWorktreeWithOwnershipReceipt(
  repositoryPath: string,
  worktreePath: string,
  options: { branch: string; createBranch: true; startPoint: string },
  hooks: OwnedWorktreeCreationHooks,
): Promise<GitRepositoryStatus> {
  const root = await repositoryRoot(repositoryPath);
  const target = await validateNewAbsolutePath(worktreePath, root);
  const branch = await validateBranch(root, options.branch);
  const startPoint = validateName(
    options.startPoint,
    "The starting revision",
  );
  const resolved = await runGit(
    root,
    ["rev-parse", "--verify", `${startPoint}^{commit}`],
    { failureMessage: "Unable to resolve the worktree starting revision." },
  );
  const head = resolved.stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(head)) {
    throw new GitError(
      "operation-failed",
      "Git returned an invalid worktree starting revision.",
    );
  }
  hooks.beforeAdd();
  try {
    await runGit(
      root,
      ["worktree", "add", "-b", branch, "--", target, head],
      { failureMessage: "Unable to create the worktree." },
    );
  } catch (error) {
    try {
      await inspectRegisteredWorktreeOwnership(root, target, branch);
    } catch (inspectionError) {
      if (
        inspectionError instanceof GitError
        && inspectionError.code === "not-found"
      ) {
        hooks.notAdded();
      }
    }
    throw error;
  }
  hooks.added({ branch, head, path: target });
  return getRepositoryStatus(target);
}

async function registeredWorktrees(
  root: string,
): Promise<Array<{ branch: string | null; head: string; path: string }>> {
  const result = await runGit(
    root,
    ["worktree", "list", "--porcelain", "-z"],
    { failureMessage: "Unable to inspect repository worktrees." },
  );
  const worktrees: Array<{
    branch: string | null;
    head: string;
    path: string;
  }> = [];
  let current: {
    branch: string | null;
    head: string;
    path: string;
  } | null = null;
  for (const field of result.stdout.toString("utf8").split("\0")) {
    if (field.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { branch: null, head: "", path: field.slice(9) };
    } else if (current && field.startsWith("HEAD ")) {
      current.head = field.slice(5);
    } else if (current && field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

async function conflictingRegisteredWorktree(
  root: string,
  worktreePath: string,
  branch: string,
): Promise<{ branch: string | null; head: string; path: string } | undefined> {
  const requestedTarget = resolve(worktreePath);
  const canonicalTarget = await realpath(requestedTarget).catch(() =>
    requestedTarget);
  return (await registeredWorktrees(root)).find((registered) => {
    const registeredPath = resolve(registered.path);
    return pathsEqual(registeredPath, requestedTarget)
      || pathsEqual(registeredPath, canonicalTarget)
      || registered.branch === branch;
  });
}

export async function inspectRegisteredWorktreeOwnership(
  repositoryPath: string,
  worktreePath: string,
  expectedBranch: string,
): Promise<RegisteredWorktreeOwnership> {
  const root = await repositoryRoot(repositoryPath);
  if (
    !isAbsolute(worktreePath)
    || worktreePath.length > MAX_PATH_LENGTH
    || worktreePath.includes("\0")
  ) {
    throw new GitError(
      "invalid-input",
      "The worktree path must be an absolute path.",
    );
  }
  const branch = await validateBranch(root, expectedBranch);
  const requestedTarget = resolve(worktreePath);
  const target = await realpath(requestedTarget).catch(() => requestedTarget);
  if (target === root || target === parse(target).root) {
    throw new GitError(
      "invalid-input",
      "The main repository cannot be treated as an owned worktree.",
    );
  }
  const registered = (await registeredWorktrees(root)).find(
    (worktree) => pathsEqual(worktree.path, target),
  );
  if (!registered) {
    throw new GitError(
      "not-found",
      "The requested worktree is not registered with this repository.",
    );
  }
  if (
    registered.branch !== branch
    || !/^[0-9a-f]{40,64}$/u.test(registered.head)
  ) {
    throw new GitError(
      "conflict",
      "The registered worktree does not match the launch-owned branch identity.",
    );
  }
  return {
    branch,
    head: registered.head,
    path: registered.path,
  };
}

export async function removeWorktreeIfOwnershipUnchanged(
  repositoryPath: string,
  worktreePath: string,
  expectedBranch: string,
  expectedHead: string,
  force: boolean,
  hooks: OwnedWorktreeRemovalHooks,
): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/u.test(expectedHead)) {
    throw new GitError(
      "invalid-input",
      "The expected worktree identity is invalid.",
    );
  }
  const root = await repositoryRoot(repositoryPath);
  const branch = await validateBranch(root, expectedBranch);
  let ownership: RegisteredWorktreeOwnership;
  try {
    ownership = await inspectRegisteredWorktreeOwnership(
      root,
      worktreePath,
      branch,
    );
  } catch (error) {
    if (!(error instanceof GitError && error.code === "not-found")) throw error;
    const conflicting = await conflictingRegisteredWorktree(
      root,
      worktreePath,
      branch,
    );
    if (conflicting) {
      throw new GitError(
        "conflict",
        "The launch-owned worktree moved or was replaced and was not removed.",
      );
    }
    hooks.beforeRemove();
    const appeared = await conflictingRegisteredWorktree(
      root,
      worktreePath,
      branch,
    );
    if (appeared) {
      throw new GitError(
        "conflict",
        "The launch-owned worktree changed after removal began and was not removed.",
      );
    }
    hooks.removed();
    return;
  }
  if (ownership.head !== expectedHead) {
    throw new GitError(
      "conflict",
      "The launch-owned worktree changed after cleanup began and was not removed.",
    );
  }
  hooks.beforeRemove();
  const confirmed = await inspectRegisteredWorktreeOwnership(
    root,
    worktreePath,
    branch,
  );
  if (confirmed.head !== expectedHead) {
    throw new GitError(
      "conflict",
      "The launch-owned worktree changed after removal began and was not removed.",
    );
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push("--", confirmed.path);
  await runGit(root, args, {
    failureMessage: "Unable to remove the worktree.",
  });
  hooks.removed();
}

export async function confirmWorktreeRemovalIfAbsent(
  repositoryPath: string,
  worktreePath: string,
  expectedBranch: string,
  removed: () => void,
): Promise<void> {
  const root = await repositoryRoot(repositoryPath);
  if (
    !isAbsolute(worktreePath)
    || worktreePath.length > MAX_PATH_LENGTH
    || worktreePath.includes("\0")
  ) {
    throw new GitError(
      "invalid-input",
      "The worktree path must be an absolute path.",
    );
  }
  const branch = await validateBranch(root, expectedBranch);
  if (await conflictingRegisteredWorktree(root, worktreePath, branch)) {
    throw new GitError(
      "conflict",
      "The claimed worktree removal has a present, moved, or replacement topology and was not confirmed.",
    );
  }
  removed();
}

export async function removeWorktree(
  repositoryPath: string,
  worktreePath: string,
  force = false,
): Promise<GitMutationResult> {
  const root = await repositoryRoot(repositoryPath);
  if (
    !isAbsolute(worktreePath)
    || worktreePath.length > MAX_PATH_LENGTH
    || worktreePath.includes("\0")
  ) {
    throw new GitError(
      "invalid-input",
      "The worktree path must be an absolute path.",
    );
  }
  const requestedTarget = resolve(worktreePath);
  const target = await realpath(requestedTarget).catch(() => requestedTarget);
  if (target === root || target === parse(target).root) {
    throw new GitError(
      "invalid-input",
      "The main repository cannot be removed as a worktree.",
    );
  }
  const worktrees = await registeredWorktrees(root);
  const registered = worktrees.find(
    (worktree) => pathsEqual(worktree.path, target),
  );
  if (!registered) {
    throw new GitError(
      "not-found",
      "The requested worktree is not registered with this repository.",
    );
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push("--", registered.path);
  await runGit(root, args, {
    failureMessage: "Unable to remove the worktree.",
  });
  return { status: await getRepositoryStatus(root) };
}
