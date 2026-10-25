export {
  GitError,
  type GitDiffSelection,
  type GitRepositoryStatus,
  type GitUnifiedDiff,
} from "./git/types";
export { getRepositoryStatus, repositoryChangeCounts } from "./git/status";
export {
  captureGitArtifactState,
  compareGitSnapshots,
} from "./git/artifacts";
export { getUnifiedDiff } from "./git/diff";
export {
  createBranch,
  inspectBranchCleanupOutcome,
  listBranches,
  switchBranch,
} from "./git/branches";
export {
  createWorktree,
  createWorktreeWithOwnershipReceipt,
  durableWorktreeDirectoryIdentity,
  inspectOwnedWorktreeCleanupState,
  inspectRegisteredWorktreeOwnership,
  inspectUnacknowledgedWorktreeCreation,
  preflightWorktreeFilesystemIdentity,
  type OwnedWorktreeCreationHooks,
  type WorktreeFilesystemIdentityDependencies,
  type RegisteredWorktreeIdentity,
  removeOwnedWorktree,
  removeWorktree,
} from "./git/worktrees";
export {
  parseWorktreeFilesystemReceipt,
  serializeWorktreeFilesystemReceipt,
  worktreeFilesystemIdentitiesEqual,
} from "./worktree-filesystem-identity";
export { commitReviewedChanges } from "./git/commits";
export { recoverReviewedCommitTransaction } from "./git/commit-recovery";
export {
  captureGitCommitReview,
  prepareGitCommitReview,
  renderGitCommitReviewDiff,
  gitCommitReviewFingerprintsEqual,
  gitCommitReviewStatusMatches,
} from "./git/commit-review";
export {
  getPullRequestCreateUrl,
  fetchRepository,
  pullRepository,
  pushCurrentBranch,
} from "./git/remotes";
export {
  createGitHubPullRequest,
} from "./git/github-pull-request";
export {
  inspectGitHubPreMergeConfidence,
} from "./git/github-pre-merge";
export {
  inspectGitRemoteRouting,
  parseGitRemoteWebTarget,
} from "./git/remote-routing";
export { cleanupReversalOperations } from "./git/reversal-registry-adapter";
export {
  inspectDiffSelection,
  revertDiffSelection,
  type ReversalTestHooks,
  undoDiffSelection,
} from "./git/reversal";
