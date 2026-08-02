import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
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

export interface RegisteredWorktreeIdentity extends RegisteredWorktreeOwnership {
  repositoryIdentity: string;
  worktreeId: string;
  ownershipToken: string;
}

export interface RegisteredWorktreeRegistration {
  branch: string | null;
  head: string;
  path: string;
  repositoryIdentity: string;
  worktreeId: string;
  ownershipToken: string;
}

export interface OwnedWorktreeCreationHooks {
  added(ownership: RegisteredWorktreeIdentity): void;
  beforeAdd(ownershipToken: string): void;
  notAdded(): void;
}

export interface OwnedWorktreeCreationDependencies {
  beforeOwnershipMarkerWrite?(
    adminDirectory: string,
    marker: WorktreeOwnershipMarker,
  ): Promise<void> | void;
  writeOwnershipMarker?(
    adminDirectory: string,
    marker: WorktreeOwnershipMarker,
  ): Promise<void>;
}

export type OwnedWorktreeCleanupInspection =
  | { state: "absent" }
  | { state: "conflict" }
  | { state: "registered"; identity: RegisteredWorktreeRegistration };

const OWNERSHIP_MARKER = "inertia-duo-owner";
const MAX_GIT_IDENTITY_FILE_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface WorktreeOwnershipMarker {
  version: 1;
  ownershipToken: string;
  repositoryIdentity: string;
  worktreeId: string;
  createdPathHash: string;
  branch: string;
  head: string;
}

function pathsEqual(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === "";
}

function nodeErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

async function reportedGitDirectory(
  root: string,
  argument: "--git-common-dir" | "--git-dir",
): Promise<string> {
  let result;
  try {
    result = await runGit(
      root,
      ["rev-parse", "--path-format=absolute", argument],
      {
        maxOutputBytes: MAX_PATH_LENGTH,
        failureMessage: "Unable to inspect the Git checkout identity.",
      },
    );
  } catch {
    result = await runGit(root, ["rev-parse", argument], {
      maxOutputBytes: MAX_PATH_LENGTH,
      failureMessage: "Unable to inspect the Git checkout identity.",
    });
  }
  const reported = result.stdout.toString("utf8").trim();
  if (!reported || reported.includes("\0")) {
    throw new GitError(
      "operation-failed",
      "Git returned an invalid checkout identity.",
    );
  }
  return isAbsolute(reported) ? resolve(reported) : resolve(root, reported);
}

async function canonicalGitDirectory(
  root: string,
  argument: "--git-common-dir" | "--git-dir",
): Promise<string> {
  try {
    return await realpath(await reportedGitDirectory(root, argument));
  } catch {
    throw new GitError(
      "conflict",
      "The Git checkout identity could not be verified.",
    );
  }
}

