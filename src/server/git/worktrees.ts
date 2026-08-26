import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
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

import {
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../node/runtime-owned-processes";
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
import {
  isWorktreeFilesystemReceipt,
  type WorktreeFilesystemIdentity,
  type WorktreeFilesystemReceipt,
  worktreeFilesystemIdentitiesEqual,
} from "../worktree-filesystem-identity";

export interface RegisteredWorktreeOwnership {
  branch: string;
  head: string;
  path: string;
}

export interface RegisteredWorktreeIdentity extends RegisteredWorktreeOwnership {
  filesystemReceipt: WorktreeFilesystemReceipt;
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
  filesystemReceipt: WorktreeFilesystemReceipt;
}

export interface OwnedWorktreeCreationHooks {
  added(ownership: RegisteredWorktreeIdentity): void;
  beforeAdd(ownershipToken: string): void;
  notAdded(): void;
}

export interface OwnedWorktreeCreationDependencies {
  beforeFilesystemIdentityCapture?(adminDirectory: string): Promise<void> | void;
  filesystemIdentity?: WorktreeFilesystemIdentityDependencies;
}

export interface OwnedWorktreeInspectionDependencies {
  administrativeScanTimeoutMs?: number;
  afterIdentityFileStat?(path: string): Promise<void> | void;
  filesystemIdentity?: WorktreeFilesystemIdentityDependencies;
}

export interface OwnedWorktreeRemovalDependencies
  extends OwnedWorktreeInspectionDependencies {
  afterFinalValidation?(): Promise<void> | void;
  afterInitialInspection?(): Promise<void> | void;
}

export interface WorktreeFilesystemIdentityDependencies {
  afterLinuxStatClose?(): void;
  beforeLinuxStatProbe?(path: string): Promise<void> | void;
  deadlineAt?: number;
  platform?: NodeJS.Platform;
  linuxStatExecutable?: string;
  linuxStatArguments?(descriptorPath: string, inspectedPath: string): string[];
  linuxStatTimeoutMs?: number;
}

export type OwnedWorktreeCleanupInspection =
  | { state: "absent" }
  | { state: "conflict" }
  | { state: "registered"; identity: RegisteredWorktreeRegistration };

export type OwnedWorktreeRemovalOutcome = "absent" | "conflict" | "retained";

export type UnacknowledgedWorktreeCreationInspection = "absent" | "retained";

const MAX_GIT_IDENTITY_FILE_BYTES = 16 * 1024;
const MAX_LINUX_BIRTHTIME_OUTPUT_BYTES = 256;
const LINUX_BIRTHTIME_TIMEOUT_MS = 2_000;
const ADMINISTRATIVE_IDENTITY_SCAN_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

export function durableWorktreeDirectoryIdentity(
  info: BigIntStats,
): WorktreeFilesystemIdentity {
  if (!info.isDirectory() || info.dev <= 0n || info.ino <= 0n) {
    throw new GitError(
      "conflict",
      "The linked-worktree filesystem does not expose a stable directory identity.",
    );
  }
  if (info.birthtimeNs <= 0n) {
    throw new GitError(
      "operation-failed",
      "The repository filesystem does not expose reliable nonzero directory birth times; isolated Duo worktrees are unsupported safely.",
    );
  }
  return {
    device: info.dev.toString(10),
    inode: info.ino.toString(10),
    birthtimeNs: info.birthtimeNs.toString(10),
  };
}

function linuxStatEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  };
  for (const name of ["SystemRoot", "WINDIR", "PATHEXT"] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

async function verifyLinuxDirectoryBirthtime(
  path: string,
  fileDescriptor: number,
  opened: BigIntStats,
  dependencies: WorktreeFilesystemIdentityDependencies,
): Promise<WorktreeFilesystemIdentity> {
  const executable = dependencies.linuxStatExecutable ?? "/usr/bin/stat";
  const descriptorPath = "/proc/self/fd/3";
  const requestedTimeout = dependencies.linuxStatTimeoutMs;
  const configuredTimeoutMs = Number.isSafeInteger(requestedTimeout)
    && requestedTimeout !== undefined
    && requestedTimeout > 0
    ? Math.min(requestedTimeout, LINUX_BIRTHTIME_TIMEOUT_MS)
    : LINUX_BIRTHTIME_TIMEOUT_MS;
  await dependencies.beforeLinuxStatProbe?.(path);
  const deadlineTimeoutMs = dependencies.deadlineAt === undefined
    ? configuredTimeoutMs
    : Math.floor(dependencies.deadlineAt - Date.now());
  if (deadlineTimeoutMs <= 0) {
    throw new GitError(
      "timeout",
      "The linked-worktree administrative identity scan took too long.",
    );
  }
  const timeoutMs = Math.min(configuredTimeoutMs, deadlineTimeoutMs);
  const deadlineControlsTimeout = dependencies.deadlineAt !== undefined
    && deadlineTimeoutMs <= configuredTimeoutMs;
  const args = dependencies.linuxStatArguments?.(descriptorPath, path)
    ?? [
      "--dereference",
      "--printf=%d\\0%i\\0%.9W\\0",
      "--",
      descriptorPath,
    ];
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolveProbe, rejectProbe) => {
      const invocation = runtimeOwnedProcessInvocation(executable, args);
      const child = spawnRuntimeOwnedProcess(() => spawn(invocation.command, invocation.args, {
        env: linuxStatEnvironment(),
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "ignore", fileDescriptor],
        windowsHide: true,
      }));
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | null = null;
      const fail = (error: Error): void => {
        if (failure) return;
        failure = error;
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        fail(new Error("linux-stat-timeout"));
      }, timeoutMs);
      if (!child.stdout) {
        fail(new Error("linux-stat-output-unavailable"));
      } else {
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_LINUX_BIRTHTIME_OUTPUT_BYTES) {
            fail(new Error("linux-stat-overflow"));
            return;
          }
          chunks.push(chunk);
        });
      }
      child.once("error", (error) => fail(error));
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        dependencies.afterLinuxStatClose?.();
        if (failure) {
          rejectProbe(failure);
          return;
        }
        if (code !== 0 || signal !== null) {
          rejectProbe(new Error("linux-stat-failed"));
          return;
        }
        resolveProbe(Buffer.concat(chunks, bytes).toString("utf8"));
      });
    });
  } catch (error) {
    if (
      deadlineControlsTimeout
      && error instanceof Error
      && error.message === "linux-stat-timeout"
    ) {
      throw new GitError(
        "timeout",
        "The linked-worktree administrative identity scan took too long.",
      );
    }
    throw new GitError(
      "operation-failed",
      "The Linux filesystem birth time could not be verified safely; isolated Duo worktrees are unsupported on this filesystem.",
    );
  }
  const match = /^([1-9][0-9]{0,19})\0([1-9][0-9]{0,19})\0([1-9][0-9]{0,19})\.([0-9]{9})\0$/u.exec(stdout);
  if (
    !match?.[1]
    || !match[2]
    || !match[3]
    || !match[4]
    || BigInt(match[1]) !== opened.dev
    || BigInt(match[2]) !== opened.ino
  ) {
    throw new GitError(
      "operation-failed",
      "The Linux filesystem does not expose a trustworthy directory birth time; isolated Duo worktrees are unsupported on this filesystem.",
    );
  }
  return {
    device: match[1],
    inode: match[2],
    birthtimeNs: (
      BigInt(match[3]) * 1_000_000_000n + BigInt(match[4])
    ).toString(10),
  };
}

