import { useState } from "react";
import { Activity, ChevronDown, Download, FolderOpen, GitBranch, GitCommitHorizontal, GitPullRequest, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, Settings, SunMoon } from "lucide-react";
import type { Conversation, GitBranchInfo, GitStatusSnapshot, Project, ProjectAction, ThemePreference } from "@shared/contracts";
import type { WorkspacePanelTab } from "./WorkspacePanel";
import { IconButton } from "./ui";

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
  onOpenSidebar: () => void;
  onToggleTools: () => void;
  onCycleTheme: () => void;
  onOpenSettings: () => void;
  onOpenProject: () => void;
  onRefreshBranches: () => void;
  onSwitchBranch: (name: string) => void;
  onCreateBranch: (name: string) => void;
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
  onOpenSidebar,
  onToggleTools,
  onCycleTheme,
  onOpenSettings,
  onOpenProject,
  onRefreshBranches,
  onSwitchBranch,
  onCreateBranch,
  onCommit,
  onOpenPullRequest,
  onPull,
  onRunAction,
  onToggleActivity,
}: WorkspaceHeaderProps): React.JSX.Element {
  const [menu, setMenu] = useState<"branch" | "action" | null>(null);
  const title = view === "settings" ? "Settings" : conversation?.title ?? project?.name ?? "Workspace";
  const eyebrow = view === "settings" ? "Personalize your workspace" : project?.name && conversation ? project.name : "Inertia";
  const activityBadgeCount = attentionRunCount || activeRunCount;
  const activityLabel = attentionRunCount > 0
    ? `Open runs, ${attentionRunCount} ${attentionRunCount === 1 ? "item needs" : "items need"} attention`
    : activeRunCount > 0
      ? `Open runs, ${activeRunCount} active`
      : "Open runs";

  return (
    <header className="workspace-header drag-region">
      <div className="header-leading no-drag">
        <IconButton label="Toggle project navigation" className="menu-button" aria-pressed={!sidebarCollapsed} onClick={onOpenSidebar}>
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </IconButton>
        <div className="header-title-wrap"><span className="header-eyebrow">{eyebrow}</span><h1>{title}</h1></div>
      </div>

      <div className="header-actions no-drag">
        {view === "workspace" && project && (
          <>
            {actions.length > 0 && (
              <div className="header-popover-anchor">
                <button type="button" className="header-button" aria-expanded={menu === "action"} onClick={() => setMenu(menu === "action" ? null : "action")}>
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
                <button type="button" className="header-button" aria-expanded={menu === "branch"} onClick={() => { const next = menu === "branch" ? null : "branch"; setMenu(next); if (next) onRefreshBranches(); }}>
                  <GitBranch size={14} /><span>{gitStatus.branch ?? "Detached"}</span><ChevronDown size={12} />
                </button>
                {menu === "branch" && (
                  <div className="header-popover branch-popover" role="menu" aria-label="Branches">
                    <div className="header-popover-title">Branches</div>
                    {branches.filter((branch) => !branch.remote).map((branch) => (
                      <button type="button" role="menuitemradio" aria-checked={branch.current} key={branch.name} onClick={() => { setMenu(null); if (!branch.current) onSwitchBranch(branch.name); }}><span>{branch.name}</span>{branch.current && <span className="branch-current">Current</span>}</button>
                    ))}
                    <form className="new-branch-form" onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget).get("branch"); if (typeof input === "string" && input.trim()) { onCreateBranch(input.trim()); setMenu(null); } }}>
                      <input name="branch" placeholder="new-branch" aria-label="New branch name" maxLength={255} />
                      <button type="submit">Create</button>
                    </form>
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
          <IconButton label={activeTool ? "Close workspace tools" : "Open workspace tools"} aria-pressed={Boolean(activeTool)} onClick={onToggleTools} disabled={!project}>
            {activeTool ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </IconButton>
        ) : (
          <IconButton label="Settings" aria-current="page" onClick={onOpenSettings}><Settings size={17} /></IconButton>
        )}
      </div>
    </header>
  );
}
