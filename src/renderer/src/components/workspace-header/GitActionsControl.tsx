import { lazy, Suspense, useCallback, useEffect, useId, useRef } from "react";
import {
  ChevronDown,
  CloudDownload,
  CloudUpload,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitPullRequest,
  Info,
} from "lucide-react";
import type { GitStatusSnapshot } from "@shared/contracts";

import { useDismissibleMenu } from "../../hooks/useDismissibleMenu";
import { useFocusOutDismiss } from "./useFocusOutDismiss";
import {
  resolveQuickAction,
  type GitQuickAction,
} from "../../utils/gitActionsControl";
import type { HeaderGitActionId } from "../../utils/headerGitActions";
import { loadCommitDialog } from "../lazySurfaceLoaders";
import { HeaderMenuGroup } from "./HeaderMenuGroup";
import type { HeaderControlPresentation } from "./ProjectActionsControl";

const loadWorkspaceGitActionMenu = () => import("../WorkspaceGitActionMenu");
const WorkspaceGitActionMenu = lazy(loadWorkspaceGitActionMenu);

const GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS = 250;

export function GitQuickActionIcon({
  quickAction,
  size = 14,
}: {
  quickAction: GitQuickAction;
  size?: number;
}): React.JSX.Element {
  if (quickAction.kind === "pull") return <CloudDownload size={size} aria-hidden="true" />;
  if (quickAction.kind === "push") return <CloudUpload size={size} aria-hidden="true" />;
  if (quickAction.kind === "push_pull_request") return <GitPullRequest size={size} aria-hidden="true" />;
  if (quickAction.kind === "create_branch") return <GitBranchPlus size={size} aria-hidden="true" />;
  if (quickAction.kind === "commit" || quickAction.label === "Commit") {
    return <GitCommitHorizontal size={size} aria-hidden="true" />;
  }
  if (quickAction.label === "Push") return <CloudUpload size={size} aria-hidden="true" />;
  return <Info size={size} aria-hidden="true" />;
}

interface GitActionsControlProps {
  presentation: HeaderControlPresentation;
  status: GitStatusSnapshot;
  busy: boolean;
  notice?: string | null;
  onCommit: () => void;
  onPush: () => void;
  onPull: () => void;
  onFetch?: () => void;
  onOpenPullRequest: () => void;
  onPushAndCreatePullRequest: () => void;
  onOpenBranches: () => void;
  onRefreshStatus?: () => void;
  onRequestMenuClose?: () => void;
}

