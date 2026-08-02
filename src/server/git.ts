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
  deleteBranchIfUnchanged,
  listBranches,
  switchBranch,
} from "./git/branches";
export {
  confirmWorktreeRemovalIfAbsent,
  createWorktree,
  createWorktreeWithOwnershipReceipt,
  inspectRegisteredWorktreeOwnership,
  type OwnedWorktreeCreationHooks,
  type OwnedWorktreeRemovalHooks,
  type RegisteredWorktreeOwnership,
  removeWorktree,
  removeWorktreeIfOwnershipUnchanged,
} from "./git/worktrees";
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
