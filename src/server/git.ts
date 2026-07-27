import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type {
  DiffLine,
  DiffReversalOperation,
  DiffReversalPlan,
  DiffReversalValidation,
  TurnGitArtifactFile,
} from "../shared/contracts";
import { parseUnifiedDiff, sha256 } from "../shared/diff-review";
import {
  ReversalRegistryController,
  ReversalRegistryError,
  REVERSAL_MAX_ACTIVE_BACKUPS,
  type ReversalCheckoutIdentity,
  type ReversalOperationRecord,
  type ReversalRegistryStorage,
  type ReversalRepositoryIdentity,
} from "./reversal-registry";

const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_DIFF_BYTES = 512 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const DEFAULT_DIFF_FILES = 50;
const MAX_DIFF_FILES = 100;
const STDERR_BYTES = 16 * 1024;
const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_PATH_LENGTH = 4_096;

export type GitErrorCode =
  | "invalid-input"
  | "not-repository"
  | "not-found"
  | "conflict"
  | "nothing-to-commit"
  | "authentication"
  | "output-limit"
  | "timeout"
  | "git-unavailable"
  | "operation-failed";

/** An error whose message is safe to show directly in the application UI. */
export class GitError extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string) {
    super(message.slice(0, 240));
    this.name = "GitError";
    this.code = code;
  }
}

export type GitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "unmerged"
  | "type-changed"
  | "unknown";

export interface GitChangedFile {
  path: string;
  previousPath: string | null;
  status: GitFileStatus;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface GitRepositoryStatus {
  root: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
  insertions: number;
  deletions: number;
  clean: boolean;
  truncated: boolean;
}

export interface GitDiffOptions {
  maxFiles?: number;
  maxBytes?: number;
  paths?: string[];
  ignoreWhitespace?: boolean;
}

export interface GitUnifiedDiff {
  text: string;
  filesIncluded: number;
  totalFiles: number;
  truncated: boolean;
}

export interface GitDiffSelection {
  fingerprint: string;
  filePath: string;
  hunkId: string;
  lineIds: readonly string[];
  ignoreWhitespace?: boolean;
  expected?: DiffReversalValidation;
}

export interface GitDiffReversalResult {
  diff: GitUnifiedDiff;
  operation: DiffReversalOperation;
}

export interface GitBranch {
  name: string;
  kind: "local" | "remote";
  current: boolean;
  commit: string;
  upstream: string | null;
}

export interface GitBranches {
  current: string | null;
  local: GitBranch[];
  remote: GitBranch[];
}

export interface GitMutationResult {
  status: GitRepositoryStatus;
}

export interface GitArtifactState {
  root: string;
  branch: string | null;
  repositoryIdentity: string;
  worktreeIdentity: string;
  fingerprint: string;
}

export interface GitSnapshotComparison {
  patch: string;
  files: TurnGitArtifactFile[];
  insertions: number;
  deletions: number;
  summaryTruncated: boolean;
  patchTruncated: boolean;
  truncated: boolean;
}

export interface GitCommitResult extends GitMutationResult {
  commit: string;
}

export interface CreateWorktreeOptions {
  branch?: string;
  createBranch?: boolean;
  startPoint?: string;
}

interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
}

interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  truncateOutput?: boolean;
  input?: Buffer;
  failureMessage: string;
}

interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
  truncated: boolean;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new GitError("invalid-input", "The requested limit is invalid.");
  return Math.min(value, maximum);
}

function utf8Prefix(buffer: Buffer, maxBytes: number): string {
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function requireDirectory(path: string): Promise<string> {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes("\0")) {
    throw new GitError("invalid-input", "The repository path is invalid.");
  }
  try {
    const canonical = await realpath(resolve(path));
    if (!(await stat(canonical)).isDirectory()) throw new Error();
    return canonical;
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError("not-found", "The repository folder could not be found.");
  }
}

function classifyFailure(stderr: string, fallback: string): GitError {
  const detail = stderr.toLowerCase();
  if (detail.includes("not a git repository") || detail.includes("not a git directory")) {
    return new GitError("not-repository", "The selected folder is not a Git repository.");
  }
  if (detail.includes("nothing to commit") || detail.includes("no changes added to commit")) {
    return new GitError("nothing-to-commit", "There are no changes to commit.");
  }
  if (
    detail.includes("authentication failed") ||
    detail.includes("could not read username") ||
    detail.includes("permission denied (publickey)")
  ) {
    return new GitError("authentication", "Git authentication failed. Check the repository credentials and try again.");
  }
  if (
    detail.includes("would be overwritten") ||
    detail.includes("merge conflict") ||
    detail.includes("resolve your current index first") ||
    detail.includes("not possible to fast-forward")
  ) {
    return new GitError("conflict", "Git could not complete the operation because the repository has conflicting changes.");
  }
  return new GitError("operation-failed", fallback);
}

function runGit(cwd: string, args: readonly string[], options: RunOptions): Promise<ProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? LOCAL_TIMEOUT_MS;

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        LC_ALL: "C",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;

    const finish = (error?: GitError, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectProcess(error);
      else if (result) resolveProcess(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new GitError("timeout", "Git took too long to complete the operation."));
    }, timeoutMs);
    timer.unref();
    if (options.input && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length <= remaining) {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
        return;
      }
      if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
      stdoutBytes = maxOutputBytes;
      truncated = true;
      child.kill("SIGKILL");
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_BYTES) return;
      const part = chunk.subarray(0, STDERR_BYTES - stderrBytes);
      stderr.push(part);
      stderrBytes += part.length;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish(new GitError("git-unavailable", "Git is not installed or could not be started."));
      else finish(new GitError("operation-failed", options.failureMessage));
    });
    child.on("close", (code) => {
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated };
      if (truncated && !options.truncateOutput) {
        finish(new GitError("output-limit", "Git returned more data than this application can safely process."));
      } else if (code === 0 || (truncated && options.truncateOutput)) {
        finish(undefined, result);
      } else {
        finish(classifyFailure(result.stderr.toString("utf8"), options.failureMessage));
      }
    });
  });
}

async function repositoryRoot(repositoryPath: string): Promise<string> {
  const directory = await requireDirectory(repositoryPath);
  const result = await runGit(directory, ["rev-parse", "--show-toplevel"], {
    maxOutputBytes: MAX_PATH_LENGTH,
    failureMessage: "Unable to inspect this Git repository.",
  });
  const reported = result.stdout.toString("utf8").trim();
  if (!isAbsolute(reported)) throw new GitError("not-repository", "The selected folder is not a Git repository.");
  try {
    return await realpath(reported);
  } catch {
    throw new GitError("not-repository", "The selected folder is not a Git repository.");
  }
}

function validateName(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("-") ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new GitError("invalid-input", `${label} is invalid.`);
  }
  return value;
}

async function validateBranch(root: string, branch: string): Promise<string> {
  const name = validateName(branch, "The branch name");
  await runGit(root, ["check-ref-format", "--branch", name], {
    maxOutputBytes: 1_024,
    failureMessage: "The branch name is invalid.",
  }).catch(() => {
    throw new GitError("invalid-input", "The branch name is invalid.");
  });
  return name;
}

