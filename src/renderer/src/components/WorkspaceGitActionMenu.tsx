import { useEffect, useRef, type KeyboardEvent } from "react";
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
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]',
    )];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? current <= 0 ? items.length - 1 : current - 1
          : current < 0 || current === items.length - 1 ? 0 : current + 1;
    items[next]?.focus();
  };
  return (
    <div
      ref={menuRef}
      className="header-popover git-action-popover"
      id="workspace-header-git-menu"
      role="menu"
      aria-label="Git actions"
      onKeyDown={moveFocus}
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
