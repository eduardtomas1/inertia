export {
  GitError,
  type CreateWorktreeOptions,
  type GitArtifactState,
  type GitBranch,
  type GitBranches,
  type GitChangedFile,
  type GitCommitResult,
  type GitDiffOptions,
  type GitDiffReversalResult,
  type GitDiffSelection,
  type GitErrorCode,
  type GitFileStatus,
  type GitMutationResult,
  type GitRepositoryStatus,
  type GitSnapshotComparison,
  type GitUnifiedDiff,
} from "./git/types";
export {
  getRepositoryStatus,
  refreshRepositoryStatus,
} from "./git/status";
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
  type BranchCleanupOutcome,
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
  type OwnedWorktreeCreationDependencies,
  type OwnedWorktreeInspectionDependencies,
  type OwnedWorktreeCleanupInspection,
  type UnacknowledgedWorktreeCreationInspection,
  type WorktreeFilesystemIdentityDependencies,
  type RegisteredWorktreeIdentity,
  type RegisteredWorktreeOwnership,
  type RegisteredWorktreeRegistration,
  removeWorktree,
} from "./git/worktrees";
export {
  isWorktreeFilesystemIdentity,
  isWorktreeFilesystemReceipt,
  parseWorktreeFilesystemReceipt,
  serializeWorktreeFilesystemReceipt,
  type WorktreeFilesystemIdentity,
  type WorktreeFilesystemReceipt,
  worktreeFilesystemIdentitiesEqual,
} from "./worktree-filesystem-identity";
export { commitChanges } from "./git/commits";
export {
  getPullRequestCreateUrl,
  pullRepository,
  pushCurrentBranch,
} from "./git/remotes";
export {
  inspectGitRemoteRouting,
  parseGitRemoteWebTarget,
  type GitPullRequestTarget,
  type GitRemoteRoutingInspection,
  type GitRemoteWebTarget,
} from "./git/remote-routing";
export { cleanupReversalOperations } from "./git/reversal-registry-adapter";
export {
  inspectDiffSelection,
  revertDiffSelection,
  type ReversalTestHooks,
  undoDiffSelection,
} from "./git/reversal";