async function validatedPaths(root: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0 || paths.length > MAX_DIFF_FILES) {
    throw new GitError("invalid-input", "Select between 1 and 100 repository files.");
  }
  const unique = new Set<string>();
  for (const input of paths) {
    if (
      typeof input !== "string" ||
      input.length === 0 ||
      input.length > MAX_PATH_LENGTH ||
      isAbsolute(input) ||
      input.startsWith(":") ||
      /[\0\r\n]/u.test(input)
    ) {
      throw new GitError("invalid-input", "A selected file path is invalid.");
    }
    const absolute = resolve(root, input);
    if (!isContained(root, absolute) || absolute === root) {
      throw new GitError("invalid-input", "A selected file is outside the repository.");
    }
    try {
      const canonical = await realpath(absolute);
      if (!isContained(root, canonical)) throw new GitError("invalid-input", "A selected file resolves outside the repository.");
    } catch (error) {
      if (error instanceof GitError) throw error;
      let ancestor = absolute;
      while (ancestor !== root) {
        try {
          const info = await lstat(ancestor);
          if (info.isSymbolicLink()) throw new GitError("invalid-input", "A selected file uses an unsafe symbolic link.");
          break;
        } catch (ancestorError) {
          if (ancestorError instanceof GitError) throw ancestorError;
          ancestor = resolve(ancestor, "..");
        }
      }
    }
    unique.add(relative(root, absolute).split(sep).join("/"));
  }
  return [...unique];
}

function primaryStatus(indexStatus: string, worktreeStatus: string): GitFileStatus {
  const codes = `${indexStatus}${worktreeStatus}`;
  if (codes.includes("U") || codes === "AA" || codes === "DD") return "unmerged";
  if (codes.includes("R")) return "renamed";
  if (codes.includes("C")) return "copied";
  if (codes.includes("A") || codes.includes("?")) return codes.includes("?") ? "untracked" : "added";
  if (codes.includes("D")) return "deleted";
  if (codes.includes("T")) return "type-changed";
  if (codes.includes("M")) return "modified";
  return "unknown";
}

function changedFile(path: string, indexStatus: string, worktreeStatus: string, previousPath: string | null): GitChangedFile {
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
      if (path) files.push(changedFile(path, xy[0] ?? ".", xy[1] ?? ".", null));
    } else if (record.startsWith("2 ")) {
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(9).join(" ");
      const previousPath = fields[index + 1] ?? null;
      index += 1;
      if (path) files.push(changedFile(path, xy[0] ?? ".", xy[1] ?? ".", previousPath));
    } else if (record.startsWith("? ")) {
      files.push(changedFile(record.slice(2), "?", "?", null));
    }
  }
  return { branch, detached, upstream, ahead, behind, files, truncated: false };
}

function parseNumstat(buffer: Buffer): Map<string, { insertions: number; deletions: number; binary: boolean }> {
  const values = buffer.toString("utf8").split("\0");
  const result = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
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

async function hasHead(root: string): Promise<boolean> {
  try {
    await runGit(root, ["rev-parse", "--verify", "HEAD"], {
      maxOutputBytes: 256,
      failureMessage: "Unable to inspect the current commit.",
    });
    return true;
  } catch (error) {
    if (error instanceof GitError && error.code === "operation-failed") return false;
    throw error;
  }
}

export async function getRepositoryStatus(repositoryPath: string): Promise<GitRepositoryStatus> {
  const root = await repositoryRoot(repositoryPath);
  const statusResult = await runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
    maxOutputBytes: DEFAULT_OUTPUT_BYTES,
    truncateOutput: true,
    failureMessage: "Unable to read the repository status.",
  });
  const parsed = parsePorcelain(statusResult.stdout);
  const statsResult = await runGit(
    root,
    (await hasHead(root))
      ? ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "HEAD", "--"]
      : ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--cached", "--"],
    {
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
    insertions: parsed.files.reduce((total, file) => total + file.insertions, 0),
    deletions: parsed.files.reduce((total, file) => total + file.deletions, 0),
    clean: parsed.files.length === 0,
    truncated: parsed.truncated || statusResult.truncated || statsResult.truncated,
  };
}

function validateArtifactRef(ref: string): string {
  if (
    typeof ref !== "string"
    || ref.length > 500
    || !/^refs\/inertia\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u.test(ref)
  ) {
    throw new GitError("invalid-input", "The historical Git reference is invalid.");
  }
  return ref;
}

async function canonicalGitDirectory(root: string, args: readonly string[]): Promise<string> {
  const result = await runGit(root, [...args], {
    maxOutputBytes: MAX_PATH_LENGTH,
    failureMessage: "Unable to inspect the repository identity.",
  });
  const value = result.stdout.toString("utf8").trim();
  if (!value || value.includes("\0")) {
    throw new GitError("operation-failed", "Git returned an invalid repository identity.");
  }
  try {
    return await realpath(isAbsolute(value) ? value : resolve(root, value));
  } catch {
    throw new GitError("operation-failed", "The repository identity is unavailable.");
  }
}

/**
 * Captures a path-safe identity and full-state fingerprint. The fingerprint
 * includes the durable snapshot tree, HEAD, index tree and porcelain state;
 * absolute paths are hashed and never projected to renderer snapshots.
 */
