import type { ModelSelection } from "../model-routing";
import type { ProviderId } from "./app";

export interface ChangedFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  untracked: boolean;
  staged: boolean;
  unstaged: boolean;
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatusSnapshot {
  isRepository: boolean;
  /** Canonical Git toplevel actually inspected for this status snapshot. */
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  files: ChangedFile[];
  insertions: number;
  deletions: number;
}

export interface GitDiffSnapshot {
  patch: string;
  truncated: boolean;
  files: ChangedFile[];
}

export type WorkspaceGitRepositoryState = "ready" | "error";

/**
 * Status for one Git toplevel discovered inside the active workspace.
 * `repositoryPath` is a safe, POSIX-style path relative to that workspace;
 * the workspace root itself is represented by ".".
 */
export interface WorkspaceGitRepositorySnapshot {
  repositoryPath: string;
  state: WorkspaceGitRepositoryState;
  error: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  files: ChangedFile[];
  insertions: number;
  deletions: number;
  clean: boolean;
  truncated: boolean;
}

export interface WorkspaceGitIssue {
  repositoryPath: string;
  message: string;
}

/**
 * Bounded, workspace-wide Git discovery result. It deliberately remains
 * separate from immutable per-turn Git artifacts.
 */
export interface WorkspaceGitSnapshot {
  repositories: WorkspaceGitRepositorySnapshot[];
  files: number;
  insertions: number;
  deletions: number;
  scannedDirectories: number;
  skippedDirectories: number;
  /** Git markers found before applying the project's display limit. */
  discoveredRepositories: number;
  repositoryLimit: number;
  partial: boolean;
  truncated: boolean;
  issues: WorkspaceGitIssue[];
}

export interface WorkspaceGitDiffSnapshot extends GitDiffSnapshot {
  repositoryPath: string;
  /** True only when reconciliation changed persisted review metadata. */
  reviewMetadataChanged?: boolean;
}

export type TurnGitArtifactStatus = "pending" | "ready" | "partial" | "unavailable" | "failed";
export type TurnGitArtifactCompleteness = "complete" | "truncated" | "partial" | "unavailable";
export type TurnGitPatchState = "none" | "available" | "truncated" | "expired" | "failed";
export type TurnGitArtifactAbsenceReason = "not-repository";

export interface TurnGitArtifactFile extends ChangedFile {
  previousPath: string | null;
  binary: boolean;
}

/**
 * Immutable historical Git metadata captured for one authoritative agent turn.
 * Raw patches live in bounded content-addressed storage and are fetched only
 * through an explicit request; ordinary snapshots contain metadata only.
 */
export interface TurnGitArtifact {
  id: string;
  turnId: string;
  conversationId: string;
  runId: string;
  repositoryIdentity: string | null;
  worktreeIdentity: string | null;
  branch: string | null;
  beforeCheckpointId: string | null;
  beforeFingerprint: string | null;
  afterFingerprint: string | null;
  files: TurnGitArtifactFile[];
  insertions: number;
  deletions: number;
  status: TurnGitArtifactStatus;
  completeness: TurnGitArtifactCompleteness;
  patchState: TurnGitPatchState;
  patchDigest: string | null;
  capturedAt: string | null;
  terminalAssistantMessageId: string | null;
  failureReason: string | null;
  /**
   * Expected absence at the selected project root. Optional for snapshots
   * produced before the typed classification was introduced.
   */
  absenceReason?: TurnGitArtifactAbsenceReason | null;
}

export interface TurnGitDiffSnapshot extends GitDiffSnapshot {
  artifactId: string;
  turnId: string;
  title: string;
  completeness: TurnGitArtifactCompleteness;
  patchState: TurnGitPatchState;
}

export interface DiffLine {
  id: string;
  kind: "context" | "addition" | "deletion" | "meta";
  content: string;
  patchLine: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  newInsertionIndex: number;
  oldInsertionIndex: number;
  noFinalNewline?: boolean;
}

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
}

export interface StructuredDiff {
  fingerprint: string;
  files: DiffFile[];
}

export type GitDiffLayer = "index" | "worktree";

export interface DiffReversalValidation {
  diffFingerprint: string;
  fileFingerprint: string;
  hunkFingerprint: string;
  selectionFingerprint: string;
  gitStateFingerprint: string;
}

export interface DiffReversalPlan {
  filePath: string;
  hunkId: string;
  hunkHeader: string;
  selectedLineCount: number;
  changedLineCount: number;
  affectedLayers: GitDiffLayer[];
  validation: DiffReversalValidation;
}

export interface DiffReversalOperation {
  id: string;
  repositoryPath?: string;
  filePath: string;
  selectedLineCount: number;
  affectedLayers: GitDiffLayer[];
  createdAt: string;
}

export interface DiffReviewSummary {
  conversationId: string;
  fingerprint: string;
  providerId: ProviderId;
  /** Null only when a pre-v0.0.7 row did not record execution attribution. */
  harnessId: string | null;
  /** Null only when a pre-v0.0.7 row did not record execution attribution. */
  backendProfileId: string | null;
  /** Exact provider model ID, or null when the provider did not expose it. */
  model: string | null;
  overall: string;
  classifications: DiffReviewClassificationHint[];
  files: Array<{
    path: string;
    summary: string;
    classifications: DiffReviewClassificationHint[];
    hunks: Array<{
      hunkId: string;
      summary: string;
      classifications: DiffReviewClassificationHint[];
    }>;
  }>;
  generatedAt: string;
}

/**
 * Ephemeral result of an isolated read-only question about one exact diff
 * selection. It is intentionally not part of the conversation transcript or
 * AgentTurn ledger.
 */
export interface DiffSelectionReviewAnswer {
  conversationId: string;
  /** Workspace-relative Git root used for this answer; "." is the workspace root. */
  repositoryPath?: string;
  fingerprint: string;
  filePath: string;
  hunkId: string;
  selectedLineCount: number;
  question: string;
  answer: string;
  providerId: ProviderId;
  modelSelection: ModelSelection;
  generatedAt: string;
}

export type DiffReviewClassification =
  | "behavior-change"
  | "regression-risk"
  | "security-sensitive"
  | "migration"
  | "test-impact"
  | "performance-sensitive"
  | "documentation-only";

export interface DiffReviewClassificationHint {
  classification: DiffReviewClassification;
  evidence: string;
}

export type DiffReviewScope = "file" | "hunk";

export interface DiffReviewState {
  conversationId: string;
  /** Workspace-relative Git root. Missing only on legacy in-memory values. */
  repositoryPath?: string;
  scope: DiffReviewScope;
  path: string;
  hunkId: string | null;
  targetFingerprint: string;
  reviewed: boolean;
  stale: boolean;
  updatedAt: string;
}

export interface DiffReviewNote {
  id: string;
  conversationId: string;
  /** Workspace-relative Git root. Missing only on legacy in-memory values. */
  repositoryPath?: string;
  path: string;
  hunkId: string | null;
  lineIds: string[];
  targetFingerprint: string;
  body: string;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}
