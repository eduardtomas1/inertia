import type {
  DiffReversalOperation,
  DiffReversalValidation,
  GitPullRequestCapability,
  TurnGitArtifactFile,
} from "../../shared/contracts";
import type { GitScanRequest } from "./scan-contracts";

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

export const GIT_PROCESS_TREE_TERMINATION_FAILURE =
  "Git stopped responding, and its process tree could not be confirmed stopped.";

/** An error whose message is safe to show directly in the application UI. */
export class GitError extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string) {
    super(message.slice(0, 240));
    this.name = "GitError";
    this.code = code;
  }
}

export function isGitProcessTreeTerminationFailure(
  error: unknown,
): error is GitError {
  return error instanceof GitError
    && error.code === "operation-failed"
    && error.message === GIT_PROCESS_TREE_TERMINATION_FAILURE;
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
  hasRemote: boolean;
  pullRequest: GitPullRequestCapability;
  files: GitChangedFile[];
  insertions: number;
  deletions: number;
  clean: boolean;
  truncated: boolean;
}

export interface GitDiffOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
  maxFiles?: number;
  maxBytes?: number;
  paths?: string[];
  ignoreWhitespace?: boolean;
  statusScan?: Omit<GitScanRequest, "deadlineAt" | "optionsKey" | "signal">;
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
  /** The commit exists, but a non-authoritative post-commit refresh needs retry. */
  refreshWarning?: string;
}

export interface CreateWorktreeOptions {
  branch?: string;
  createBranch?: boolean;
  startPoint?: string;
}