export async function captureGitArtifactState(
  repositoryPath: string,
  snapshotRef: string,
): Promise<GitArtifactState> {
  const root = await repositoryRoot(repositoryPath);
  const ref = validateArtifactRef(snapshotRef);
  const [status, commonDirectory, gitDirectory, snapshotOid, head, indexTree, porcelain] = await Promise.all([
    getRepositoryStatus(root),
    canonicalGitDirectory(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      .catch(() => canonicalGitDirectory(root, ["rev-parse", "--git-common-dir"])),
    canonicalGitDirectory(root, ["rev-parse", "--path-format=absolute", "--git-dir"])
      .catch(() => canonicalGitDirectory(root, ["rev-parse", "--git-dir"])),
    runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`], {
      maxOutputBytes: 256,
      failureMessage: "The historical Git snapshot is unavailable.",
    }).then(({ stdout }) => stdout.toString("utf8").trim()),
    runGit(root, ["rev-parse", "--verify", "HEAD"], {
      maxOutputBytes: 256,
      failureMessage: "Unable to inspect the current commit.",
    }).then(({ stdout }) => stdout.toString("utf8").trim()).catch(() => ""),
    runGit(root, ["write-tree"], {
      maxOutputBytes: 256,
      failureMessage: "Unable to inspect the Git index.",
    }).then(({ stdout }) => stdout.toString("utf8").trim()).catch(() => ""),
    runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
      maxOutputBytes: DEFAULT_OUTPUT_BYTES,
      truncateOutput: true,
      failureMessage: "Unable to fingerprint the repository state.",
    }),
  ]);
  const repositoryIdentity = createHash("sha256").update(commonDirectory).digest("hex");
  const worktreeIdentity = createHash("sha256")
    .update(`${root}\0${gitDirectory}`)
    .digest("hex");
  return {
    root,
    branch: status.branch,
    repositoryIdentity,
    worktreeIdentity,
    fingerprint: createHash("sha256")
      .update([
        snapshotOid,
        head,
        indexTree,
        porcelain.stdout.toString("base64"),
        repositoryIdentity,
        worktreeIdentity,
      ].join("\0"))
      .digest("hex"),
  };
}

function artifactStatus(value: string): TurnGitArtifactFile["status"] {
  if (value.startsWith("R")) return "renamed";
  if (value.startsWith("C")) return "copied";
  if (value === "A") return "added";
  if (value === "D") return "deleted";
  if (value === "T") return "type-changed";
  if (value === "U") return "unmerged";
  if (value === "M") return "modified";
  return "unknown";
}

function parseSnapshotNames(buffer: Buffer): Array<{
  path: string;
  previousPath: string | null;
  status: TurnGitArtifactFile["status"];
}> {
  const fields = buffer.toString("utf8").split("\0");
  const files: Array<{
    path: string;
    previousPath: string | null;
    status: TurnGitArtifactFile["status"];
  }> = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++] ?? "";
    if (!code) continue;
    const renamed = code.startsWith("R") || code.startsWith("C");
    const previousPath = renamed ? fields[index++] ?? "" : null;
    const path = fields[index++] ?? "";
    if (!path || (renamed && !previousPath)) continue;
    files.push({ path, previousPath, status: artifactStatus(code) });
  }
  return files;
}

export async function compareGitSnapshots(
  repositoryPath: string,
  beforeReference: string,
  afterReference: string,
  options: Pick<GitDiffOptions, "maxBytes" | "paths"> = {},
): Promise<GitSnapshotComparison> {
  const root = await repositoryRoot(repositoryPath);
  const beforeRef = validateArtifactRef(beforeReference);
  const afterRef = validateArtifactRef(afterReference);
  const paths = options.paths ? await validatedPaths(root, options.paths) : [];
  const pathArgs = paths.length > 0 ? ["--", ...paths] : ["--"];
  const maxBytes = boundedInteger(options.maxBytes, MAX_DIFF_BYTES, MAX_DIFF_BYTES);
  await Promise.all([beforeRef, afterRef].map((ref) => runGit(
    root,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { maxOutputBytes: 256, failureMessage: "A historical Git snapshot is unavailable." },
  )));
  const [names, stats, patch] = await Promise.all([
    runGit(root, ["diff", "--name-status", "-z", "--find-renames", beforeRef, afterRef, ...pathArgs], {
      maxOutputBytes: DEFAULT_OUTPUT_BYTES,
      truncateOutput: true,
      failureMessage: "Unable to inspect historical changed files.",
    }),
    runGit(root, ["diff", "--numstat", "-z", "--find-renames", beforeRef, afterRef, ...pathArgs], {
      maxOutputBytes: DEFAULT_OUTPUT_BYTES,
      truncateOutput: true,
      failureMessage: "Unable to inspect historical change totals.",
    }),
    runGit(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--full-index",
      "--unified=3",
      beforeRef,
      afterRef,
      ...pathArgs,
    ], {
      maxOutputBytes: maxBytes,
      truncateOutput: true,
      failureMessage: "Unable to generate the historical Git diff.",
    }),
  ]);
  const statByPath = parseNumstat(stats.stdout);
  const allFiles = parseSnapshotNames(names.stdout).map((file): TurnGitArtifactFile => {
    const stat = statByPath.get(file.path)
      ?? (file.previousPath ? statByPath.get(file.previousPath) : undefined);
    return {
      ...file,
      insertions: stat?.insertions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary ?? false,
      untracked: false,
      staged: false,
      unstaged: false,
      indexStatus: ".",
      worktreeStatus: ".",
    };
  });
  const files = allFiles.slice(0, 200);
  const summaryTruncated = names.truncated
    || stats.truncated
    || allFiles.length > files.length;
  const patchTruncated = patch.truncated;
  return {
    patch: utf8Prefix(patch.stdout, maxBytes),
    files,
    insertions: allFiles.reduce((total, file) => total + file.insertions, 0),
    deletions: allFiles.reduce((total, file) => total + file.deletions, 0),
    summaryTruncated,
    patchTruncated,
    truncated: summaryTruncated || patchTruncated,
  };
}

async function untrackedPreview(root: string, path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const absolute = resolve(root, path);
  if (!isContained(root, absolute)) return { text: "", truncated: false };
  try {
    const canonical = await realpath(absolute);
    if (!isContained(root, canonical)) return { text: "", truncated: false };
    const info = await stat(canonical);
    if (!info.isFile()) return { text: "", truncated: false };
    const file = await import("node:fs/promises").then(({ open }) => open(canonical, fsConstants.O_RDONLY));
    try {
      const bytes = Math.min(info.size, maxBytes + 1);
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await file.read(buffer, 0, bytes, 0);
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) return { text: `Binary file ${path} is untracked.\n`, truncated: false };
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, maxBytes));
      const sourceLines = decoded.endsWith("\n") ? decoded.slice(0, -1).split("\n") : decoded.split("\n");
      const lines = sourceLines.map((line) => `+${line}`).join("\n");
      return {
        text: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${sourceLines.length} @@\n${lines}\n`,
        truncated: info.size > maxBytes,
      };
    } finally {
      await file.close();
    }
  } catch {
    return { text: `Unable to preview untracked file ${path}.\n`, truncated: false };
  }
}

export async function getUnifiedDiff(repositoryPath: string, options: GitDiffOptions = {}): Promise<GitUnifiedDiff> {
  const root = await repositoryRoot(repositoryPath);
  const maxFiles = boundedInteger(options.maxFiles, DEFAULT_DIFF_FILES, MAX_DIFF_FILES);
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_DIFF_BYTES, MAX_DIFF_BYTES);
  const status = await getRepositoryStatus(root);
  const requested = options.paths ? await validatedPaths(root, options.paths) : null;
  const requestedSet = requested ? new Set(requested) : null;
  const candidates = status.files.filter((file) => !requestedSet || requestedSet.has(file.path));
  const selected = candidates.slice(0, maxFiles);
  const tracked = selected
    .filter((file) => file.status !== "untracked")
    .flatMap((file) => (file.previousPath ? [file.previousPath, file.path] : [file.path]));
  let text = "";
  let truncated = candidates.length > selected.length;

  if (tracked.length > 0) {
    const baseArgs = ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", ...(options.ignoreWhitespace ? ["--ignore-all-space"] : [])];
    const args = (await hasHead(root))
      ? [...baseArgs, "HEAD", "--", ...tracked]
      : [...baseArgs, "--cached", "--", ...tracked];
    const result = await runGit(root, args, {
      maxOutputBytes: maxBytes,
      truncateOutput: true,
      failureMessage: "Unable to generate the repository diff.",
    });
    text = utf8Prefix(result.stdout, maxBytes);
    truncated ||= result.truncated;
  }

  for (const file of selected) {
    if (file.status !== "untracked") continue;
    const remaining = maxBytes - Buffer.byteLength(text);
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const preview = await untrackedPreview(root, file.path, remaining);
    const previewBuffer = Buffer.from(preview.text);
    text += utf8Prefix(previewBuffer, remaining);
    truncated ||= preview.truncated || previewBuffer.length > remaining;
  }
  return { text, filesIncluded: selected.length, totalFiles: candidates.length, truncated };
}

interface IndexEntry {
  mode: string;
  oid: string;
  content: Buffer;
}

interface ReversalState {
  root: string;
  plan: DiffReversalPlan;
  absolute: string;
  worktreeMode: number;
  worktreeContent: Buffer;
  index: IndexEntry;
  selectedWorktreeLines: DiffLine[];
  selectedIndexLines: DiffLine[];
}

function bufferHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function textBuffer(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new GitError("invalid-input", "Selective reversal supports UTF-8 text files only.");
  }
}

async function completeRepositoryDiff(root: string, ignoreWhitespace = false): Promise<GitUnifiedDiff> {
  const diff = await getUnifiedDiff(root, {
    maxBytes: MAX_DIFF_BYTES,
    maxFiles: MAX_DIFF_FILES,
    ignoreWhitespace,
  });
  if (diff.truncated) {
    throw new GitError("output-limit", "The complete repository diff is too large to reverse safely. Narrow the change set first.");
  }
  return diff;
}

async function completeLayerPatch(root: string, layer: "index" | "worktree", path?: string, ignoreWhitespace = false): Promise<string> {
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    "--unified=3",
    ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
    ...(layer === "index" ? ["--cached", "HEAD"] : []),
    "--",
    ...(path ? [path] : []),
  ];
  try {
    const result = await runGit(root, args, {
      maxOutputBytes: MAX_DIFF_BYTES,
      failureMessage: `Unable to inspect the ${layer === "index" ? "Git index" : "working tree"}.`,
    });
    return result.stdout.toString("utf8");
  } catch (error) {
    if (error instanceof GitError && error.code === "output-limit") {
      throw new GitError("output-limit", "The staged or unstaged diff is too large to reverse safely. Narrow the change set first.");
    }
    throw error;
  }
}

