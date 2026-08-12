import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ChangedFile,
  WorkspaceGitIssue,
  WorkspaceGitRepositorySnapshot,
  WorkspaceGitSnapshot,
} from "../shared/contracts";
import {
  GitError,
  getRepositoryStatus,
  type GitRepositoryStatus,
} from "./git";
import {
  repositoryMetadataMarkerIdentity,
  repositoryRoot,
} from "./git/paths";
import type {
  RuntimeSecureFileBroker,
  SecureFileRootCapability,
} from "./secure-files";

export const WORKSPACE_GIT_DEFAULT_LIMITS = Object.freeze({
  maxDepth: 8,
  maxDirectories: 5_000,
  maxRepositories: 128,
  statusConcurrency: 4,
  maxIssues: 20,
});

export interface WorkspaceGitDiscoveryLimits {
  maxDepth: number;
  maxDirectories: number;
  maxRepositories: number;
  statusConcurrency: number;
  maxIssues: number;
}

export interface WorkspaceGitDiscoveryOptions
  extends Partial<WorkspaceGitDiscoveryLimits> {
  deadlineAt?: number;
  secureFiles?: RuntimeSecureFileBroker;
  onRepositoryAuthorized?: (
    repositoryPath: string,
    root: SecureFileRootCapability,
    metadataMarkerIdentity: string,
  ) => void;
}

export interface ResolvedWorkspaceRepositoryIdentity {
  root: string;
  secureRoot?: SecureFileRootCapability;
  metadataMarkerIdentity: string;
}

export interface ResolvedWorkspaceRepository
  extends ResolvedWorkspaceRepositoryIdentity {
  status: GitRepositoryStatus;
}

interface DiscoveryCandidate {
  absolutePath: string;
  repositoryPath: string;
}

interface QueuedDirectory extends DiscoveryCandidate {
  depth: number;
}

