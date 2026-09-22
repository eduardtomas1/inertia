import type {
  Conversation,
  GitBranchInfo,
  GitStatusSnapshot,
  Project,
} from "@shared/contracts";

export interface CheckoutBranchControlModel {
  project: Project;
  conversation: Conversation | null;
  gitStatus: GitStatusSnapshot | null;
  branches: GitBranchInfo[];
  branchesLoading?: boolean;
  branchesError?: string | null;
  busy: boolean;
  respondsToHeaderRequests?: boolean;
  onRefreshBranches: () => void;
  onSwitchBranch: (name: string, remote?: boolean) => void | Promise<void>;
  onCreateBranch: (name: string) => void | Promise<void>;
  onCreateConversationOnBranch: (branch: string) => void;
  onCreateConversationInWorktree: () => void;
  onCreateConversationInIsolatedWorktree: () => void;
}
