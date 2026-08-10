import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Activity, ChevronDown, FolderOpen, GitBranch, Info, ListFilter, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RadioTower, Settings, SunMoon } from "lucide-react";
import type { Conversation, GitBranchInfo, GitStatusSnapshot, Project, ProjectAction, ThemePreference } from "@shared/contracts";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { conversationContextMismatch } from "../lib/newConversation";
import type { EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { EnvironmentSummary } from "./EnvironmentSummary";
import type { WorkspacePanelTab } from "./WorkspacePanel";
import { IconButton } from "./ui";
import { usePrivateConnectState } from "../hooks/usePrivateConnectState";
import type { HeaderGitActionId } from "../utils/headerGitActions";
import { primaryHeaderGitAction } from "../utils/primaryHeaderGitAction";
import {
  loadActivityCenter,
  loadCommitDialog,
  loadTerminalPanel,
} from "./lazySurfaceLoaders";

const loadWorkspaceGitActionMenu = () => import("./WorkspaceGitActionMenu");
const WorkspaceGitActionMenu = lazy(loadWorkspaceGitActionMenu);

type WorkspaceHeaderProps = {
  project: Project | null;
  conversation: Conversation | null;
  view: "workspace" | "settings";
  activeTool: WorkspacePanelTab | null;
  sidebarCollapsed: boolean;
  theme: ThemePreference;
  gitStatus: GitStatusSnapshot | null;
  branches: GitBranchInfo[];
  actions: ProjectAction[];
  busy: boolean;
  activityOpen: boolean;
  activeRunCount: number;
  attentionRunCount: number;
  environmentSummary: EnvironmentSummarySnapshot;
  environmentOpen: boolean;
  onOpenSidebar: () => void;
  onToggleTools: () => void;
  workspaceToolsUnavailableReason?: string | null;
  onSetEnvironmentOpen: (open: boolean) => void;
  onCycleTheme: () => void;
  onOpenSettings: () => void;
  onOpenConnectionsSettings: () => void;
  onOpenProject: () => void;
  onRefreshBranches: () => void;
  onSwitchBranch: (name: string) => void;
  onCreateBranch: (name: string) => void;
  onCreateConversationOnBranch: (branch: string) => void;
  onCreateConversationInWorktree: () => void;
  onCreateConversationInIsolatedWorktree: () => void;
  onCommit: () => void;
  onOpenPullRequest: () => void;
  onPull: () => void;
  onPush: () => void;
  onRunAction: (action: ProjectAction) => void;
  onToggleActivity: () => void;
};

export function WorkspaceHeader({
  project,
  conversation,
  view,
  activeTool,
  sidebarCollapsed,
  theme,
  gitStatus,
  branches,
  actions,
  busy,
  activityOpen,
  activeRunCount,
  attentionRunCount,
  environmentSummary,
  environmentOpen,
  onOpenSidebar,
  onToggleTools,
  workspaceToolsUnavailableReason = null,
  onSetEnvironmentOpen,
  onCycleTheme,
  onOpenSettings,
  onOpenConnectionsSettings,
  onOpenProject,
  onRefreshBranches,
  onSwitchBranch,
  onCreateBranch,
  onCreateConversationOnBranch,
  onCreateConversationInWorktree,
  onCreateConversationInIsolatedWorktree,
  onCommit,
  onOpenPullRequest,
  onPull,
  onPush,
  onRunAction,
  onToggleActivity,
}: WorkspaceHeaderProps): React.JSX.Element {
  const [menu, setMenu] = useState<"branch" | "action" | "git" | null>(null);
  const privateConnectLoad = usePrivateConnectState();
  const privateConnect = privateConnectLoad.state;
  const pendingPrivateConnectPairings = privateConnect?.pendingPairings.length ?? 0;
  const pendingPrivateConnectPairing = privateConnect?.pendingPairings[0] ?? null;
  useNativePreviewSuspension(menu !== null);
  const headerActionsRef = useRef<HTMLDivElement>(null);
  const environmentAnchorRef = useRef<HTMLDivElement>(null);
  const title = view === "settings" ? "Settings" : conversation?.title ?? project?.name ?? "Workspace";
  const eyebrow = view === "settings"
    ? null
    : project?.name && conversation ? project.name : "Inertia";
  const activityBadgeCount = attentionRunCount || activeRunCount;
  const activityLabel = attentionRunCount > 0
    ? `Open runs, ${attentionRunCount} ${attentionRunCount === 1 ? "item needs" : "items need"} attention`
    : activeRunCount > 0
      ? `Open runs, ${activeRunCount} active`
      : "Open runs";
  const contextMismatch = conversationContextMismatch(project, conversation, gitStatus);
  const canCreateInWorktree = Boolean(conversation?.worktreePath);
  const canCreateOnBranch = !canCreateInWorktree && Boolean(gitStatus?.branch);
  const canCreateIsolatedWorktree = Boolean(gitStatus?.branch);
  const primaryGitAction = primaryHeaderGitAction(gitStatus);
  const runGitAction = (action: HeaderGitActionId): void => {
    setMenu(null);
    if (action === "commit") onCommit();
    else if (action === "pull") onPull();
    else if (action === "push") onPush();
    else onOpenPullRequest();
  };
  const moveMenuFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])',
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

  useEffect(() => {
    if (!environmentOpen) return;
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node
        && !environmentAnchorRef.current?.contains(event.target)
      ) {
        onSetEnvironmentOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      onSetEnvironmentOpen(false);
      environmentAnchorRef.current?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [environmentOpen, onSetEnvironmentOpen]);

  useEffect(() => {
    if (!menu) return;
    const activeAnchor = headerActionsRef.current?.querySelector<HTMLElement>(
      `[data-header-menu="${menu}"]`,
    );
    const focusTimer = window.setTimeout(() => {
      if (menu !== "git") {
        activeAnchor?.querySelector<HTMLElement>(
          '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])',
        )?.focus();
      }
    }, 0);
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node
        && !activeAnchor?.contains(event.target)
      ) {
        setMenu(null);
      }
    };
    const closeOnFocusIn = (event: FocusEvent): void => {
      const activeMenu = activeAnchor?.lastElementChild;
      if (
        activeMenu
        && event.target instanceof Node
        && !activeMenu.contains(event.target)
      ) {
        setMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const trigger = activeAnchor?.querySelector<HTMLElement>(
        '[aria-expanded="true"]',
      );
      setMenu(null);
      trigger?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("focusin", closeOnFocusIn);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("focusin", closeOnFocusIn);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  return (
    <header className="workspace-header drag-region">
      <div className="header-leading no-drag">
        <IconButton label="Toggle project navigation" className="menu-button" aria-pressed={!sidebarCollapsed} onClick={onOpenSidebar}>
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </IconButton>
        <div className="header-title-wrap">{eyebrow && <span className="header-eyebrow">{eyebrow}</span>}<h1>{title}</h1></div>
      </div>

      <div className="header-actions no-drag" ref={headerActionsRef}>
        {privateConnect && (
          <div className="header-popover-anchor private-connect-alert-anchor">
            <button
              type="button"
              className={`header-button private-connect-indicator${
                pendingPrivateConnectPairings > 0
                  ? " has-pending"
                  : privateConnect.activeSessions > 0
                    ? " is-active"
                    : ""
              }`}
              aria-label={pendingPrivateConnectPairings > 0
                ? `Connections & devices, ${pendingPrivateConnectPairings} pairing ${pendingPrivateConnectPairings === 1 ? "approval" : "approvals"} waiting`
                : privateConnect.activeSessions > 0
                  ? `Connections & devices, ${privateConnect.activeSessions} active browsers`
                  : `Connections & devices ${privateConnect.status}`}
              onClick={onOpenConnectionsSettings}
            >
              <RadioTower size={14} />
              <span>
                {pendingPrivateConnectPairings > 0
                  ? pendingPrivateConnectPairings === 1
                    ? "Approve device"
                    : `Approve ${pendingPrivateConnectPairings} devices`
                  : privateConnect.activeSessions > 0
                  ? `Devices · ${privateConnect.activeSessions} active`
                  : "Devices"}
              </span>
            </button>
            {pendingPrivateConnectPairing && (
              <div className="private-connect-pairing-alert" role="alert" aria-label="Private Connect pairing approval">
                <strong>{pendingPrivateConnectPairing.deviceLabel} wants to connect</strong>
                <span>Code <code>{pendingPrivateConnectPairing.comparisonCode}</code></span>
                <small>{pendingPrivateConnectPairing.tailnetLabel ?? "Tailnet identity unavailable"}</small>
                {pendingPrivateConnectPairings > 1 && <small>+{pendingPrivateConnectPairings - 1} more waiting</small>}
                <button type="button" onClick={onOpenConnectionsSettings}>Review access</button>
              </div>
            )}
          </div>
        )}
        {view === "workspace" && project && (
          <>
            {actions.length > 0 && (
              <div className="header-popover-anchor" data-header-menu="action">
                <button type="button" className="header-button" aria-haspopup="menu" aria-controls="workspace-header-action-menu" aria-expanded={menu === "action"} onClick={() => { onSetEnvironmentOpen(false); setMenu(menu === "action" ? null : "action"); }}>
                  <Plus size={14} /><span>Add action</span>
                </button>
                {menu === "action" && (
                  <div className="header-popover action-header-popover" id="workspace-header-action-menu" role="menu" aria-label="Project actions" onKeyDown={moveMenuFocus}>
                    {actions.map((action) => <button type="button" role="menuitem" key={action.id} onClick={() => { setMenu(null); onRunAction(action); }}><strong>{action.label}</strong><small>{action.command}</small></button>)}
                  </div>
                )}
              </div>
            )}
            <button type="button" className="header-button" onClick={onOpenProject}><FolderOpen size={14} /><span>Open</span></button>
            {gitStatus?.isRepository && (
              <div className="header-popover-anchor" data-header-menu="branch">
                <button
                  type="button"
                  className={`header-button${contextMismatch ? " has-context-mismatch" : ""}`}
                  aria-expanded={menu === "branch"}
                  aria-haspopup="menu"
                  aria-controls="workspace-header-branch-menu"
                  aria-label={contextMismatch ? `Checkout context differs, current branch ${gitStatus.branch ?? "detached"}` : undefined}
                  onClick={() => { onSetEnvironmentOpen(false); const next = menu === "branch" ? null : "branch"; setMenu(next); if (next) onRefreshBranches(); }}
                >
                  <GitBranch size={14} /><span>{gitStatus.branch ?? "Detached"}</span>{contextMismatch && <span className="checkout-context-dot" aria-hidden="true" />}<ChevronDown size={12} />
                </button>
                {menu === "branch" && (
                  <div className="header-popover branch-popover" id="workspace-header-branch-menu" role="menu" aria-label="Branches" onKeyDown={moveMenuFocus}>
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
                          <button type="button" onClick={() => { setMenu(null); onSwitchBranch(contextMismatch.expectedBranch!); }}>
                            Switch to {contextMismatch.expectedBranch}
                          </button>
                        )}
                      </div>
                    )}
                    {branches.filter((branch) => !branch.remote).map((branch) => (
                      <button type="button" role="menuitemradio" aria-checked={branch.current} key={branch.name} onClick={() => { setMenu(null); if (!branch.current) onSwitchBranch(branch.name); }}><span>{branch.name}</span>{branch.current && <span className="branch-current">Current</span>}</button>
                    ))}
                    <form className="new-branch-form" onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget).get("branch"); if (typeof input === "string" && input.trim()) { onCreateBranch(input.trim()); setMenu(null); } }}>
                      <input name="branch" placeholder="new-branch" aria-label="New branch name" maxLength={255} />
                      <button type="submit">Create</button>
                    </form>
                    {(canCreateInWorktree || canCreateOnBranch || canCreateIsolatedWorktree) && (
                      <div className="new-chat-location-actions">
                        <div className="header-popover-title">Start another chat</div>
                        {canCreateInWorktree && (
                          <button type="button" role="menuitem" onClick={() => { setMenu(null); onCreateConversationInWorktree(); }}>
                            <MessageSquarePlus size={13} /><span>New chat in this worktree</span>
                          </button>
                        )}
                        {canCreateOnBranch && gitStatus.branch && (
                          <button type="button" role="menuitem" onClick={() => { setMenu(null); onCreateConversationOnBranch(gitStatus.branch!); }}>
                            <MessageSquarePlus size={13} /><span>New chat on {gitStatus.branch}</span>
                          </button>
                        )}
                        {canCreateIsolatedWorktree && (
                          <button type="button" role="menuitem" onClick={() => { setMenu(null); onCreateConversationInIsolatedWorktree(); }}>
                            <MessageSquarePlus size={13} /><span>New chat in new isolated worktree</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {gitStatus?.isRepository && activeTool !== "changes" && (
              <div className="header-popover-anchor" data-header-menu="git">
                <div className="git-control">
                  {primaryGitAction && (
                    <button
                      type="button"
                      className="header-button primary-header-button git-primary"
                      aria-label={primaryGitAction.label}
                      onFocus={() => {
                        if (primaryGitAction.id === "commit") void loadCommitDialog();
                      }}
                      onClick={() => runGitAction(primaryGitAction.id)}
                      disabled={busy}
                    >
                      <span className="git-symbol" aria-hidden="true">{primaryGitAction.id === "commit" ? "●" : primaryGitAction.id === "pull" ? "↓" : "↑"}</span><span>{primaryGitAction.label}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="header-button git-menu"
                    aria-label="More Git actions"
                    aria-expanded={menu === "git"}
                    aria-haspopup="menu"
                    aria-controls="workspace-header-git-menu"
                    onFocus={() => void loadWorkspaceGitActionMenu()}
                    onPointerEnter={() => void loadWorkspaceGitActionMenu()}
                    onClick={() => {
                      onSetEnvironmentOpen(false);
                      setMenu(menu === "git" ? null : "git");
                    }}
                  >
                    {!primaryGitAction && <GitBranch size={14} />}
                    {!primaryGitAction && <span>Git</span>}
                    <ChevronDown size={12} />
                  </button>
                </div>
                {menu === "git" && (
                  <Suspense fallback={<div className="header-popover git-action-popover" role="status">Loading Git actions…</div>}>
                    <WorkspaceGitActionMenu
                      status={gitStatus}
                      busy={busy}
                      onAction={runGitAction}
                    />
                  </Suspense>
                )}
              </div>
            )}
          </>
        )}
        <div
          className="header-popover-anchor environment-summary-anchor"
          ref={environmentAnchorRef}
        >
          <IconButton
            label={environmentOpen ? "Close environment summary" : "Open environment summary"}
            aria-expanded={environmentOpen}
            aria-controls="environment-summary-popover"
            aria-pressed={environmentOpen}
            onClick={() => {
              setMenu(null);
              onSetEnvironmentOpen(!environmentOpen);
            }}
          >
            <ListFilter size={17} />
          </IconButton>
          {environmentOpen && (
            <div
              className="environment-summary-popover"
              id="environment-summary-popover"
            >
              <EnvironmentSummary summary={environmentSummary} />
            </div>
          )}
        </div>
        <IconButton
          label={activityLabel}
          className={`activity-center-button${attentionRunCount > 0 ? " has-attention" : ""}`}
          aria-pressed={activityOpen}
          onFocus={() => void loadActivityCenter()}
          onPointerDown={() => void loadActivityCenter()}
          onPointerEnter={() => void loadActivityCenter()}
          onClick={onToggleActivity}
        >
          <Activity size={17} />
          {activityBadgeCount > 0 && <span className="activity-count">{activityBadgeCount > 9 ? "9+" : activityBadgeCount}</span>}
        </IconButton>
        <IconButton label={`Change theme (current: ${theme})`} onClick={onCycleTheme}><SunMoon size={17} /></IconButton>
        {view === "workspace" ? (
          <IconButton
            label={workspaceToolsUnavailableReason
              ?? (activeTool ? "Close workspace tools" : "Open workspace tools")}
            aria-pressed={Boolean(activeTool)}
            onFocus={() => void loadTerminalPanel()}
            onPointerDown={() => void loadTerminalPanel()}
            onPointerEnter={() => void loadTerminalPanel()}
            onClick={onToggleTools}
            disabled={!project || Boolean(workspaceToolsUnavailableReason)}
          >
            {activeTool ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </IconButton>
        ) : (
          <IconButton label="Settings" aria-current="page" onClick={onOpenSettings}><Settings size={17} /></IconButton>
        )}
      </div>
    </header>
  );
}