async function captureDirectoryIdentity(
  path: string,
  dependencies: WorktreeFilesystemIdentityDependencies = {},
): Promise<WorktreeFilesystemIdentity> {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new GitError(
      "conflict",
      "The linked-worktree administrative identity is not a real directory.",
    );
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY
      | (fsConstants.O_NOFOLLOW ?? 0)
      | (fsConstants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (
      before.isSymbolicLink()
      || !before.isDirectory()
      || !opened.isDirectory()
      || after.isSymbolicLink()
      || !after.isDirectory()
      || before.dev <= 0n
      || before.ino <= 0n
      || before.dev !== opened.dev
      || before.ino !== opened.ino
      || opened.dev !== after.dev
      || opened.ino !== after.ino
      || before.ctimeNs !== opened.ctimeNs
      || opened.ctimeNs !== after.ctimeNs
    ) {
      throw new GitError(
        "conflict",
        "The linked-worktree administrative identity changed during inspection.",
      );
    }
    let openedIdentity: WorktreeFilesystemIdentity;
    if ((dependencies.platform ?? process.platform) === "linux") {
      openedIdentity = await verifyLinuxDirectoryBirthtime(
        path,
        handle.fd,
        opened,
        dependencies,
      );
      const verifiedOpened = await handle.stat({ bigint: true });
      const verifiedPath = await lstat(path, { bigint: true });
      if (
        !verifiedOpened.isDirectory()
        || verifiedPath.isSymbolicLink()
        || !verifiedPath.isDirectory()
        || opened.dev !== verifiedOpened.dev
        || opened.ino !== verifiedOpened.ino
        || verifiedOpened.dev !== verifiedPath.dev
        || verifiedOpened.ino !== verifiedPath.ino
        || opened.ctimeNs !== verifiedOpened.ctimeNs
        || verifiedOpened.ctimeNs !== verifiedPath.ctimeNs
      ) {
        throw new GitError(
          "conflict",
          "The linked-worktree administrative identity changed during birth-time verification.",
        );
      }
    } else {
      openedIdentity = durableWorktreeDirectoryIdentity(opened);
    }
    return openedIdentity;
  } finally {
    await handle.close();
  }
}