export function GitActionsControl({
  presentation,
  status,
  busy,
  notice = null,
  onCommit,
  onPush,
  onPull,
  onFetch,
  onOpenPullRequest,
  onPushAndCreatePullRequest,
  onOpenBranches,
  onRefreshStatus,
  onRequestMenuClose,
}: GitActionsControlProps): React.JSX.Element {
  const hintId = useId();
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"git">();
  const anchorRef = useRef<HTMLDivElement>(null);
  const dismissOnFocusOut = useCallback(() => dismissMenu("context-change"), [dismissMenu]);
  useFocusOutDismiss(anchorRef, menu !== null && presentation === "toolbar", dismissOnFocusOut);
  const quickAction = resolveQuickAction(status, busy);
  const quickActionDisabledReason = quickAction.disabled
    ? quickAction.hint ?? "This action is currently unavailable."
    : null;
  const refreshRef = useRef(onRefreshStatus);
  useEffect(() => {
    refreshRef.current = onRefreshStatus;
  });
  useEffect(() => {
    dismissMenu("context-change");
  }, [dismissMenu, presentation, status.root]);
  useEffect(() => {
    let refreshTimeout: number | null = null;
    const scheduleRefresh = (): void => {
      if (refreshTimeout !== null) window.clearTimeout(refreshTimeout);
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        refreshRef.current?.();
      }, GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS);
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") scheduleRefresh();
    };
    window.addEventListener("focus", scheduleRefresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      if (refreshTimeout !== null) window.clearTimeout(refreshTimeout);
      window.removeEventListener("focus", scheduleRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const runAction = (action: HeaderGitActionId): void => {
    if (menu) dismissMenu("selection");
    onRequestMenuClose?.();
    if (action === "commit") onCommit();
    else if (action === "fetch") onFetch?.();
    else if (action === "pull") onPull();
    else if (action === "push") onPush();
    else onOpenPullRequest();
  };
  const runQuickAction = (): void => {
    if (quickAction.disabled) return;
    onRequestMenuClose?.();
    if (quickAction.kind === "commit") onCommit();
    else if (quickAction.kind === "push") onPush();
    else if (quickAction.kind === "pull") onPull();
    else if (quickAction.kind === "push_pull_request") onPushAndCreatePullRequest();
    else if (quickAction.kind === "create_branch") onOpenBranches();
  };
  const openBranches = (): void => {
    if (menu) dismissMenu("context-change");
    onRequestMenuClose?.();
    onOpenBranches();
  };

  if (presentation === "menu") {
    return (
      <>
        <button
          type="button"
          role="menuitem"
          className="header-menu-item"
          aria-disabled={quickAction.disabled || undefined}
          aria-describedby={quickActionDisabledReason ? hintId : undefined}
          onClick={runQuickAction}
        >
          <GitQuickActionIcon quickAction={quickAction} />
          <span>{quickAction.label}</span>
        </button>
        {quickActionDisabledReason && (
          <p id={hintId} className="header-menu-hint-text">{quickActionDisabledReason}</p>
        )}
        <HeaderMenuGroup label="Git actions" icon={<GitBranch size={14} aria-hidden="true" />}>
          <Suspense fallback={<p className="header-menu-hint-text" role="status">Loading Git actions…</p>}>
            <WorkspaceGitActionMenu
              embedded
              status={status}
              busy={busy}
              notice={notice}
              onAction={runAction}
              onOpenBranches={openBranches}
            />
          </Suspense>
        </HeaderMenuGroup>
      </>
    );
  }

  return (
    <div ref={anchorRef} className="header-split-anchor" data-header-menu="git">
      <div
        className={`header-split${quickAction.disabled ? " is-disabled" : ""}`}
        role="group"
        aria-label="Git actions"
      >
        <button
          type="button"
          className="header-split-primary"
          aria-label={quickAction.label}
          aria-disabled={quickAction.disabled || undefined}
          aria-describedby={quickActionDisabledReason ? hintId : undefined}
          title={quickActionDisabledReason ?? quickAction.hint ?? quickAction.label}
          onFocus={() => {
            if (quickAction.kind === "commit") void loadCommitDialog();
          }}
          onPointerEnter={() => {
            if (quickAction.kind === "commit") void loadCommitDialog();
          }}
          onClick={runQuickAction}
        >
          <GitQuickActionIcon quickAction={quickAction} />
          <span className="header-split-label">{quickAction.label}</span>
        </button>
        <button
          ref={(node) => setMenuTrigger("git", node)}
          type="button"
          className="header-split-chevron"
          aria-label="More Git actions"
          title="More Git actions"
          aria-expanded={menu === "git"}
          aria-haspopup="menu"
          aria-controls="workspace-header-git-menu"
          onFocus={() => void loadWorkspaceGitActionMenu()}
          onPointerEnter={() => void loadWorkspaceGitActionMenu()}
          onClick={() => {
            if (menu !== "git") onRefreshStatus?.();
            toggleMenu("git");
          }}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      {quickActionDisabledReason && (
        <span id={hintId} className="visually-hidden">{quickActionDisabledReason}</span>
      )}
      {menu === "git" && (
        <div ref={(node) => setMenuPopover("git", node)} className="header-split-popover-host">
          <Suspense fallback={<div className="header-popover git-action-popover" role="status">Loading Git actions…</div>}>
            <WorkspaceGitActionMenu
              status={status}
              busy={busy}
              notice={notice}
              onAction={runAction}
              onOpenBranches={openBranches}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