function pathIdentity(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

async function canonicalizeThroughExistingParent(path: string): Promise<string> {
  const target = resolve(path);
  let existing = target;
  while (true) {
    try {
      return resolve(await realpath(existing), relative(existing, target));
    } catch (error) {
      if (
        nodeErrorCode(error) !== "ENOENT"
        && nodeErrorCode(error) !== "ENOTDIR"
      ) {
        throw new GitError(
          "conflict",
          "The linked-worktree path identity could not be verified.",
        );
      }
      const parent = resolve(existing, "..");
      if (parent === existing) {
        throw new GitError(
          "conflict",
          "The linked-worktree path identity could not be verified.",
        );
      }
      existing = parent;
    }
  }
}

async function repositoryIdentity(commonDirectory: string): Promise<string> {
  const info = await stat(commonDirectory, { bigint: true });
  if (!info.isDirectory()) {
    throw new GitError(
      "conflict",
      "The Git common directory identity is invalid.",
    );
  }
  return createHash("sha256").update([
    commonDirectory,
    String(info.dev),
    String(info.ino),
  ].join("\0")).digest("hex");
}

async function readBoundedIdentityFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.size > MAX_GIT_IDENTITY_FILE_BYTES
  ) {
    throw new GitError(
      "conflict",
      "The linked-worktree identity metadata is invalid.",
    );
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.size > MAX_GIT_IDENTITY_FILE_BYTES
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) {
      throw new GitError(
        "conflict",
        "The linked-worktree identity metadata is invalid.",
      );
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function writeOwnershipMarker(
  adminDirectory: string,
  markerValue: WorktreeOwnershipMarker,
): Promise<void> {
  const marker = await open(
    resolve(adminDirectory, OWNERSHIP_MARKER),
    "wx",
    0o600,
  );
  try {
    await marker.writeFile(`${JSON.stringify(markerValue)}\n`, "utf8");
    await marker.sync();
  } finally {
    await marker.close();
  }
}

async function linkedWorktreeIdentity(
  root: string,
  worktreePath: string,
  branch: string,
  head: string,
  ownershipToken: string,
  writeMarker: boolean,
  markerWriter = writeOwnershipMarker,
  beforeMarkerWrite?: OwnedWorktreeCreationDependencies["beforeOwnershipMarkerWrite"],
): Promise<{
  commonDirectory: string;
  repositoryIdentity: string;
  worktreeId: string;
}> {
  const [commonDirectory, reportedAdminDirectory] = await Promise.all([
    canonicalGitDirectory(root, "--git-common-dir"),
    reportedGitDirectory(worktreePath, "--git-dir"),
  ]);
  const worktreeDirectory = resolve(commonDirectory, "worktrees");
  const [worktreeDirectoryInfo, adminDirectoryInfo] = await Promise.all([
    lstat(worktreeDirectory),
    lstat(reportedAdminDirectory),
  ]);
  if (
    worktreeDirectoryInfo.isSymbolicLink()
    || !worktreeDirectoryInfo.isDirectory()
    || adminDirectoryInfo.isSymbolicLink()
    || !adminDirectoryInfo.isDirectory()
  ) {
    throw new GitError(
      "conflict",
      "The linked-worktree administrative identity is not a real directory.",
    );
  }
  const [canonicalWorktreeDirectory, gitDirectory] = await Promise.all([
    realpath(worktreeDirectory),
    realpath(reportedAdminDirectory),
  ]);
  if (
    !pathsEqual(canonicalWorktreeDirectory, worktreeDirectory)
    || !pathsEqual(dirname(gitDirectory), canonicalWorktreeDirectory)
    || !pathsEqual(
      await realpath(dirname(reportedAdminDirectory)),
      canonicalWorktreeDirectory,
    )
  ) {
    throw new GitError(
      "conflict",
      "The linked worktree is outside the repository administrative directory.",
    );
  }
  const worktreeId = basename(gitDirectory);
  if (
    !worktreeId
    || worktreeId === "."
    || worktreeId === ".."
    || worktreeId.length > 255
    || worktreeId.includes("\0")
  ) {
    throw new GitError(
      "conflict",
      "Git returned an invalid linked-worktree identifier.",
    );
  }
  const identity = await repositoryIdentity(commonDirectory);
  if (writeMarker) {
    const marker: WorktreeOwnershipMarker = {
      version: 1,
      ownershipToken,
      repositoryIdentity: identity,
      worktreeId,
      createdPathHash: pathIdentity(worktreePath),
      branch,
      head,
    };
    await beforeMarkerWrite?.(gitDirectory, marker);
    await markerWriter(gitDirectory, marker);
  }
  return { commonDirectory, repositoryIdentity: identity, worktreeId };
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
  dependencies: OwnedWorktreeCreationDependencies = {},
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
  const ownershipToken = randomUUID();
  hooks.beforeAdd(ownershipToken);
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
  const identity = await linkedWorktreeIdentity(
    root,
    target,
    branch,
    head,
    ownershipToken,
    true,
    dependencies.writeOwnershipMarker,
    dependencies.beforeOwnershipMarkerWrite,
  );
  hooks.added({
    branch,
    head,
    path: target,
    ownershipToken,
    repositoryIdentity: identity.repositoryIdentity,
    worktreeId: identity.worktreeId,
  });
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

export async function inspectOwnedWorktreeCleanupState(
  repositoryPath: string,
  worktreePath: string,
  expectedBranch: string,
  expectedHead: string,
  expectedWorktreeId: string,
  expectedRepositoryIdentity: string,
  expectedOwnershipToken: string,
): Promise<OwnedWorktreeCleanupInspection> {
  if (!/^[0-9a-f]{40,64}$/u.test(expectedHead)) {
    throw new GitError(
      "invalid-input",
      "The expected worktree identity is invalid.",
    );
  }
  const root = await repositoryRoot(repositoryPath);
  const branch = await validateBranch(root, expectedBranch);
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
  const canonicalTarget = await canonicalizeThroughExistingParent(requestedTarget);
  if (canonicalTarget === root || canonicalTarget === parse(canonicalTarget).root) {
    throw new GitError(
      "invalid-input",
      "The main repository cannot be treated as an owned worktree.",
    );
  }
  if (
    !expectedWorktreeId
    || expectedWorktreeId === "."
    || expectedWorktreeId === ".."
    || expectedWorktreeId.length > 255
    || expectedWorktreeId.includes("\0")
    || !/^[0-9a-f]{64}$/u.test(expectedRepositoryIdentity)
    || !UUID_PATTERN.test(expectedOwnershipToken)
  ) {
    throw new GitError(
      "conflict",
      "The durable linked-worktree identity is unavailable.",
    );
  }
  const commonDirectory = await canonicalGitDirectory(root, "--git-common-dir");
  if (await repositoryIdentity(commonDirectory) !== expectedRepositoryIdentity) {
    return { state: "conflict" };
  }
  const worktreesDirectory = resolve(commonDirectory, "worktrees");
  const adminDirectory = resolve(worktreesDirectory, expectedWorktreeId);
  if (!pathsEqual(dirname(adminDirectory), worktreesDirectory)) {
    throw new GitError(
      "conflict",
      "The durable linked-worktree identifier is outside this repository.",
    );
  }
  const worktrees = await registeredWorktrees(root);
  let worktreesDirectoryInfo;
  try {
    worktreesDirectoryInfo = await lstat(worktreesDirectory);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
    const replacement = worktrees.some(({ branch: registeredBranch, path }) =>
      pathsEqual(path, requestedTarget)
      || pathsEqual(path, canonicalTarget)
      || registeredBranch === branch);
    return replacement ? { state: "conflict" } : { state: "absent" };
  }
  if (
    worktreesDirectoryInfo.isSymbolicLink()
    || !worktreesDirectoryInfo.isDirectory()
    || !pathsEqual(await realpath(worktreesDirectory), worktreesDirectory)
  ) return { state: "conflict" };
  let adminInfo;
  try {
    adminInfo = await lstat(adminDirectory);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
    const replacement = worktrees.some(({ branch: registeredBranch, path }) =>
      pathsEqual(path, requestedTarget)
      || pathsEqual(path, canonicalTarget)
      || registeredBranch === branch);
    return replacement ? { state: "conflict" } : { state: "absent" };
  }
  if (adminInfo.isSymbolicLink() || !adminInfo.isDirectory()) {
    return { state: "conflict" };
  }
  let marker: Partial<WorktreeOwnershipMarker>;
  try {
    marker = JSON.parse(await readBoundedIdentityFile(
      resolve(adminDirectory, OWNERSHIP_MARKER),
    )) as typeof marker;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT" || error instanceof SyntaxError) {
      return { state: "conflict" };
    }
    throw error;
  }
  if (
    marker.version !== 1
    || marker.ownershipToken !== expectedOwnershipToken
    || marker.repositoryIdentity !== expectedRepositoryIdentity
    || marker.worktreeId !== expectedWorktreeId
    || marker.createdPathHash !== pathIdentity(canonicalTarget)
    || marker.branch !== branch
    || marker.head !== expectedHead
  ) return { state: "conflict" };
  const rawGitdir = await readBoundedIdentityFile(
    resolve(adminDirectory, "gitdir"),
  );
  const gitdir = rawGitdir.endsWith("\r\n")
    ? rawGitdir.slice(0, -2)
    : rawGitdir.endsWith("\n")
      ? rawGitdir.slice(0, -1)
      : rawGitdir;
  if (
    !gitdir
    || !isAbsolute(gitdir)
    || gitdir.length > MAX_PATH_LENGTH
    || gitdir.includes("\0")
    || basename(gitdir) !== ".git"
  ) return { state: "conflict" };
  const registeredPath = dirname(gitdir);
  const registration = worktrees.find(({ path }) =>
    pathsEqual(path, registeredPath));
  if (!registration || !/^[0-9a-f]{40,64}$/u.test(registration.head)) {
    return { state: "conflict" };
  }
  return {
    state: "registered",
    identity: {
      branch: registration.branch,
      head: registration.head,
      path: registration.path,
      ownershipToken: expectedOwnershipToken,
      repositoryIdentity: expectedRepositoryIdentity,
      worktreeId: expectedWorktreeId,
    },
  };
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