async function repositoryStateFingerprint(root: string): Promise<string> {
  const [combined, staged, unstaged, status] = await Promise.all([
    completeRepositoryDiff(root),
    completeLayerPatch(root, "index"),
    completeLayerPatch(root, "worktree"),
    runGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
      maxOutputBytes: MAX_DIFF_BYTES,
      failureMessage: "Unable to validate the repository state.",
    }),
  ]);
  return sha256([
    combined.text,
    staged,
    unstaged,
    status.stdout.toString("utf8"),
  ].join("\0"));
}

async function readIndexEntry(root: string, path: string): Promise<IndexEntry> {
  const listed = await runGit(root, ["ls-files", "--stage", "-z", "--", path], {
    maxOutputBytes: MAX_PATH_LENGTH + 256,
    failureMessage: "Unable to inspect the selected file in the Git index.",
  });
  const records = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  if (records.length !== 1) throw new GitError("conflict", "The selected file does not have one resolved Git index entry.");
  const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t([\s\S]+)$/u.exec(records[0]!);
  if (!match || match[3] !== path) throw new GitError("conflict", "The selected file has an unsupported or unresolved Git index state.");
  const content = await runGit(root, ["cat-file", "blob", match[2]!], {
    maxOutputBytes: MAX_DIFF_BYTES,
    failureMessage: "Unable to read the selected staged file.",
  });
  return { mode: match[1]!, oid: match[2]!, content: content.stdout };
}

function selectedLineSignature(line: DiffLine): string {
  if (line.kind === "deletion") return `deletion\0${line.oldLineNumber ?? -1}\0${line.content}`;
  return `addition\0${line.oldInsertionIndex}\0${line.content}`;
}

function reversalText(source: Buffer, selected: readonly DiffLine[]): Buffer {
  const text = textBuffer(source);
  if (text.includes("\0")) throw new GitError("invalid-input", "Binary files cannot be reverted by selection.");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, text.length - newline.length) : text;
  const fileLines = body ? body.split(newline) : [];

  const ordered = selected
    .map((line, order) => ({
      line,
      order,
      position: line.kind === "addition" ? (line.newLineNumber ?? 1) - 1 : line.newInsertionIndex,
    }))
    .sort((left, right) => left.position - right.position || left.order - right.order)
    .map(({ line }) => line);
  for (const line of ordered.reverse()) {
    if (line.kind === "addition") {
      const index = (line.newLineNumber ?? 0) - 1;
      if (index < 0 || index >= fileLines.length || fileLines[index] !== line.content) {
        throw new GitError("conflict", "The selected lines no longer match the file or Git layer. Refresh the diff and try again.");
      }
      const removedFinalLine = index === fileLines.length - 1;
      fileLines.splice(index, 1);
      if (removedFinalLine && line.noFinalNewline) trailingNewline = fileLines.length > 0;
    } else if (line.kind === "deletion") {
      const index = Math.max(0, Math.min(line.newInsertionIndex, fileLines.length));
      fileLines.splice(index, 0, line.content);
      if (index === fileLines.length - 1 && line.noFinalNewline) trailingNewline = false;
    }
  }
  const next = `${fileLines.join(newline)}${trailingNewline && fileLines.length > 0 ? newline : ""}`;
  return Buffer.from(next, "utf8");
}

function hunkFingerprint(header: string, lines: readonly DiffLine[]): string {
  return sha256(JSON.stringify({
    header,
    lines: lines.map((line) => ({
      id: line.id,
      kind: line.kind,
      content: line.content,
      patchLine: line.patchLine,
      oldLineNumber: line.oldLineNumber,
      newLineNumber: line.newLineNumber,
      oldInsertionIndex: line.oldInsertionIndex,
      newInsertionIndex: line.newInsertionIndex,
      noFinalNewline: line.noFinalNewline ?? false,
    })),
  }));
}

async function buildReversalState(root: string, selection: GitDiffSelection): Promise<ReversalState> {
  if (!(await hasHead(root))) throw new GitError("invalid-input", "Selective reversal requires a repository with an initial commit.");
  const status = await getRepositoryStatus(root);
  if (status.truncated) throw new GitError("output-limit", "The complete Git status is too large to validate safely.");
  const statusFile = status.files.find((candidate) => candidate.path === selection.filePath);
  if (!statusFile) throw new GitError("not-found", "The selected file is no longer changed.");
  if (statusFile.status === "unmerged") throw new GitError("conflict", "Resolve this file's Git conflict before selectively reverting it.");
  if (statusFile.status === "renamed" || statusFile.status === "copied") {
    throw new GitError("invalid-input", "Renamed and copied files must be reverted as a whole so both paths remain consistent.");
  }
  if (statusFile.status === "deleted") throw new GitError("invalid-input", "Deleted files must be restored as a whole from source control.");
  if (statusFile.status === "untracked" || statusFile.status === "added") {
    throw new GitError("invalid-input", "New and untracked files must be removed or edited directly; selective Git reversal is unavailable.");
  }
  if (statusFile.status === "type-changed") {
    throw new GitError("invalid-input", "Type-changed files must be restored as a whole from source control.");
  }
  if (statusFile.status !== "modified" || ![".", "M"].includes(statusFile.indexStatus) || ![".", "M"].includes(statusFile.worktreeStatus)) {
    throw new GitError("invalid-input", "This file's Git state is not supported for selective reversal.");
  }

  const stateBefore = await repositoryStateFingerprint(root);
  const current = await completeRepositoryDiff(root, selection.ignoreWhitespace);
  const structured = parseUnifiedDiff(current.text);
  if (structured.fingerprint !== selection.fingerprint) {
    throw new GitError("conflict", "The complete diff changed since this selection was made. Refresh the diff and try again.");
  }
  const file = structured.files.find((candidate) => candidate.path === selection.filePath);
  const hunk = file?.hunks.find((candidate) => candidate.id === selection.hunkId);
  if (!file || !hunk) throw new GitError("not-found", "The selected diff hunk is no longer available.");
  const selectedIds = new Set(selection.lineIds);
  if (selectedIds.size !== selection.lineIds.length || hunk.lines.filter((line) => selectedIds.has(line.id)).length !== selectedIds.size) {
    throw new GitError("conflict", "The selected line range no longer matches the complete current hunk.");
  }
  const selectedAll = hunk.lines.filter((line) => selectedIds.has(line.id));
  const selectedWorktreeLines = selectedAll.filter((line) => line.kind === "addition" || line.kind === "deletion");
  if (selectedWorktreeLines.length === 0) throw new GitError("invalid-input", "Select at least one added or removed line to revert.");

  const validated = await validatedPaths(root, [file.path]);
  const absolute = resolve(root, validated[0]!);
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(absolute); }
  catch { throw new GitError("conflict", "The selected file disappeared before it could be validated."); }
  if (info.isSymbolicLink()) throw new GitError("invalid-input", "Symbolic links must be restored as a whole from source control.");
  if (!info.isFile()) throw new GitError("invalid-input", "Only regular text files can be reverted by selection.");
  if (info.size > MAX_DIFF_BYTES) throw new GitError("output-limit", "The selected file is too large to reverse safely.");

  const [worktreeContent, index, stagedPatch] = await Promise.all([
    readFile(absolute),
    readIndexEntry(root, file.path),
    completeLayerPatch(root, "index", file.path, selection.ignoreWhitespace),
  ]);
  textBuffer(worktreeContent);
  textBuffer(index.content);
  const stagedFile = parseUnifiedDiff(stagedPatch).files.find((candidate) => candidate.path === file.path);
  const stagedCandidates = stagedFile?.hunks.flatMap((candidate) => candidate.lines)
    .filter((line) => line.kind === "addition" || line.kind === "deletion") ?? [];
  const fullCandidates = file.hunks.flatMap((candidate) => candidate.lines)
    .filter((line) => line.kind === "addition" || line.kind === "deletion");
  const usedStaged = new Set<string>();
  const stagedByFullId = new Map<string, DiffLine>();
  for (const line of fullCandidates) {
    const signature = selectedLineSignature(line);
    const match = stagedCandidates.find((candidate) => !usedStaged.has(candidate.id) && selectedLineSignature(candidate) === signature);
    if (match) {
      usedStaged.add(match.id);
      stagedByFullId.set(line.id, match);
    }
  }
  const anchors = new Set(fullCandidates.filter((line) => line.kind === "addition").map((line) => line.oldInsertionIndex));
  for (const anchor of anchors) {
    const unmatchedFull = fullCandidates.filter((line) => line.kind === "addition" && line.oldInsertionIndex === anchor && !stagedByFullId.has(line.id));
    const unmatchedStaged = stagedCandidates.filter((line) => line.kind === "addition" && line.oldInsertionIndex === anchor && !usedStaged.has(line.id));
    if (unmatchedFull.length === unmatchedStaged.length) {
      unmatchedFull.forEach((line, index) => {
        const staged = unmatchedStaged[index];
        if (staged) {
          stagedByFullId.set(line.id, staged);
          usedStaged.add(staged.id);
        }
      });
    } else if (
      unmatchedStaged.length > 0
      && unmatchedFull.some((line) => selectedWorktreeLines.some((selected) => selected.id === line.id))
    ) {
      throw new GitError("invalid-input", "This selected addition overlaps differently staged content and cannot be reversed without risking unrelated index changes.");
    }
  }
  const selectedIndexLines = selectedWorktreeLines.flatMap((line) => {
    const staged = stagedByFullId.get(line.id);
    return staged ? [staged] : [];
  });
  // Validate both transformations before exposing the plan.
  reversalText(worktreeContent, selectedWorktreeLines);
  if (selectedIndexLines.length > 0) reversalText(index.content, selectedIndexLines);

  const stateAfter = await repositoryStateFingerprint(root);
  if (stateAfter !== stateBefore) throw new GitError("conflict", "The repository changed while the reversal was being inspected. Refresh and try again.");
  const affectedLayers: Array<"index" | "worktree"> = [
    ...(selectedIndexLines.length > 0 ? ["index" as const] : []),
    "worktree",
  ];
  const validation: DiffReversalValidation = {
    diffFingerprint: structured.fingerprint,
    fileFingerprint: bufferHash(worktreeContent),
    hunkFingerprint: hunkFingerprint(hunk.header, hunk.lines),
    selectionFingerprint: sha256(JSON.stringify(selectedAll.map((line) => ({
      id: line.id,
      kind: line.kind,
      content: line.content,
      patchLine: line.patchLine,
    })))),
    gitStateFingerprint: stateAfter,
  };
  return {
    root,
    absolute,
    worktreeMode: info.mode,
    worktreeContent,
    index,
    selectedWorktreeLines,
    selectedIndexLines,
    plan: {
      filePath: file.path,
      hunkId: hunk.id,
      hunkHeader: hunk.header,
      selectedLineCount: selectedAll.length,
      changedLineCount: selectedWorktreeLines.length,
      affectedLayers,
      validation,
    },
  };
}

