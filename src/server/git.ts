import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { parseUnifiedDiff } from "../shared/diff-review";

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
      stdio: ["ignore", "pipe", "pipe"],
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

    child.stdout.on("data", (chunk: Buffer) => {
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
    child.stderr.on("data", (chunk: Buffer) => {
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
    failureMessage: "Unable to read the repository status.",
  });
  const parsed = parsePorcelain(statusResult.stdout);
  const statsResult = await runGit(
    root,
    (await hasHead(root))
      ? ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "HEAD", "--"]
      : ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--cached", "--"],
    { maxOutputBytes: DEFAULT_OUTPUT_BYTES, failureMessage: "Unable to calculate repository change totals." },
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

export async function revertDiffSelection(repositoryPath: string, selection: GitDiffSelection): Promise<GitUnifiedDiff> {
  const root = await repositoryRoot(repositoryPath);
  const current = await getUnifiedDiff(root, { ignoreWhitespace: selection.ignoreWhitespace });
  const structured = parseUnifiedDiff(current.text);
  if (structured.fingerprint !== selection.fingerprint) {
    throw new GitError("conflict", "The changes moved since this selection was made. Refresh the diff and try again.");
  }
  const file = structured.files.find((candidate) => candidate.path === selection.filePath);
  const hunk = file?.hunks.find((candidate) => candidate.id === selection.hunkId);
  if (!file || !hunk) throw new GitError("not-found", "The selected diff hunk is no longer available.");

  const selectedIds = new Set(selection.lineIds);
  const selected = hunk.lines.filter((line) => selectedIds.has(line.id) && (line.kind === "addition" || line.kind === "deletion"));
  if (selected.length === 0) throw new GitError("invalid-input", "Select at least one added or removed line to revert.");
  const validated = await validatedPaths(root, [file.path]);
  const absolute = resolve(root, validated[0]!);
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(absolute); }
  catch { throw new GitError("conflict", "Deleted files must be restored as a whole from source control."); }
  if (!info.isFile() || info.isSymbolicLink()) throw new GitError("invalid-input", "Only regular text files can be reverted by selection.");

  const source = await readFile(absolute, "utf8");
  if (source.includes("\0")) throw new GitError("invalid-input", "Binary files cannot be reverted by selection.");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = source.endsWith("\n");
  const body = trailingNewline ? source.replace(/\r?\n$/u, "") : source;
  const fileLines = body ? body.split(/\r?\n/u) : [];

  for (const line of [...selected].reverse()) {
    if (line.kind === "addition") {
      const index = (line.newLineNumber ?? 0) - 1;
      if (index < 0 || index >= fileLines.length || fileLines[index] !== line.content) {
        throw new GitError("conflict", "The selected lines no longer match the file. Refresh the diff and try again.");
      }
      fileLines.splice(index, 1);
    } else {
      const index = Math.max(0, Math.min(line.newInsertionIndex, fileLines.length));
      fileLines.splice(index, 0, line.content);
    }
  }

  const next = `${fileLines.join(newline)}${trailingNewline ? newline : ""}`;
  await writeFile(absolute, next, "utf8");
  return await getUnifiedDiff(root, { ignoreWhitespace: selection.ignoreWhitespace });
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