async function repositoryIdentity(
  commonDirectory: string,
  dependencies: WorktreeFilesystemIdentityDependencies = {},
): Promise<string> {
  const info = await captureDirectoryIdentity(commonDirectory, dependencies);
  return createHash("sha256").update([
    commonDirectory,
    info.device,
    info.inode,
    info.birthtimeNs,
  ].join("\0")).digest("hex");
}

export async function preflightWorktreeFilesystemIdentity(
  repositoryPath: string,
  dependencies: WorktreeFilesystemIdentityDependencies = {},
): Promise<void> {
  const root = await repositoryRoot(repositoryPath);
  const commonDirectory = await canonicalGitDirectory(root, "--git-common-dir");
  await captureDirectoryIdentity(commonDirectory, dependencies);
}

async function readBoundedIdentityFile(
  path: string,
  dependencies: OwnedWorktreeInspectionDependencies = {},
): Promise<string> {
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.size > BigInt(MAX_GIT_IDENTITY_FILE_BYTES)
  ) {
    throw new GitError(
      "conflict",
      "The linked-worktree identity metadata is invalid.",
    );
  }
  await dependencies.afterIdentityFileStat?.(path);
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.size > BigInt(MAX_GIT_IDENTITY_FILE_BYTES)
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new GitError(
        "conflict",
        "The linked-worktree identity metadata is invalid.",
      );
    }
    const buffer = Buffer.alloc(MAX_GIT_IDENTITY_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await lstat(path, { bigint: true });
    if (
      bytesRead > MAX_GIT_IDENTITY_FILE_BYTES
      || after.isSymbolicLink()
      || !after.isFile()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.ctimeNs !== opened.ctimeNs
      || after.mtimeNs !== opened.mtimeNs
    ) {
      throw new GitError(
        "conflict",
        "The linked-worktree identity metadata changed during inspection.",
      );
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function linkedWorktreeIdentity(
  root: string,
  worktreePath: string,
  beforeFilesystemIdentityCapture?: OwnedWorktreeCreationDependencies["beforeFilesystemIdentityCapture"],
  filesystemIdentityDependencies: WorktreeFilesystemIdentityDependencies = {},
): Promise<{
  filesystemReceipt: WorktreeFilesystemReceipt;
  repositoryIdentity: string;
  worktreeId: string;
}> {
  const [commonDirectory, reportedAdminDirectory] = await Promise.all([
    canonicalGitDirectory(root, "--git-common-dir"),
    reportedGitDirectory(worktreePath, "--git-dir"),
  ]);
  const worktreeDirectory = resolve(commonDirectory, "worktrees");
  await beforeFilesystemIdentityCapture?.(reportedAdminDirectory);
  let canonicalWorktreeDirectory: string;
  let gitDirectory: string;
  try {
    [canonicalWorktreeDirectory, gitDirectory] = await Promise.all([
      realpath(worktreeDirectory),
      realpath(reportedAdminDirectory),
    ]);
  } catch {
    throw new GitError(
      "conflict",
      "The linked-worktree administrative identity changed during inspection.",
    );
  }
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
  let worktreesIdentity: WorktreeFilesystemIdentity;
  let adminIdentity: WorktreeFilesystemIdentity;
  let identity: string;
  try {
    [worktreesIdentity, adminIdentity, identity] = await Promise.all([
      captureDirectoryIdentity(worktreeDirectory, filesystemIdentityDependencies),
      captureDirectoryIdentity(gitDirectory, filesystemIdentityDependencies),
      repositoryIdentity(commonDirectory, filesystemIdentityDependencies),
    ]);
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      "conflict",
      "The linked-worktree administrative identity changed during inspection.",
    );
  }
  return {
    filesystemReceipt: {
      version: 1,
      worktreesDirectory: worktreesIdentity,
      adminDirectory: adminIdentity,
    },
    repositoryIdentity: identity,
    worktreeId,
  };
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
  await preflightWorktreeFilesystemIdentity(root, dependencies.filesystemIdentity);
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
    dependencies.beforeFilesystemIdentityCapture,
    dependencies.filesystemIdentity,
  );
  hooks.added({
    branch,
    filesystemReceipt: identity.filesystemReceipt,
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

async function exactLocalBranchExists(
  root: string,
  branch: string,
): Promise<boolean> {
  const ref = `refs/heads/${branch}`;
  const result = await runGit(
    root,
    ["for-each-ref", "--format=%(refname)", ref],
    { failureMessage: "Unable to inspect the local worktree branch." },
  );
  return result.stdout.toString("utf8").split("\n").some(
    (candidate) => candidate === ref,
  );
}

export async function inspectUnacknowledgedWorktreeCreation(
  repositoryPath: string,
  worktreePath: string,
  expectedBranch: string,
): Promise<UnacknowledgedWorktreeCreationInspection> {
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
  const canonicalTarget = await canonicalizeThroughExistingParent(
    requestedTarget,
  );
  if (
    canonicalTarget === root
    || canonicalTarget === parse(canonicalTarget).root
  ) {
    throw new GitError(
      "invalid-input",
      "The main repository cannot be treated as an owned worktree.",
    );
  }

  const artifactsRemain = async (): Promise<boolean> => {
    try {
      await lstat(requestedTarget);
      return true;
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
    }
    const worktrees = await registeredWorktrees(root);
    if (worktrees.some(({ branch: registeredBranch, path }) =>
      pathsEqual(path, requestedTarget)
      || pathsEqual(path, canonicalTarget)
      || registeredBranch === branch)) return true;
    return exactLocalBranchExists(root, branch);
  };

  // Read twice before releasing durable recovery. This operation never mutates
  // Git; any present or changing artifact remains a manual-recovery outcome.
  if (await artifactsRemain()) return "retained";
  return await artifactsRemain() ? "retained" : "absent";
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
  expectedFilesystemReceipt: WorktreeFilesystemReceipt | null = null,
  dependencies: OwnedWorktreeInspectionDependencies = {},
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
    || !isWorktreeFilesystemReceipt(expectedFilesystemReceipt)
  ) {
    throw new GitError(
      "conflict",
      "The durable linked-worktree identity is unavailable.",
    );
  }
  const commonDirectory = await canonicalGitDirectory(root, "--git-common-dir");
  if (
    await repositoryIdentity(commonDirectory, dependencies.filesystemIdentity)
      !== expectedRepositoryIdentity
  ) {
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
  let currentWorktreesIdentity: WorktreeFilesystemIdentity;
  try {
    currentWorktreesIdentity = await captureDirectoryIdentity(
      worktreesDirectory,
      dependencies.filesystemIdentity,
    );
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
    const replacement = worktrees.some(({ branch: registeredBranch, path }) =>
      pathsEqual(path, requestedTarget)
      || pathsEqual(path, canonicalTarget)
      || registeredBranch === branch);
    return replacement ? { state: "conflict" } : { state: "absent" };
  }
  if (!worktreeFilesystemIdentitiesEqual(
    currentWorktreesIdentity,
    expectedFilesystemReceipt.worktreesDirectory,
  )) return { state: "conflict" };
  let currentAdminIdentity: WorktreeFilesystemIdentity;
  try {
    currentAdminIdentity = await captureDirectoryIdentity(
      adminDirectory,
      dependencies.filesystemIdentity,
    );
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
    const entries = await readdir(worktreesDirectory, { withFileTypes: true });
    if (entries.length > 1_024) return { state: "conflict" };
    const requestedScanTimeout = dependencies.administrativeScanTimeoutMs;
    const scanTimeoutMs = Number.isSafeInteger(requestedScanTimeout)
      && requestedScanTimeout !== undefined
      && requestedScanTimeout > 0
      ? Math.min(
          requestedScanTimeout,
          ADMINISTRATIVE_IDENTITY_SCAN_TIMEOUT_MS,
        )
      : ADMINISTRATIVE_IDENTITY_SCAN_TIMEOUT_MS;
    const scanDeadlineAt = Date.now() + scanTimeoutMs;
    const configuredDeadline = dependencies.filesystemIdentity?.deadlineAt;
    const scanIdentityDependencies = {
      ...dependencies.filesystemIdentity,
      deadlineAt: configuredDeadline === undefined
        ? scanDeadlineAt
        : Math.min(configuredDeadline, scanDeadlineAt),
    };
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (Date.now() >= scanIdentityDependencies.deadlineAt) {
        throw new GitError(
          "timeout",
          "The linked-worktree administrative identity scan took too long.",
        );
      }
      try {
        const identity = await captureDirectoryIdentity(
          resolve(worktreesDirectory, entry.name),
          scanIdentityDependencies,
        );
        if (worktreeFilesystemIdentitiesEqual(
          identity,
          expectedFilesystemReceipt.adminDirectory,
        )) return { state: "conflict" };
      } catch (error) {
        if (error instanceof GitError && error.code === "timeout") throw error;
        return { state: "conflict" };
      }
    }
    const verifiedParent = await captureDirectoryIdentity(
      worktreesDirectory,
      scanIdentityDependencies,
    );
    if (!worktreeFilesystemIdentitiesEqual(
      verifiedParent,
      expectedFilesystemReceipt.worktreesDirectory,
    )) return { state: "conflict" };
    const replacement = worktrees.some(({ branch: registeredBranch, path }) =>
      pathsEqual(path, requestedTarget)
      || pathsEqual(path, canonicalTarget)
      || registeredBranch === branch);
    return replacement ? { state: "conflict" } : { state: "absent" };
  }
  if (!worktreeFilesystemIdentitiesEqual(
    currentAdminIdentity,
    expectedFilesystemReceipt.adminDirectory,
  )) return { state: "conflict" };
  const rawGitdir = await readBoundedIdentityFile(
    resolve(adminDirectory, "gitdir"),
    dependencies,
  );
  const [verifiedAdmin, verifiedParent] = await Promise.all([
    captureDirectoryIdentity(adminDirectory, dependencies.filesystemIdentity),
    captureDirectoryIdentity(
      worktreesDirectory,
      dependencies.filesystemIdentity,
    ),
  ]);
  if (
    !worktreeFilesystemIdentitiesEqual(
      verifiedAdmin,
      expectedFilesystemReceipt.adminDirectory,
    )
    || !worktreeFilesystemIdentitiesEqual(
      verifiedParent,
      expectedFilesystemReceipt.worktreesDirectory,
    )
  ) return { state: "conflict" };
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
      filesystemReceipt: expectedFilesystemReceipt,
      repositoryIdentity: expectedRepositoryIdentity,
      worktreeId: expectedWorktreeId,
    },
  };
}

