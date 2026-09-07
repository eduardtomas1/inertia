import { Info, MessageSquarePlus } from "lucide-react";
import type { Conversation, GitBranchInfo, GitStatusSnapshot, Project } from "@shared/contracts";
import { conversationContextMismatch } from "../lib/newConversation";
import { navigateMenuItems } from "../utils/menuKeyboard";
import WorkspaceBranchList from "./WorkspaceBranchList";

export default function WorkspaceBranchMenu({
  project, conversation, gitStatus, branches, branchesLoading, branchesError,
  busy, onClose, onRefreshBranches, onSwitchBranch, onCreateBranch,
  onCreateConversationInWorktree, onCreateConversationOnBranch,
  onCreateConversationInIsolatedWorktree,
}: {
  project: Project;
  conversation: Conversation | null;
  gitStatus: GitStatusSnapshot;
  branches: GitBranchInfo[];
  branchesLoading?: boolean;
  branchesError?: string | null;
  busy: boolean;
  onClose: () => void;
  onRefreshBranches: () => void;
  onSwitchBranch: (name: string, remote?: boolean) => void;
  onCreateBranch: (name: string) => void;
  onCreateConversationInWorktree: () => void;
  onCreateConversationOnBranch: (branch: string) => void;
  onCreateConversationInIsolatedWorktree: () => void;
}): React.JSX.Element {
  const contextMismatch = conversationContextMismatch(project, conversation, gitStatus);
  const canCreateInWorktree = Boolean(conversation?.worktreePath);
  const canCreateOnBranch = !canCreateInWorktree && Boolean(gitStatus.branch);
  const canCreateIsolatedWorktree = Boolean(gitStatus.branch);
  return (
    <div className="header-popover branch-popover" id="workspace-header-branch-menu" role="menu" aria-label="Branches" onKeyDown={navigateMenuItems}>
      <div className="header-popover-title">Branches</div>
      {contextMismatch && (
        <div className="checkout-context-note" role="status">
          <Info size={14} aria-hidden="true" />
          <span>
            <strong>Chat and checkout differ</strong>
            {contextMismatch.branchDiffers && (
              <small>This chat was saved on <code>{contextMismatch.expectedBranch}</code>. The checkout is now <code>{contextMismatch.actualBranch}</code>.</small>
            )}
            {contextMismatch.checkoutDiffers && (
              <small>The saved worktree and current Git checkout resolve to different folders.</small>
            )}
          </span>
          {contextMismatch.branchDiffers && contextMismatch.expectedBranch && !conversation?.worktreePath && (
            <button type="button" onClick={() => { onClose(); onSwitchBranch(contextMismatch.expectedBranch!); }}>
              Switch to {contextMismatch.expectedBranch}
            </button>
          )}
        </div>
      )}
      <WorkspaceBranchList branches={branches} loading={branchesLoading} error={branchesError} onRefresh={onRefreshBranches} busy={busy} onSwitch={(name, remote) => { onClose(); onSwitchBranch(name, remote); }} onCreate={(name) => { onClose(); onCreateBranch(name); }} />
      {(canCreateInWorktree || canCreateOnBranch || canCreateIsolatedWorktree) && (
        <div className="new-chat-location-actions">
          <div className="header-popover-title">Start another chat</div>
          {canCreateInWorktree && (
            <button type="button" role="menuitem" onClick={() => { onClose(); onCreateConversationInWorktree(); }}>
              <MessageSquarePlus size={13} /><span>New chat in this worktree</span>
            </button>
          )}
          {canCreateOnBranch && gitStatus.branch && (
            <button type="button" role="menuitem" onClick={() => { onClose(); onCreateConversationOnBranch(gitStatus.branch!); }}>
              <MessageSquarePlus size={13} /><span>New chat on {gitStatus.branch}</span>
            </button>
          )}
          {canCreateIsolatedWorktree && (
            <button type="button" role="menuitem" onClick={() => { onClose(); onCreateConversationInIsolatedWorktree(); }}>
              <MessageSquarePlus size={13} /><span>New chat in new isolated worktree</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