const IGNORED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function canonicalIdentity(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function comparePaths(left: string, right: string): number {
  if (left === ".") return right === "." ? 0 : -1;
  if (right === ".") return 1;
  const leftFolded = left.toLocaleLowerCase("en-US");
  const rightFolded = right.toLocaleLowerCase("en-US");
  if (leftFolded < rightFolded) return -1;
  if (leftFolded > rightFolded) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function changedFiles(status: GitRepositoryStatus): ChangedFile[] {
  return status.files.map((file) => ({
    path: file.path,
    status: file.status,
    insertions: file.insertions,
    deletions: file.deletions,
    untracked: file.status === "untracked",
    staged: file.staged,
    unstaged: file.unstaged,
    indexStatus: file.indexStatus,
    worktreeStatus: file.worktreeStatus,
  }));
}

function readyRepository(repositoryPath: string, status: GitRepositoryStatus): WorkspaceGitRepositorySnapshot {
  return {
    repositoryPath,
    state: "ready",
    error: null,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    hasRemote: status.hasRemote,
    pullRequest: status.pullRequest,
    files: changedFiles(status),
    insertions: status.insertions,
    deletions: status.deletions,
    clean: status.clean,
    truncated: status.truncated,
  };
}

function failedRepository(repositoryPath: string, error: unknown): WorkspaceGitRepositorySnapshot {
  return {
    repositoryPath,
    state: "error",
    error: error instanceof GitError ? error.message : "Repository status is unavailable.",
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    files: [],
    insertions: 0,
    deletions: 0,
    clean: false,
    truncated: false,
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function requireDiscoveryTime(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw discoveryTimeoutError();
  }
}

function discoveryTimeoutError(): GitError {
  return new GitError(
    "timeout",
    "Workspace repository discovery took too long.",
  );
}

function repositoryResolutionCancelledError(): GitError {
  return new GitError("timeout", "Git inspection was cancelled.");
}

function requireRepositoryResolutionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw repositoryResolutionCancelledError();
}

async function beforeRepositoryResolutionAbort<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await operation();
  let rejectCancellation!: (error: GitError) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = (): void => {
    rejectCancellation(repositoryResolutionCancelledError());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    requireRepositoryResolutionActive(signal);
    return await Promise.race([operation(), cancellation]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function beforeDiscoveryDeadline<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  deadlineAt: number | undefined,
): Promise<T> {
  if (deadlineAt === undefined) return await operation();
  requireDiscoveryTime(deadlineAt);
  const controller = new AbortController();
  const pending = operation(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(discoveryTimeoutError());
          },
          Math.max(1, deadlineAt - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizedLimits(input: Partial<WorkspaceGitDiscoveryLimits>): WorkspaceGitDiscoveryLimits {
  return {
    maxDepth: positiveLimit(input.maxDepth, WORKSPACE_GIT_DEFAULT_LIMITS.maxDepth),
    maxDirectories: positiveLimit(input.maxDirectories, WORKSPACE_GIT_DEFAULT_LIMITS.maxDirectories),
    maxRepositories: positiveLimit(input.maxRepositories, WORKSPACE_GIT_DEFAULT_LIMITS.maxRepositories),
    statusConcurrency: positiveLimit(input.statusConcurrency, WORKSPACE_GIT_DEFAULT_LIMITS.statusConcurrency),
    maxIssues: positiveLimit(input.maxIssues, WORKSPACE_GIT_DEFAULT_LIMITS.maxIssues),
  };
}

async function requireWorkspaceDirectory(
  workspacePath: string,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<string> {
  if (
    typeof workspacePath !== "string"
    || workspacePath.length === 0
    || workspacePath.length > 4_096
    || workspacePath.includes("\0")
  ) {
    throw new GitError("invalid-input", "The workspace path is invalid.");
  }
  try {
    const root = await beforeRepositoryResolutionAbort(
      async () => await beforeDiscoveryDeadline(
        () => realpath(resolve(workspacePath)),
        deadlineAt,
      ),
      signal,
    );
    if (!(await beforeRepositoryResolutionAbort(
      async () => await beforeDiscoveryDeadline(
        () => stat(root),
        deadlineAt,
      ),
      signal,
    )).isDirectory()) {
      throw new Error();
    }
    return root;
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError("not-found", "The workspace folder could not be found.");
  }
}

async function markerState(
  directory: string,
  signal?: AbortSignal,
): Promise<"present" | "absent" | "unsafe"> {
  let entries;
  try {
    entries = await beforeRepositoryResolutionAbort(
      () => readdir(directory, { withFileTypes: true }),
      signal,
    );
  } catch (error) {
    if (error instanceof GitError) throw error;
    return "absent";
  }
  const marker = entries.find((entry) => entry.name.toLocaleLowerCase("en-US") === ".git");
  if (!marker) return "absent";
  try {
    const info = await beforeRepositoryResolutionAbort(
      () => lstat(resolve(directory, marker.name)),
      signal,
    );
    if (info.isSymbolicLink()) return "unsafe";
    return info.isDirectory() || info.isFile() ? "present" : "absent";
  } catch (error) {
    if (error instanceof GitError) throw error;
    return "absent";
  }
}

function safeIssue(
  issues: WorkspaceGitIssue[],
  limits: WorkspaceGitDiscoveryLimits,
  repositoryPath: string,
  message: string,
): void {
  if (issues.length < limits.maxIssues) issues.push({ repositoryPath, message });
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await operation(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

/**
 * Discovers Git roots without invoking Git for every traversed directory.
 * Directory traversal is breadth-first, bounded, deterministic and never
 * follows symbolic links.
 */
export async function discoverWorkspaceGitRepositories(
  workspacePath: string,
  inputLimits: WorkspaceGitDiscoveryOptions = {},
): Promise<WorkspaceGitSnapshot> {
  const limits = normalizedLimits(inputLimits);
  const workspaceRoot = await requireWorkspaceDirectory(
    workspacePath,
    inputLimits.deadlineAt,
  );
  const queue: QueuedDirectory[] = [{ absolutePath: workspaceRoot, repositoryPath: ".", depth: 0 }];
  const candidates: DiscoveryCandidate[] = [];
  const issues: WorkspaceGitIssue[] = [];
  let scannedDirectories = 0;
  let skippedDirectories = 0;
  let discoveredRepositories = 0;
  let partial = false;
  let truncated = false;

  while (queue.length > 0) {
    requireDiscoveryTime(inputLimits.deadlineAt);
    if (scannedDirectories >= limits.maxDirectories) {
      skippedDirectories += queue.length;
      truncated = true;
      break;
    }
    const current = queue.shift()!;
    scannedDirectories += 1;

    let entries;
    try {
      entries = await beforeDiscoveryDeadline(
        () => readdir(current.absolutePath, { withFileTypes: true }),
        inputLimits.deadlineAt,
      );
      requireDiscoveryTime(inputLimits.deadlineAt);
    } catch (error) {
      if (error instanceof GitError && error.code === "timeout") throw error;
      partial = true;
      safeIssue(issues, limits, current.repositoryPath, "This folder could not be inspected.");
      continue;
    }
    entries.sort((left, right) => comparePaths(left.name, right.name));

    const marker = entries.find((entry) => entry.name.toLocaleLowerCase("en-US") === ".git");
    if (marker) {
      try {
        const markerInfo = await beforeDiscoveryDeadline(
          () => lstat(resolve(current.absolutePath, marker.name)),
          inputLimits.deadlineAt,
        );
        if (markerInfo.isSymbolicLink()) {
          partial = true;
          safeIssue(issues, limits, current.repositoryPath, "An unsafe symbolic-link Git marker was ignored.");
        } else if (markerInfo.isDirectory() || markerInfo.isFile()) {
          discoveredRepositories += 1;
          if (candidates.length >= limits.maxRepositories) {
            truncated = true;
          } else {
            candidates.push({
              absolutePath: current.absolutePath,
              repositoryPath: current.repositoryPath,
            });
          }
        }
      } catch (error) {
        if (error instanceof GitError && error.code === "timeout") throw error;
        partial = true;
        safeIssue(issues, limits, current.repositoryPath, "The Git marker could not be inspected.");
      }
    }

    for (const entry of entries) {
      requireDiscoveryTime(inputLimits.deadlineAt);
      const foldedName = entry.name.toLocaleLowerCase("en-US");
      if (IGNORED_DIRECTORY_NAMES.has(foldedName)) {
        if (entry.isDirectory() || entry.isSymbolicLink()) skippedDirectories += 1;
        continue;
      }
      const childAbsolute = resolve(current.absolutePath, entry.name);
      let childInfo;
      try {
        childInfo = await beforeDiscoveryDeadline(
          () => lstat(childAbsolute),
          inputLimits.deadlineAt,
        );
      } catch (error) {
        if (error instanceof GitError && error.code === "timeout") throw error;
        partial = true;
        safeIssue(
          issues,
          limits,
          current.repositoryPath === "." ? entry.name : `${current.repositoryPath}/${entry.name}`,
          "This folder entry could not be inspected.",
        );
        continue;
      }
      if (childInfo.isSymbolicLink()) {
        skippedDirectories += 1;
        continue;
      }
      if (!childInfo.isDirectory()) continue;
      if (current.depth >= limits.maxDepth) {
        skippedDirectories += 1;
        truncated = true;
        continue;
      }
      let canonicalChild;
      try {
        canonicalChild = await beforeDiscoveryDeadline(
          () => realpath(childAbsolute),
          inputLimits.deadlineAt,
        );
      } catch (error) {
        if (error instanceof GitError && error.code === "timeout") throw error;
        partial = true;
        skippedDirectories += 1;
        continue;
      }
      if (!isContained(workspaceRoot, canonicalChild)) {
        partial = true;
        skippedDirectories += 1;
        continue;
      }
      queue.push({
        absolutePath: canonicalChild,
        repositoryPath: current.repositoryPath === "." ? entry.name : `${current.repositoryPath}/${entry.name}`,
        depth: current.depth + 1,
      });
    }
  }

  requireDiscoveryTime(inputLimits.deadlineAt);
  const inspected = await mapWithConcurrency(candidates, limits.statusConcurrency, async (candidate) => {
    try {
      requireDiscoveryTime(inputLimits.deadlineAt);
      const candidateInfo = await beforeDiscoveryDeadline(
        () => lstat(candidate.absolutePath, { bigint: true }),
        inputLimits.deadlineAt,
      );
      const secureRoot = inputLimits.secureFiles
        ? await beforeDiscoveryDeadline(
            (signal) => inputLimits.secureFiles!.authorizeRoot(
              candidate.absolutePath,
              signal,
            ),
            inputLimits.deadlineAt,
          )
        : null;
      requireDiscoveryTime(inputLimits.deadlineAt);
      if (
        secureRoot
        && (
          secureRoot.identity.dev !== candidateInfo.dev.toString(10)
          || secureRoot.identity.ino !== candidateInfo.ino.toString(10)
          || secureRoot.birthtimeNs !== candidateInfo.birthtimeNs.toString(10)
        )
      ) {
        throw new GitError(
          "conflict",
          "The repository folder changed while it was being inspected.",
        );
      }
      const metadataMarkerIdentity = await beforeDiscoveryDeadline(
        () => repositoryMetadataMarkerIdentity(
          secureRoot?.root ?? candidate.absolutePath,
          { deadlineAt: inputLimits.deadlineAt },
        ),
        inputLimits.deadlineAt,
      );
      const status = await getRepositoryStatus(
        secureRoot?.root ?? candidate.absolutePath,
        { deadlineAt: inputLimits.deadlineAt },
      );
      const verifiedMetadataMarkerIdentity = await beforeDiscoveryDeadline(
        () => repositoryMetadataMarkerIdentity(
          secureRoot?.root ?? candidate.absolutePath,
          { deadlineAt: inputLimits.deadlineAt },
        ),
        inputLimits.deadlineAt,
      );
      if (metadataMarkerIdentity !== verifiedMetadataMarkerIdentity) {
        throw new GitError(
          "conflict",
          "The Git repository identity changed while it was being inspected.",
        );
      }
      if (secureRoot) {
        await beforeDiscoveryDeadline(
          (signal) => inputLimits.secureFiles!.verifyRoot(secureRoot, signal),
          inputLimits.deadlineAt,
        );
      }
      const candidateIdentity = canonicalIdentity(candidate.absolutePath);
      const rootIdentity = canonicalIdentity(status.root);
      if (candidateIdentity !== rootIdentity || !isContained(workspaceRoot, status.root)) {
        throw new GitError("not-repository", "The Git marker does not identify this workspace folder.");
      }
      return {
        rootIdentity,
        repository: readyRepository(candidate.repositoryPath, status),
        secureRoot,
        metadataMarkerIdentity,
      };
    } catch (error) {
      if (error instanceof GitError && error.code === "timeout") throw error;
      requireDiscoveryTime(inputLimits.deadlineAt);
      partial = true;
      return {
        rootIdentity: null,
        repository: failedRepository(candidate.repositoryPath, error),
        secureRoot: null,
        metadataMarkerIdentity: null,
      };
    }
  });
  const seenRoots = new Set<string>();
  const repositories: WorkspaceGitRepositorySnapshot[] = [];
  for (const result of inspected) {
    if (result.rootIdentity && seenRoots.has(result.rootIdentity)) continue;
    if (result.rootIdentity) seenRoots.add(result.rootIdentity);
    repositories.push(result.repository);
    if (result.secureRoot && result.metadataMarkerIdentity) {
      inputLimits.onRepositoryAuthorized?.(
        result.repository.repositoryPath,
        result.secureRoot,
        result.metadataMarkerIdentity,
      );
    }
  }

  repositories.sort((left, right) => comparePaths(left.repositoryPath, right.repositoryPath));
  if (repositories.some((repository) => repository.truncated)) truncated = true;
  if (repositories.some((repository) => repository.state === "error")) partial = true;

  return {
    repositories,
    files: repositories.reduce((total, repository) => total + repository.files.length, 0),
    insertions: repositories.reduce((total, repository) => total + repository.insertions, 0),
    deletions: repositories.reduce((total, repository) => total + repository.deletions, 0),
    scannedDirectories,
    skippedDirectories,
    discoveredRepositories,
    repositoryLimit: limits.maxRepositories,
    partial: partial || truncated,
    truncated,
    issues,
  };
}

function normalizedRepositoryPath(repositoryPath: string): string {
  if (
    typeof repositoryPath !== "string"
    || repositoryPath.length === 0
    || repositoryPath.length > 4_096
    || repositoryPath.includes("\0")
    || repositoryPath.includes("\\")
    || isAbsolute(repositoryPath)
  ) {
    throw new GitError("invalid-input", "The repository path is invalid.");
  }
  if (repositoryPath === ".") return repositoryPath;
  const segments = repositoryPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new GitError("invalid-input", "The repository path is invalid.");
  }
  return segments.join("/");
}

/**
 * Resolves a repository identity received from the renderer back beneath the
 * active workspace. Every segment is lstat'ed so a newly introduced symlink
 * cannot redirect a subsequent diff request outside the project.
 */
export async function resolveWorkspaceGitRepositoryIdentity(
  workspacePath: string,
  repositoryPath: string,
  secureFiles?: RuntimeSecureFileBroker,
  signal?: AbortSignal,
): Promise<ResolvedWorkspaceRepositoryIdentity> {
  requireRepositoryResolutionActive(signal);
  const workspaceRoot = await requireWorkspaceDirectory(
    workspacePath,
    undefined,
    signal,
  );
  requireRepositoryResolutionActive(signal);
  const normalized = normalizedRepositoryPath(repositoryPath);
  const segments = normalized === "." ? [] : normalized.split("/");
  let candidate = workspaceRoot;
  for (const segment of segments) {
    candidate = resolve(candidate, segment);
    let info;
    try {
      info = await beforeRepositoryResolutionAbort(
        () => lstat(candidate),
        signal,
      );
      requireRepositoryResolutionActive(signal);
    } catch (error) {
      if (error instanceof GitError) throw error;
      throw new GitError("not-found", "The repository folder could not be found.");
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new GitError("invalid-input", "The repository path uses an unsafe symbolic link.");
    }
  }
  let canonical: string;
  try {
    canonical = await beforeRepositoryResolutionAbort(
      () => realpath(candidate),
      signal,
    );
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError("not-found", "The repository folder could not be found.");
  }
  requireRepositoryResolutionActive(signal);
  if (!isContained(workspaceRoot, canonical)) {
    throw new GitError("invalid-input", "The repository is outside the workspace.");
  }
  const canonicalInfo = await beforeRepositoryResolutionAbort(
    () => lstat(canonical, { bigint: true }),
    signal,
  );
  requireRepositoryResolutionActive(signal);
  const marker = await markerState(canonical, signal);
  requireRepositoryResolutionActive(signal);
  if (marker !== "present") {
    throw new GitError(
      marker === "unsafe" ? "invalid-input" : "not-repository",
      marker === "unsafe"
        ? "The repository uses an unsafe symbolic-link Git marker."
        : "The selected folder is not a Git repository.",
    );
  }
  const secureRoot = secureFiles
    ? signal
      ? await secureFiles.authorizeRoot(canonical, signal)
      : await secureFiles.authorizeRoot(canonical)
    : undefined;
  requireRepositoryResolutionActive(signal);
  if (
    secureRoot
    && (
      secureRoot.identity.dev !== canonicalInfo.dev.toString(10)
      || secureRoot.identity.ino !== canonicalInfo.ino.toString(10)
      || secureRoot.birthtimeNs !== canonicalInfo.birthtimeNs.toString(10)
    )
  ) {
    throw new GitError(
      "conflict",
      "The repository folder changed while it was being inspected.",
    );
  }
  const resolvedRepositoryRoot = await repositoryRoot(canonical, { signal });
  if (
    canonicalIdentity(resolvedRepositoryRoot)
    !== canonicalIdentity(canonical)
  ) {
    throw new GitError(
      "not-repository",
      "The selected folder is not a distinct Git repository.",
    );
  }
  const metadataMarkerIdentity = await repositoryMetadataMarkerIdentity(
    secureRoot?.root ?? canonical,
    { signal },
  );
  if (secureRoot) {
    if (signal) await secureFiles!.verifyRoot(secureRoot, signal);
    else await secureFiles!.verifyRoot(secureRoot);
  }
  requireRepositoryResolutionActive(signal);
  return { root: secureRoot?.root ?? canonical, secureRoot, metadataMarkerIdentity };
}

export async function resolveWorkspaceGitRepository(
  workspacePath: string,
  repositoryPath: string,
  secureFiles?: RuntimeSecureFileBroker,
  signal?: AbortSignal,
): Promise<ResolvedWorkspaceRepository> {
  const repository = await resolveWorkspaceGitRepositoryIdentity(
    workspacePath,
    repositoryPath,
    secureFiles,
    signal,
  );
  const status = await getRepositoryStatus(repository.root, { signal });
  const verifiedMetadataMarkerIdentity = await repositoryMetadataMarkerIdentity(
    repository.root,
    { signal },
  );
  if (repository.metadataMarkerIdentity !== verifiedMetadataMarkerIdentity) {
    throw new GitError(
      "conflict",
      "The Git repository identity changed while it was being inspected.",
    );
  }
  if (repository.secureRoot) {
    if (signal) {
      await secureFiles!.verifyRoot(repository.secureRoot, signal);
    } else {
      await secureFiles!.verifyRoot(repository.secureRoot);
    }
  }
  requireRepositoryResolutionActive(signal);
  if (canonicalIdentity(status.root) !== canonicalIdentity(repository.root)) {
    throw new GitError("not-repository", "The selected folder is not a distinct Git repository.");
  }
  return { ...repository, root: status.root, status };
}

export function workspaceGitFilePath(repositoryPath: string, filePath: string): string {
  const normalizedRepository = normalizedRepositoryPath(repositoryPath);
  if (
    typeof filePath !== "string"
    || filePath.length === 0
    || filePath.length > 4_096
    || filePath.includes("\0")
    || filePath.includes("\\")
    || isAbsolute(filePath)
  ) {
    throw new GitError("invalid-input", "The file path is invalid.");
  }
  const segments = filePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new GitError("invalid-input", "The file path is invalid.");
  }
  return normalizedRepository === "." ? segments.join("/") : `${normalizedRepository}/${segments.join("/")}`;
}
