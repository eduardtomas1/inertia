import { GitBranch, MessageSquarePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  onSwitchBranch: (name: string, remote?: boolean) => void | Promise<void>;
  onCreateBranch: (name: string) => void | Promise<void>;
  onCreateConversationInWorktree: () => void;
  onCreateConversationOnBranch: (branch: string) => void;
  onCreateConversationInIsolatedWorktree: () => void;
}): React.JSX.Element {
  const owner = useRef(0);
  useEffect(() => () => { owner.current += 1; }, []);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const locked = busy || pending;
  const change = async (action: () => void | Promise<void>): Promise<void> => {
    if (locked) return;
    const generation = owner.current;
    setPending(true);
    setFailure(null);
    try {
      await action();
      if (owner.current === generation) onClose();
    } catch (error) {
      if (owner.current === generation) {
        setFailure(error instanceof Error ? error.message : "The branch could not be changed. Refresh and retry.");
        setPending(false);
      }
    }
  };
  const contextMismatch = conversationContextMismatch(project, conversation, gitStatus);
  const chatActions: Array<[boolean, string, () => void]> = [
    [Boolean(conversation?.worktreePath), "New chat in this worktree", onCreateConversationInWorktree],
    [!conversation?.worktreePath && Boolean(gitStatus.branch), `New chat on ${gitStatus.branch}`, () => onCreateConversationOnBranch(gitStatus.branch!)],
    [Boolean(gitStatus.branch), "New chat in new isolated worktree", onCreateConversationInIsolatedWorktree],
  ];
  const availableChatActions = chatActions.filter(([available]) => available);
  return (
    <div className="header-popover branch-popover" id="workspace-header-branch-menu" role="menu" aria-label="Branches" onKeyDown={(event) => {
      if (event.target instanceof HTMLInputElement) {
        if (event.target.type !== "search") return;
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      }
      navigateMenuItems(event, '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)');
      if (event.defaultPrevented) document.activeElement?.scrollIntoView({ block: "nearest" });
    }}>
      <div className="header-popover-title">Branches</div>
      {contextMismatch && (
        <div className="checkout-context-note" role="status">
          <GitBranch size={14} aria-hidden="true" />
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
            <button type="button" disabled={locked} onClick={() => { void change(() => onSwitchBranch(contextMismatch.expectedBranch!)); }}>
              Switch to {contextMismatch.expectedBranch}
            </button>
          )}
        </div>
      )}
      {failure && <p className="git-branch-error" role="alert">{failure}</p>}
      <WorkspaceBranchList branches={branches} loading={branchesLoading} error={branchesError} onRefresh={onRefreshBranches} busy={locked} onClose={onClose} onSwitch={(name, remote) => { void change(() => onSwitchBranch(name, remote)); }} onCreate={(name) => { void change(() => onCreateBranch(name)); }} />
      {availableChatActions.length > 0 && (
        <div className="new-chat-location-actions">
          <div className="header-popover-title">Start another chat</div>
          {availableChatActions.map(([, label, action]) => (
            <button type="button" role="menuitem" disabled={locked} key={label} onClick={() => { onClose(); action(); }}>
              <MessageSquarePlus size={13} /><span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
