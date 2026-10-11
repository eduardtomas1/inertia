import { useEffect, useRef } from "react";
import {
  CloudDownload,
  CloudUpload,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";

import type { GitStatusSnapshot } from "@shared/contracts";
import {
  gitSyncSummary,
  type HeaderGitActionId,
} from "../utils/headerGitActions";
import {
  buildMenuItems,
  gitMenuWarning,
} from "../utils/gitActionsControl";
import { loadCommitDialog } from "./lazySurfaceLoaders";
import { HintButton } from "./HintButton";
import "./workspace-git-menus.css";
import { navigateMenuItems } from "../utils/menuKeyboard";

type WorkspaceGitActionMenuProps = {
  status: GitStatusSnapshot;
  busy: boolean;
  notice?: string | null;
  embedded?: boolean;
  onAction: (action: HeaderGitActionId) => void;
  onOpenBranches?: () => void;
};

const actionIcons = { fetch: RefreshCw, commit: GitCommitHorizontal, pull: CloudDownload, push: CloudUpload, "pull-request": GitPullRequest };

export default function WorkspaceGitActionMenu({
  status,
  busy,
  notice = null,
  embedded = false,
  onAction,
  onOpenBranches,
}: WorkspaceGitActionMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const items = buildMenuItems(status, busy);
  const warning = gitMenuWarning(status);
  useEffect(() => {
    if (embedded) return;
    const timer = window.setTimeout(() => {
      menuRef.current?.querySelector<HTMLElement>(
        '[role="menuitem"]',
      )?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [embedded]);
  const actions = (
    <>
      {items.map((action) => {
        const Icon = actionIcons[action.id];
        return (
          <HintButton
            role="menuitem"
            key={action.id}
            aria-disabled={action.disabled || undefined}
            hint={action.detail}
            onFocus={() => {
              if (action.id === "commit") void loadCommitDialog();
            }}
            onClick={() => {
              if (!action.disabled) onAction(action.id);
            }}
          >
            <Icon size={14} />
            <span>{action.label}</span>
          </HintButton>
        );
      })}
      {onOpenBranches && (
        <button
          type="button"
          role="menuitem"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onOpenBranches();
          }}
        >
          <GitBranch size={14} />
          <span>{status.branch ? "Switch branch" : "Create branch"}</span>
        </button>
      )}
      {warning && <p className="git-menu-note is-warning">{warning}</p>}
      {notice && <p className="git-menu-note is-error" role="status">{notice}</p>}
    </>
  );
  if (embedded) {
    return <div className="git-action-group" role="group" aria-label="Git actions">{actions}</div>;
  }
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
        <div className="git-overview-heading"><GitBranch size={14} aria-hidden="true" /><strong title={status.branch ?? "Detached HEAD"}>{status.branch ?? "Detached HEAD"}</strong></div>
        <div className="git-overview-detail">
          <span title={status.upstream ?? undefined}>{status.upstream ? `Tracking ${status.upstream}` : status.hasRemote ? "No upstream" : "No remote"}</span>
          {status.upstream && <span>{status.ahead} outgoing</span>}
          {status.upstream && <span>{status.behind} incoming</span>}
        </div>
        <div className="git-overview-summary" role="status">{busy ? "Git operation in progress…" : gitSyncSummary(status)}</div>
      </div>
      <div role="separator" />
      {actions}
    </div>
  );
}
