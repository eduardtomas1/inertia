import { useEffect, useRef } from "react";
import {
  Download,
  GitCommitHorizontal,
  GitPullRequest,
  Upload,
} from "lucide-react";

import type { GitStatusSnapshot } from "@shared/contracts";
import {
  headerGitActions,
  type HeaderGitActionId,
} from "../utils/headerGitActions";
import { loadCommitDialog } from "./lazySurfaceLoaders";
import { navigateMenuItems } from "../utils/menuKeyboard";

type WorkspaceGitActionMenuProps = {
  status: GitStatusSnapshot;
  busy: boolean;
  onAction: (action: HeaderGitActionId) => void;
};

function actionIcon(action: HeaderGitActionId): React.JSX.Element {
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
      <div className="git-action-popover-status">
        <strong>{status.branch ?? "Detached HEAD"}</strong>
        <span>
          {status.ahead > 0 ? `${status.ahead} ahead` : ""}
          {status.ahead > 0 && status.behind > 0 ? " · " : ""}
          {status.behind > 0 ? `${status.behind} behind` : ""}
          {status.ahead === 0 && status.behind === 0 ? "Up to date" : ""}
        </span>
      </div>
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