function sameValidation(left: DiffReversalValidation, right: DiffReversalValidation): boolean {
  return left.diffFingerprint === right.diffFingerprint
    && left.fileFingerprint === right.fileFingerprint
    && left.hunkFingerprint === right.hunkFingerprint
    && left.selectionFingerprint === right.selectionFingerprint
    && left.gitStateFingerprint === right.gitStateFingerprint;
}

async function hashObject(root: string, content: Buffer): Promise<string> {
  const result = await runGit(root, ["hash-object", "-w", "--stdin"], {
    input: content,
    maxOutputBytes: 256,
    failureMessage: "Unable to create a reversible Git backup.",
  });
  const oid = result.stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(oid)) throw new GitError("operation-failed", "Git returned an invalid backup object.");
  return oid;
}

async function resolveRef(root: string, ref: string): Promise<string | null> {
  try {
    const result = await runGit(root, ["rev-parse", "--verify", "--end-of-options", ref], {
      maxOutputBytes: 256,
      failureMessage: "Unable to inspect the selective-reversal registry.",
    });
    const oid = result.stdout.toString("utf8").trim();
    return /^[0-9a-f]{40,64}$/u.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

function reversalRegistryStorage(root: string): ReversalRegistryStorage {
  const compareAndSwapRef = async (ref: string, nextOid: string, expectedOid: string | null): Promise<boolean> => {
    try {
      await runGit(root, ["update-ref", ref, nextOid, expectedOid ?? "0".repeat(nextOid.length)], {
        maxOutputBytes: 256,
        failureMessage: "Unable to update the selective-reversal registry.",
      });
      return true;
    } catch (error) {
      if ((await resolveRef(root, ref)) !== expectedOid) return false;
      throw error;
    }
  };
  return {
    async readRef(ref) {
      const oid = await resolveRef(root, ref);
      if (!oid) return null;
      const sizeResult = await runGit(root, ["cat-file", "-s", oid], {
        maxOutputBytes: 64,
        failureMessage: "Unable to inspect the selective-reversal registry or backup.",
      });
      const size = Number(sizeResult.stdout.toString("utf8").trim());
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new GitError("operation-failed", "Git returned an invalid selective-reversal object size.");
      }
      if (size > MAX_DIFF_BYTES) return { oid, content: Buffer.alloc(0) };
      const content = await runGit(root, ["cat-file", "blob", oid], {
        maxOutputBytes: MAX_DIFF_BYTES,
        failureMessage: "Unable to read the selective-reversal registry or backup.",
      });
      return { oid, content: content.stdout };
    },
    writeBlob: (content) => hashObject(root, content),
    compareAndSwapRef,
    createRef: (ref, oid) => compareAndSwapRef(ref, oid, null),
    async deleteRef(ref, expectedOid) {
      const current = await resolveRef(root, ref);
      if (!current) return true;
      if (current !== expectedOid) return false;
      try {
        await runGit(root, ["update-ref", "-d", ref, expectedOid], {
          maxOutputBytes: 256,
          failureMessage: "Unable to clean up a selective-reversal backup.",
        });
        return true;
      } catch (error) {
        const after = await resolveRef(root, ref);
        if (!after) return true;
        if (after !== expectedOid) return false;
        throw error;
      }
    },
  };
}

async function canonicalGitPath(root: string, argument: "--git-common-dir" | "--git-dir"): Promise<string> {
  const result = await runGit(root, ["rev-parse", argument], {
    maxOutputBytes: MAX_PATH_LENGTH,
    failureMessage: "Unable to identify this Git repository checkout.",
  });
  const reported = result.stdout.toString("utf8").trim();
  try { return await realpath(isAbsolute(reported) ? reported : resolve(root, reported)); }
  catch { throw new GitError("conflict", "This Git repository checkout identity could not be verified."); }
}

async function reversalIdentities(root: string): Promise<{
  repository: ReversalRepositoryIdentity;
  checkout: ReversalCheckoutIdentity;
}> {
  const [commonDirectory, gitDirectory, rootInfo] = await Promise.all([
    canonicalGitPath(root, "--git-common-dir"),
    canonicalGitPath(root, "--git-dir"),
    stat(root),
  ]);
  const [commonInfo, gitInfo] = await Promise.all([stat(commonDirectory), stat(gitDirectory)]);
  const repositoryFingerprint = sha256([
    commonDirectory,
    String(commonInfo.dev),
    String(commonInfo.ino),
  ].join("\0"));
  const checkoutFingerprint = sha256([
    root,
    String(rootInfo.dev),
    String(rootInfo.ino),
    gitDirectory,
    String(gitInfo.dev),
    String(gitInfo.ino),
  ].join("\0"));
  return {
    repository: { commonDirectory, fingerprint: repositoryFingerprint },
    checkout: { rootDirectory: root, gitDirectory, fingerprint: checkoutFingerprint },
  };
}

function registryError(error: unknown): never {
  if (!(error instanceof ReversalRegistryError)) throw error;
  if (error.kind === "invalid") throw new GitError("invalid-input", error.message);
  if (error.kind === "not-found" || error.kind === "incompatible") throw new GitError("not-found", error.message);
  throw new GitError("conflict", error.message);
}

async function reversalController(root: string): Promise<ReversalRegistryController> {
  const identities = await reversalIdentities(root);
  return new ReversalRegistryController(reversalRegistryStorage(root), identities.repository, identities.checkout);
}

async function registryOperation<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; }
  catch (error) { registryError(error); }
}

