import { useEffect, useRef } from "react";
import {
  Download,
  RefreshCw,
  GitBranch,
  ArrowDown,
  ArrowUp,
  GitCommitHorizontal,
  GitPullRequest,
  Upload,
} from "lucide-react";

import type { GitStatusSnapshot } from "@shared/contracts";
import {
  headerGitActions,
  gitSyncSummary,
  type HeaderGitActionId,
} from "../utils/headerGitActions";
import { loadCommitDialog } from "./lazySurfaceLoaders";
import "./workspace-git-menus.css";
import { navigateMenuItems } from "../utils/menuKeyboard";

type WorkspaceGitActionMenuProps = {
  status: GitStatusSnapshot;
  busy: boolean;
  onAction: (action: HeaderGitActionId) => void;
};

function actionIcon(action: HeaderGitActionId): React.JSX.Element {
  if (action === "fetch") return <RefreshCw size={14} />;
  if (action === "commit") return <GitCommitHorizontal size={14} />;
  if (action === "pull") return <Download size={14} />;
  if (action === "push") return <Upload size={14} />;
  return <GitPullRequest size={14} />;
}

export default function WorkspaceGitActionMenu({
  status,
  busy,
  onAction,
}: WorkspaceGitActionMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const actions = headerGitActions(status, busy);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      menuRef.current?.querySelector<HTMLElement>(
        '[role="menuitem"]',
      )?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div
      ref={menuRef}
      className="header-popover git-action-popover"
      id="workspace-header-git-menu"
      role="menu"
      aria-label="Git actions"
      onKeyDown={navigateMenuItems}
    >
      <div className="git-overview">
        <div className="git-overview-heading"><GitBranch size={15} /><strong title={status.branch ?? "Detached HEAD"}>{status.branch ?? "Detached HEAD"}</strong></div>
        <span className="git-overview-upstream" title={status.upstream ?? undefined}>{status.upstream ? `Tracking ${status.upstream}` : status.hasRemote ? "Publish this branch to set an upstream" : "Local repository · no remote"}</span>
        <div className="git-overview-counts">
          <span><ArrowUp size={12} />{status.upstream ? status.ahead : "—"} outgoing</span>
          <span><ArrowDown size={12} />{status.upstream ? status.behind : "—"} incoming</span>
        </div>
        <div className="git-overview-summary" role="status">{busy ? "Git operation in progress…" : gitSyncSummary(status)}</div>
      </div>
      <div className="git-menu-section-label">Changes <span>{status.files.length} {status.files.length === 1 ? "file" : "files"} <b>+{status.insertions}</b> <i>−{status.deletions}</i></span></div>
      {actions.map((action) => (
        <button
          type="button"
          role="menuitem"
          key={action.id}
          aria-disabled={action.disabled || undefined}
          onFocus={() => {
            if (action.id === "commit") void loadCommitDialog();
          }}
          onClick={() => {
            if (!action.disabled) onAction(action.id);
          }}
        >
          {actionIcon(action.id)}
          <span><strong>{action.label}</strong><small>{action.detail}</small></span>
        </button>
      ))}
    </div>
  );
}