export async function removeOwnedWorktree(
  repositoryPath: string,
  worktreePath: string,
  expectedBranch: string,
  expectedHead: string,
  expectedWorktreeId: string,
  expectedRepositoryIdentity: string,
  expectedOwnershipToken: string,
  expectedFilesystemReceipt: WorktreeFilesystemReceipt,
  dependencies: OwnedWorktreeRemovalDependencies = {},
): Promise<OwnedWorktreeRemovalOutcome> {
  const root = await repositoryRoot(repositoryPath);
  const canonicalExpectedPath = await realpath(worktreePath).catch(() =>
    resolve(worktreePath));
  const inspect = async (): Promise<OwnedWorktreeCleanupInspection> =>
    await inspectOwnedWorktreeCleanupState(
      root,
      worktreePath,
      expectedBranch,
      expectedHead,
      expectedWorktreeId,
      expectedRepositoryIdentity,
      expectedOwnershipToken,
      expectedFilesystemReceipt,
      dependencies,
    );
  const matchesExpectedTopology = (
    inspection: OwnedWorktreeCleanupInspection,
  ): inspection is Extract<
    OwnedWorktreeCleanupInspection,
    { state: "registered" }
  > => inspection.state === "registered"
    && pathsEqual(inspection.identity.path, canonicalExpectedPath)
    && inspection.identity.branch === expectedBranch
    && inspection.identity.head === expectedHead;
  const initial = await inspect();
  if (initial.state !== "registered") return initial.state;
  if (!matchesExpectedTopology(initial)) return "conflict";
  await dependencies.afterInitialInspection?.();
  const atUse = await inspect();
  if (atUse.state !== "registered") return atUse.state;
  if (!matchesExpectedTopology(atUse)) return "conflict";
  await dependencies.afterFinalValidation?.();
  // Git cannot atomically bind `worktree remove` to the identity inspected
  // above. A same-user process can replace the registration between the
  // check and Git's own path lookup, so every registered checkout is retained
  // for explicit manual removal. Once Git reports it absent, the owning chat
  // can be deleted safely without touching filesystem content.
  return "retained";
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