async function maintainReversalOperations(
  root: string,
  controller: ReversalRegistryController,
  maxActiveBackups = REVERSAL_MAX_ACTIVE_BACKUPS,
): Promise<void> {
  await registryOperation(controller.cleanup(maxActiveBackups));
  const operations = await registryOperation(controller.operations());
  for (const operation of operations) {
    if (operation.status !== "applying" && operation.status !== "undoing") continue;
    try { controller.assertCurrentIdentity(operation); }
    catch { continue; }
    let path: string;
    try { [path] = await validatedPaths(root, [operation.filePath]) as [string]; }
    catch {
      await registryOperation(controller.markRecoveryRequired(operation.operationId));
      continue;
    }
    const absolute = resolve(root, path);
    const [matchesPreState, matchesPostState] = await Promise.all([
      fileStateMatches(
        root,
        absolute,
        path,
        operation.preWorktreeOid,
        operation.preWorktreeMode,
        operation.preIndexOid,
        operation.preIndexMode,
      ),
      fileStateMatches(
        root,
        absolute,
        path,
        operation.postWorktreeOid,
        operation.postWorktreeMode,
        operation.postIndexOid,
        operation.postIndexMode,
      ),
    ]);
    if (operation.status === "applying" && matchesPostState) {
      await registryOperation(controller.markApplied(operation.operationId));
    } else if (operation.status === "applying" && matchesPreState) {
      const failed = await registryOperation(controller.markFailed(operation.operationId));
      await registryOperation(controller.deleteBackups(failed));
    } else if (operation.status === "undoing" && matchesPreState) {
      const undone = await registryOperation(controller.markUndone(operation.operationId));
      await registryOperation(controller.deleteBackups(undone));
    } else if (operation.status === "undoing" && matchesPostState) {
      await registryOperation(controller.markApplied(operation.operationId));
    } else {
      await registryOperation(controller.markRecoveryRequired(operation.operationId));
    }
  }
  await registryOperation(controller.cleanup(maxActiveBackups));
}

export async function cleanupReversalOperations(repositoryPath: string): Promise<void> {
  const root = await repositoryRoot(repositoryPath);
  const controller = await reversalController(root);
  await maintainReversalOperations(root, controller);
}

async function updateIndexEntry(root: string, path: string, mode: string, oid: string): Promise<void> {
  await runGit(root, ["update-index", "--cacheinfo", mode, oid, path], {
    maxOutputBytes: 256,
    failureMessage: "Unable to update the selected file in the Git index.",
  });
}

