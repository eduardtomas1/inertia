import { useEffect, useRef, useState } from "react";
import { Activity, ChevronDown, Download, FolderOpen, GitBranch, GitCommitHorizontal, GitPullRequest, Info, ListFilter, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RadioTower, Settings, SunMoon } from "lucide-react";
import type { Conversation, GitBranchInfo, GitStatusSnapshot, Project, ProjectAction, ThemePreference } from "@shared/contracts";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { conversationContextMismatch } from "../lib/newConversation";
import type { EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { EnvironmentSummary } from "./EnvironmentSummary";
import type { WorkspacePanelTab } from "./WorkspacePanel";
import { IconButton } from "./ui";
import { useRemoteAccessState } from "../hooks/useRemoteAccessState";

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
  onRunAction,
  onToggleActivity,
}: WorkspaceHeaderProps): React.JSX.Element {
  const [menu, setMenu] = useState<"branch" | "action" | null>(null);
  const remoteAccess = useRemoteAccessState();
  useNativePreviewSuspension(menu !== null);
  const environmentAnchorRef = useRef<HTMLDivElement>(null);
  const title = view === "settings" ? "Settings" : conversation?.title ?? project?.name ?? "Workspace";
  const eyebrow = view === "settings" ? "Personalize your workspace" : project?.name && conversation ? project.name : "Inertia";
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

  return (
    <header className="workspace-header drag-region">
      <div className="header-leading no-drag">
        <IconButton label="Toggle project navigation" className="menu-button" aria-pressed={!sidebarCollapsed} onClick={onOpenSidebar}>
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </IconButton>
        <div className="header-title-wrap"><span className="header-eyebrow">{eyebrow}</span><h1>{title}</h1></div>
      </div>

      <div className="header-actions no-drag">
        {remoteAccess?.enabled && (
          <button
            type="button"
            className={`header-button remote-access-indicator${remoteAccess.activeSessions > 0 ? " is-active" : ""}`}
            aria-label={remoteAccess.activeSessions > 0
              ? `Remote Companion, ${remoteAccess.activeSessions} active sessions`
              : `Remote Companion ${remoteAccess.connection}`}
            onClick={onOpenSettings}
          >
            <RadioTower size={14} />
            <span>
              {remoteAccess.activeSessions > 0
                ? `Remote · ${remoteAccess.activeSessions} active`
                : "Remote on"}
            </span>
          </button>
        )}
        {view === "workspace" && project && (
          <>
            {actions.length > 0 && (
              <div className="header-popover-anchor">
                <button type="button" className="header-button" aria-expanded={menu === "action"} onClick={() => { onSetEnvironmentOpen(false); setMenu(menu === "action" ? null : "action"); }}>
                  <Plus size={14} /><span>Add action</span>
                </button>
                {menu === "action" && (
                  <div className="header-popover action-header-popover" role="menu" aria-label="Project actions">
                    {actions.map((action) => <button type="button" role="menuitem" key={action.id} onClick={() => { setMenu(null); onRunAction(action); }}><strong>{action.label}</strong><small>{action.command}</small></button>)}
                  </div>
                )}
              </div>
            )}
            <button type="button" className="header-button" onClick={onOpenProject}><FolderOpen size={14} /><span>Open</span></button>
            {gitStatus?.isRepository && (
              <div className="header-popover-anchor">
                <button
                  type="button"
                  className={`header-button${contextMismatch ? " has-context-mismatch" : ""}`}
                  aria-expanded={menu === "branch"}
                  aria-label={contextMismatch ? `Checkout context differs, current branch ${gitStatus.branch ?? "detached"}` : undefined}
                  onClick={() => { onSetEnvironmentOpen(false); const next = menu === "branch" ? null : "branch"; setMenu(next); if (next) onRefreshBranches(); }}
                >
                  <GitBranch size={14} /><span>{gitStatus.branch ?? "Detached"}</span>{contextMismatch && <span className="checkout-context-dot" aria-hidden="true" />}<ChevronDown size={12} />
                </button>
                {menu === "branch" && (
                  <div className="header-popover branch-popover" role="menu" aria-label="Branches">
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
            <button type="button" className="header-button primary-header-button" onClick={onCommit} disabled={busy || !gitStatus?.isRepository || gitStatus.files.length === 0}>
              <GitCommitHorizontal size={14} /><span>Commit & push</span><ChevronDown size={12} />
            </button>
            {gitStatus?.upstream && <button type="button" className="header-button" onClick={onPull} disabled={busy || gitStatus.files.length > 0}><Download size={14} /><span>{gitStatus.behind > 0 ? `Pull ${gitStatus.behind}` : "Pull"}</span></button>}
            {gitStatus?.hasRemote && <button type="button" className="header-button" onClick={onOpenPullRequest} disabled={busy}><GitPullRequest size={14} /><span>Pull request</span></button>}
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