async function writeAtomic(root: string, path: string, content: Buffer, mode: number): Promise<void> {
  let canonicalParent: string;
  try { canonicalParent = await realpath(dirname(path)); }
  catch { throw new GitError("conflict", "The selected file's parent folder is no longer available."); }
  if (!isContained(root, canonicalParent)) throw new GitError("conflict", "The selected file's parent folder moved outside the repository.");
  const temporary = resolve(dirname(path), `.${basename(path)}.inertia-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", mode & 0o777);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, mode & 0o777);
    await rename(temporary, path);
    try {
      const directory = await open(dirname(path), fsConstants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      // Some platforms do not support syncing directory handles.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function fileStateMatches(root: string, absolute: string, path: string, worktreeOid: string, worktreeMode: number, indexOid: string, indexMode: string): Promise<boolean> {
  try {
    const [info, content, index] = await Promise.all([lstat(absolute), readFile(absolute), readIndexEntry(root, path)]);
    return info.isFile()
      && !info.isSymbolicLink()
      && (info.mode & 0o777) === (worktreeMode & 0o777)
      && (await hashObject(root, content)) === worktreeOid
      && index.oid === indexOid
      && index.mode === indexMode;
  } catch {
    return false;
  }
}

export async function inspectDiffSelection(repositoryPath: string, selection: GitDiffSelection): Promise<DiffReversalPlan> {
  const root = await repositoryRoot(repositoryPath);
  const controller = await reversalController(root);
  await maintainReversalOperations(root, controller);
  return (await buildReversalState(root, selection)).plan;
}

/** Failure hooks are deliberately per-call so tests never alter process-global Git behavior. */
export interface ReversalTestHooks {
  afterBackupCreated?: (operation: ReversalOperationRecord) => void | Promise<void>;
  afterIndexUpdated?: (operation: ReversalOperationRecord) => void | Promise<void>;
}

async function failReversalOperation(
  controller: ReversalRegistryController,
  operation: ReversalOperationRecord,
  retainBackups: boolean,
): Promise<void> {
  const failed = retainBackups
    ? await registryOperation(controller.markRecoveryRequired(operation.operationId))
    : await registryOperation(controller.markFailed(operation.operationId));
  if (!retainBackups) await registryOperation(controller.deleteBackups(failed));
}

export async function revertDiffSelection(
  repositoryPath: string,
  selection: GitDiffSelection,
  testHooks?: ReversalTestHooks,
): Promise<GitDiffReversalResult> {
  const root = await repositoryRoot(repositoryPath);
  const controller = await reversalController(root);
  await maintainReversalOperations(root, controller);
  if (!selection.expected) throw new GitError("invalid-input", "Inspect the selected reversal before applying it.");
  const state = await buildReversalState(root, selection);
  if (!sameValidation(state.plan.validation, selection.expected)) {
    throw new GitError("conflict", "The diff, file, hunk, selected lines, or staged state changed after confirmation. Refresh and try again.");
  }
  const nextWorktree = reversalText(state.worktreeContent, state.selectedWorktreeLines);
  const nextIndex = state.selectedIndexLines.length > 0
    ? reversalText(state.index.content, state.selectedIndexLines)
    : state.index.content;
  const operationId = randomUUID();
  const [preWorktreeOid, postWorktreeOid, nextIndexOid] = await Promise.all([
    hashObject(root, state.worktreeContent),
    hashObject(root, nextWorktree),
    state.selectedIndexLines.length > 0 ? hashObject(root, nextIndex) : Promise.resolve(state.index.oid),
  ]);
  const operation = await registryOperation(controller.prepare({
    operationId,
    filePath: state.plan.filePath,
    affectedLayers: state.plan.affectedLayers,
    selectedLineCount: state.plan.selectedLineCount,
    preWorktreeOid,
    preWorktreeMode: state.worktreeMode,
    preIndexOid: state.index.oid,
    preIndexMode: state.index.mode,
    postWorktreeOid,
    postWorktreeMode: state.worktreeMode,
    postIndexOid: nextIndexOid,
    postIndexMode: state.index.mode,
  }));
  let indexUpdated = false;
  let worktreeUpdated = false;
  try {
    await testHooks?.afterBackupCreated?.(operation);
    if ((await repositoryStateFingerprint(root)) !== state.plan.validation.gitStateFingerprint) {
      throw new GitError("conflict", "The repository changed immediately before the reversal. No files were changed.");
    }
    await registryOperation(controller.markApplying(operation.operationId));
    if (!(await fileStateMatches(
      root,
      state.absolute,
      state.plan.filePath,
      operation.preWorktreeOid,
      operation.preWorktreeMode,
      operation.preIndexOid,
      operation.preIndexMode,
    ))) {
      throw new GitError("conflict", "The selected file or staged state changed immediately before the reversal. No changes were applied.");
    }
    if (state.selectedIndexLines.length > 0) {
      await updateIndexEntry(root, state.plan.filePath, state.index.mode, nextIndexOid);
      indexUpdated = true;
      await testHooks?.afterIndexUpdated?.(operation);
    }
    await writeAtomic(root, state.absolute, nextWorktree, state.worktreeMode);
    worktreeUpdated = true;
    if (!(await fileStateMatches(root, state.absolute, state.plan.filePath, operation.postWorktreeOid, operation.postWorktreeMode, operation.postIndexOid, operation.postIndexMode))) {
      throw new GitError("conflict", "Git could not verify the completed reversal; the original file state was restored.");
    }
    const diff = await completeRepositoryDiff(root, selection.ignoreWhitespace);
    const applied = await registryOperation(controller.markApplied(operation.operationId));
    return {
      diff,
      operation: {
        id: applied.operationId,
        filePath: applied.filePath,
        selectedLineCount: applied.selectedLineCount,
        affectedLayers: applied.affectedLayers,
        createdAt: applied.createdAt,
      },
    };
  } catch (error) {
    if (indexUpdated) await updateIndexEntry(root, state.plan.filePath, state.index.mode, state.index.oid).catch(() => undefined);
    if (worktreeUpdated) await writeAtomic(root, state.absolute, state.worktreeContent, state.worktreeMode).catch(() => undefined);
    const restored = !indexUpdated && !worktreeUpdated
      ? true
      : await fileStateMatches(
        root,
        state.absolute,
        state.plan.filePath,
        operation.preWorktreeOid,
        operation.preWorktreeMode,
        operation.preIndexOid,
        operation.preIndexMode,
      );
    await failReversalOperation(controller, operation, !restored);
    throw error;
  }
}

export async function undoDiffSelection(repositoryPath: string, operationId: string): Promise<GitUnifiedDiff> {
  const root = await repositoryRoot(repositoryPath);
  const controller = await reversalController(root);
  await maintainReversalOperations(root, controller);
  const operation = await registryOperation(controller.get(operationId));
  await registryOperation(Promise.resolve().then(() => controller.assertCurrentIdentity(operation)));
  if (operation.status !== "applied") {
    throw new GitError("not-found", operation.status === "expired"
      ? "This reversal backup expired and is no longer available."
      : "This reversal backup is no longer available for Undo.");
  }
  const [path] = await validatedPaths(root, [operation.filePath]);
  const absolute = resolve(root, path!);
  if (!(await fileStateMatches(root, absolute, path!, operation.postWorktreeOid, operation.postWorktreeMode, operation.postIndexOid, operation.postIndexMode))) {
    throw new GitError("conflict", "This file or its staged state changed after the reversal, so Undo was not applied.");
  }
  const [worktree, postWorktree] = await Promise.all([
    registryOperation(controller.readBackup(operation, "pre-worktree")),
    registryOperation(controller.readBackup(operation, "post-worktree")),
  ]);
  await registryOperation(controller.markUndoing(operation.operationId));
  if (!(await fileStateMatches(root, absolute, path!, operation.postWorktreeOid, operation.postWorktreeMode, operation.postIndexOid, operation.postIndexMode))) {
    await registryOperation(controller.markApplied(operation.operationId));
    throw new GitError("conflict", "This file or its staged state changed before Undo could start, so Undo was not applied.");
  }
  let indexUpdated = false;
  let worktreeUpdated = false;
  let diff: GitUnifiedDiff;
  try {
    if (operation.affectedLayers.includes("index")) {
      await updateIndexEntry(root, path!, operation.preIndexMode, operation.preIndexOid);
      indexUpdated = true;
    }
    await writeAtomic(root, absolute, worktree, operation.preWorktreeMode);
    worktreeUpdated = true;
    if (!(await fileStateMatches(root, absolute, path!, operation.preWorktreeOid, operation.preWorktreeMode, operation.preIndexOid, operation.preIndexMode))) {
      throw new GitError("conflict", "Git could not verify the restored reversal backup.");
    }
    diff = await completeRepositoryDiff(root);
  } catch (error) {
    if (indexUpdated) await updateIndexEntry(root, path!, operation.postIndexMode, operation.postIndexOid).catch(() => undefined);
    if (worktreeUpdated) await writeAtomic(root, absolute, postWorktree, operation.postWorktreeMode).catch(() => undefined);
    const restored = await fileStateMatches(
      root,
      absolute,
      path!,
      operation.postWorktreeOid,
      operation.postWorktreeMode,
      operation.postIndexOid,
      operation.postIndexMode,
    );
    if (restored) await registryOperation(controller.markApplied(operation.operationId));
    else await registryOperation(controller.markRecoveryRequired(operation.operationId));
    throw error;
  }
  let undone: ReversalOperationRecord;
  try {
    undone = await registryOperation(controller.markUndone(operation.operationId));
  } catch (error) {
    if (operation.affectedLayers.includes("index")) {
      await updateIndexEntry(root, path!, operation.postIndexMode, operation.postIndexOid).catch(() => undefined);
    }
    await writeAtomic(root, absolute, postWorktree, operation.postWorktreeMode).catch(() => undefined);
    const restored = await fileStateMatches(
      root,
      absolute,
      path!,
      operation.postWorktreeOid,
      operation.postWorktreeMode,
      operation.postIndexOid,
      operation.postIndexMode,
    );
    if (restored) await registryOperation(controller.markApplied(operation.operationId));
    else await registryOperation(controller.markRecoveryRequired(operation.operationId));
    throw error;
  }
  await registryOperation(controller.deleteBackups(undone));
  return diff;
}

function parseBranches(buffer: Buffer, kind: GitBranch["kind"]): GitBranch[] {
  return buffer
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", commit = "", upstream = "", head = ""] = line.split("\0");
      return { name, kind, current: head === "*", commit, upstream: upstream || null };
    })
    .filter((branch) => branch.name.length > 0 && !branch.name.endsWith("/HEAD"));
}

export async function listBranches(repositoryPath: string): Promise<GitBranches> {
  const root = await repositoryRoot(repositoryPath);
  const format = "%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)";
  const [localResult, remoteResult] = await Promise.all([
    runGit(root, ["for-each-ref", `--format=${format}`, "--sort=refname", "refs/heads"], {
      failureMessage: "Unable to list local branches.",
    }),
    runGit(root, ["for-each-ref", `--format=${format}`, "--sort=refname", "refs/remotes"], {
      failureMessage: "Unable to list remote branches.",
    }),
  ]);
  const local = parseBranches(localResult.stdout, "local");
  const remote = parseBranches(remoteResult.stdout, "remote");
  return { current: local.find((branch) => branch.current)?.name ?? null, local, remote };
}

export async function switchBranch(repositoryPath: string, branch: string): Promise<GitMutationResult> {
  const root = await repositoryRoot(repositoryPath);
  const name = await validateBranch(root, branch);
  await runGit(root, ["switch", "--", name], { failureMessage: "Unable to switch branches." });
  return { status: await getRepositoryStatus(root) };
}

export async function createBranch(repositoryPath: string, branch: string, startPoint?: string): Promise<GitMutationResult> {
  const root = await repositoryRoot(repositoryPath);
  const name = await validateBranch(root, branch);
  const args = ["switch", "-c", name];
  if (startPoint !== undefined) args.push(validateName(startPoint, "The starting revision"));
  await runGit(root, args, { failureMessage: "Unable to create the branch." });
  return { status: await getRepositoryStatus(root) };
}

export async function pullRepository(repositoryPath: string): Promise<GitMutationResult> {
  const root = await repositoryRoot(repositoryPath);
  await runGit(root, ["pull", "--ff-only", "--no-rebase"], {
    timeoutMs: NETWORK_TIMEOUT_MS,
    failureMessage: "Unable to pull changes from the remote repository.",
  });
  return { status: await getRepositoryStatus(root) };
}

async function validateNewAbsolutePath(path: string, repositoryRootPath: string): Promise<string> {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.length > MAX_PATH_LENGTH ||
    path.includes("\0") ||
    resolve(path) === parse(resolve(path)).root
  ) {
    throw new GitError("invalid-input", "The worktree path must be a safe absolute path.");
  }
  const target = resolve(path);
  if (target === repositoryRootPath) throw new GitError("invalid-input", "The main repository cannot be used as a new worktree path.");
  try {
    await access(target);
    throw new GitError("invalid-input", "The new worktree path already exists.");
  } catch (error) {
    if (error instanceof GitError) throw error;
  }
  let existing = resolve(target, "..");
  while (true) {
    try {
      await lstat(existing);
      const canonicalParent = await realpath(existing);
      if (!(await stat(canonicalParent)).isDirectory()) {
        throw new GitError("invalid-input", "The worktree path has an unsafe parent folder.");
      }
      const suffix = relative(existing, target);
      return resolve(canonicalParent, suffix);
    } catch (error) {
      if (error instanceof GitError) throw error;
      const parent = resolve(existing, "..");
      if (parent === existing) throw new GitError("invalid-input", "The worktree parent folder could not be found.");
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
    if (!options.branch) throw new GitError("invalid-input", "A branch name is required for the new worktree.");
    args.push("-b", await validateBranch(root, options.branch));
  }
  args.push("--", target);
  if (options.startPoint) args.push(validateName(options.startPoint, "The starting revision"));
  else if (options.branch && !options.createBranch) args.push(await validateBranch(root, options.branch));
  await runGit(root, args, { failureMessage: "Unable to create the worktree." });
  return getRepositoryStatus(target);
}

async function registeredWorktrees(root: string): Promise<string[]> {
  const result = await runGit(root, ["worktree", "list", "--porcelain", "-z"], {
    failureMessage: "Unable to inspect repository worktrees.",
  });
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((record) => record.startsWith("worktree "))
    .map((record) => record.slice(9));
}

export async function removeWorktree(repositoryPath: string, worktreePath: string, force = false): Promise<GitMutationResult> {
  const root = await repositoryRoot(repositoryPath);
  if (!isAbsolute(worktreePath) || worktreePath.length > MAX_PATH_LENGTH || worktreePath.includes("\0")) {
    throw new GitError("invalid-input", "The worktree path must be an absolute path.");
  }
  const requestedTarget = resolve(worktreePath);
  const target = await realpath(requestedTarget).catch(() => requestedTarget);
  if (target === root || target === parse(target).root) {
    throw new GitError("invalid-input", "The main repository cannot be removed as a worktree.");
  }
  const worktrees = await registeredWorktrees(root);
  const registered = worktrees.find((path) => resolve(path) === target);
  if (!registered) throw new GitError("not-found", "The requested worktree is not registered with this repository.");
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push("--", registered);
  await runGit(root, args, { failureMessage: "Unable to remove the worktree." });
  return { status: await getRepositoryStatus(root) };
}

export async function commitChanges(
  repositoryPath: string,
  message: string,
  paths?: readonly string[],
): Promise<GitCommitResult> {
  const root = await repositoryRoot(repositoryPath);
  if (typeof message !== "string" || message.trim().length === 0 || message.length > 10_000 || message.includes("\0")) {
    throw new GitError("invalid-input", "Enter a commit message between 1 and 10,000 characters.");
  }
  if (paths && paths.length === 0) {
    throw new GitError("invalid-input", "Select at least one path to commit.");
  }
  const selected = paths ? await validatedPaths(root, paths) : null;
  await runGit(root, ["add", "-A", "--", ...(selected ?? [])], { failureMessage: "Unable to stage the selected changes." });
  await runGit(root, ["commit", "-m", message, ...(selected ? ["--", ...selected] : [])], {
    timeoutMs: NETWORK_TIMEOUT_MS,
    failureMessage: "Unable to create the commit.",
  });
  const commitResult = await runGit(root, ["rev-parse", "HEAD"], {
    maxOutputBytes: 256,
    failureMessage: "The commit was created, but its identifier could not be read.",
  });
  return { commit: commitResult.stdout.toString("utf8").trim(), status: await getRepositoryStatus(root) };
}

export async function pushCurrentBranch(repositoryPath: string, remoteName?: string): Promise<GitMutationResult> {
  const root = await repositoryRoot(repositoryPath);
  const branches = await listBranches(root);
  if (!branches.current) throw new GitError("invalid-input", "Check out a local branch before pushing.");
  const current = branches.local.find((branch) => branch.current);
  const configuredRemote = current?.upstream?.split("/", 1)[0];
  const remote = validateName(remoteName ?? configuredRemote ?? "origin", "The remote name");
  const remoteResult = await runGit(root, ["remote"], { failureMessage: "Unable to inspect repository remotes." });
  if (!remoteResult.stdout.toString("utf8").split("\n").includes(remote)) {
    throw new GitError("not-found", "The selected Git remote does not exist.");
  }
  await runGit(root, ["push", "--set-upstream", remote, `HEAD:refs/heads/${branches.current}`], {
    timeoutMs: NETWORK_TIMEOUT_MS,
    failureMessage: "Unable to push the current branch.",
  });
  return { status: await getRepositoryStatus(root) };
}

export function refreshRepositoryStatus(repositoryPath: string): Promise<GitRepositoryStatus> {
  return getRepositoryStatus(repositoryPath);
}

function remoteWebBase(remote: string): URL {
  const trimmed = remote.trim().replace(/\.git$/u, "");
  const scp = /^git@([^:]+):(.+)$/u.exec(trimmed);
  const candidate = scp ? `https://${scp[1]}/${scp[2]}` : trimmed.replace(/^ssh:\/\/git@/u, "https://");
  let url: URL;
  try { url = new URL(candidate); } catch { throw new GitError("operation-failed", "The origin remote is not a supported web repository URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new GitError("operation-failed", "The origin remote is not a supported web repository URL.");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url;
}

export async function getPullRequestCreateUrl(repositoryPath: string): Promise<string> {
  const root = await repositoryRoot(repositoryPath);
  const status = await getRepositoryStatus(root);
  if (!status.branch) throw new GitError("invalid-input", "Check out a branch before opening a pull request.");
  const remote = await runGit(root, ["remote", "get-url", "origin"], { maxOutputBytes: MAX_PATH_LENGTH, failureMessage: "The repository does not have an origin remote." });
  const base = remoteWebBase(remote.stdout.toString("utf8"));
  const branch = encodeURIComponent(status.branch);
  const host = base.hostname.toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) return `${base.toString().replace(/\/$/u, "")}/compare/${branch}?expand=1`;
  if (host.includes("gitlab")) return `${base.toString().replace(/\/$/u, "")}/-/merge_requests/new?merge_request[source_branch]=${branch}`;
  if (host.includes("bitbucket")) return `${base.toString().replace(/\/$/u, "")}/pull-requests/new?source=${branch}`;
  throw new GitError("operation-failed", "Pull request links are supported for GitHub, GitLab, and Bitbucket remotes.");
}
