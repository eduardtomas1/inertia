import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Activity,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  Layers3,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import clsx from "clsx";
import type { AppSnapshot, Conversation, Project, ProjectGroupingMode } from "@shared/contracts";
import { formatRelativeTime } from "../lib/format";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  buildLogicalProjectGroups,
  nextSidebarNavigationIndex,
  sidebarThreadView,
  sortActivityThreads,
  type SidebarThreadStatus,
} from "../utils/sidebarModel";
import { IconButton, LoadingMark } from "./ui";

const ACTIVITY_HISTORY_PAGE = 10;

type SidebarProps = {
  snapshot: AppSnapshot | null;
  connectionStatus: ConnectionStatus;
  view: "workspace" | "settings";
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onViewChange: (view: "workspace" | "settings") => void;
  onImportProject: () => void;
  onSelectProject: (project: Project) => void;
  onSelectConversation: (conversation: Conversation) => void;
  onCreateConversation: (project: Project) => void;
  onRenameConversation: (conversation: Conversation, title: string) => void;
  onArchiveConversation: (conversation: Conversation) => void;
  onSettleConversation: (conversation: Conversation) => void;
  onRestoreConversation: (conversation: Conversation) => void;
  onDeleteConversation: (conversation: Conversation) => void;
  onOpenProject: (project: Project) => void;
  onRenameProject: (project: Project, name: string) => void;
  onSetProjectGrouping: (project: Project, groupingMode: ProjectGroupingMode | null) => void;
  onSidebarModeChange: (mode: AppSnapshot["settings"]["sidebarMode"]) => void;
  onRemoveProject: (project: Project) => void;
};

const statusLabels: Record<SidebarThreadStatus, string> = {
  working: "Working",
  approval: "Approval",
  input: "Input",
  failed: "Failed",
  completed: "Completed",
  idle: "Idle",
};

function StatusIcon({ status }: { status: SidebarThreadStatus }): React.JSX.Element {
  if (status === "failed") return <CircleAlert size={12} />;
  if (status === "completed") return <CheckCircle2 size={12} />;
  return <CircleDot size={12} />;
}

function groupingLabel(mode: ProjectGroupingMode): string {
  if (mode === "repository") return "Repository";
  if (mode === "repository-path") return "Repository + folder";
  return "Keep separate";
}

export function Sidebar({
  snapshot,
  connectionStatus,
  view,
  open,
  busy,
  onClose,
  onViewChange,
  onImportProject,
  onSelectProject,
  onSelectConversation,
  onCreateConversation,
  onRenameConversation,
  onArchiveConversation,
  onSettleConversation,
  onRestoreConversation,
  onDeleteConversation,
  onOpenProject,
  onRenameProject,
  onSetProjectGrouping,
  onSidebarModeChange,
  onRemoveProject,
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [conversationMenu, setConversationMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; anchor: string } | null>(null);
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");
  const [historyVisible, setHistoryVisible] = useState(ACTIVITY_HISTORY_PAGE);
  const navigationRef = useRef<HTMLDivElement>(null);
  const mobile = useMediaQuery("(max-width: 760px)");
  const compact = snapshot?.settings.compactSidebar ?? false;
  const sidebarMode = snapshot?.settings.sidebarMode ?? "classic";
  const globalGrouping = snapshot?.settings.projectGrouping ?? "separate";

  useEffect(() => {
    if (!snapshot?.activeProjectId) return;
    setExpanded((current) => {
      if (current.has(snapshot.activeProjectId as string)) return current;
      const next = new Set(current);
      next.add(snapshot.activeProjectId as string);
      return next;
    });
  }, [snapshot?.activeProjectId]);

  useEffect(() => setHistoryVisible(ACTIVITY_HISTORY_PAGE), [query, sidebarMode]);

  const visibleProjects = useMemo(() => {
    const projects = snapshot?.projects ?? [];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return projects;
    return projects.filter((project) => {
      const conversations = snapshot?.conversations.filter((item) => item.projectId === project.id) ?? [];
      return project.name.toLocaleLowerCase().includes(needle)
        || project.path.toLocaleLowerCase().includes(needle)
        || conversations.some((conversation) => conversation.title.toLocaleLowerCase().includes(needle));
    });
  }, [query, snapshot]);

  const logicalGroups = useMemo(
    () => buildLogicalProjectGroups(visibleProjects, globalGrouping),
    [globalGrouping, visibleProjects],
  );
  const projectById = useMemo(
    () => new Map((snapshot?.projects ?? []).map((project) => [project.id, project])),
    [snapshot?.projects],
  );
  const activityThreads = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const visibleProjectIds = new Set(visibleProjects.map(({ id }) => id));
    return sortActivityThreads(
      (snapshot?.conversations ?? []).filter((conversation) => (
        visibleProjectIds.has(conversation.projectId)
        && (!needle
          || conversation.title.toLocaleLowerCase().includes(needle)
          || projectById.get(conversation.projectId)?.name.toLocaleLowerCase().includes(needle))
      )),
      snapshot?.activeConversationId ?? null,
    );
  }, [projectById, query, snapshot?.activeConversationId, snapshot?.conversations, visibleProjects]);
  const activeThreads = activityThreads.filter(({ settled }) => !settled);
  const settledThreads = activityThreads.filter(({ settled }) => settled);
  const visibleHistory = settledThreads.slice(0, historyVisible);
  const activeRenameProject = renamingProject ? projectById.get(renamingProject) : undefined;

  const toggleExpanded = (projectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const navigate = (nextView: "workspace" | "settings") => {
    onViewChange(nextView);
    onClose();
  };

  const activateConversation = (conversation: Conversation) => {
    onSelectConversation(conversation);
    onViewChange("workspace");
    onClose();
  };

  const handleNavigationKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(navigationRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-nav]") ?? [])]
      .filter((item) => !item.hasAttribute("disabled"));
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextSidebarNavigationIndex(
      currentIndex,
      event.key as "ArrowDown" | "ArrowUp" | "Home" | "End",
      items.length,
    );
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  const startProjectRename = (project: Project) => {
    setProjectMenu(null);
    setProjectRenameDraft(project.name);
    setRenamingProject(project.id);
  };

  const projectActions = (project: Project) => (
    <div className="project-menu" role="menu" aria-label={`Project actions for ${project.name}`}>
      <button type="button" role="menuitem" onClick={() => { setProjectMenu(null); onOpenProject(project); }}><FolderOpen size={13} />Open folder</button>
      <button type="button" role="menuitem" onClick={() => { setProjectMenu(null); onCreateConversation(project); }}><Plus size={13} />New thread</button>
      <button type="button" role="menuitem" onClick={() => startProjectRename(project)}><Pencil size={13} />Rename</button>
      <span className="project-menu-heading"><Layers3 size={12} />Grouping behavior</span>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={project.groupingMode === null}
        onClick={() => { setProjectMenu(null); onSetProjectGrouping(project, null); }}
      >
        <span className="menu-check">{project.groupingMode === null ? "✓" : ""}</span>
        Use global ({groupingLabel(globalGrouping)})
      </button>
      {(["repository", "repository-path", "separate"] as const).map((mode) => (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={project.groupingMode === mode}
          onClick={() => { setProjectMenu(null); onSetProjectGrouping(project, mode); }}
          key={mode}
        >
          <span className="menu-check">{project.groupingMode === mode ? "✓" : ""}</span>
          {groupingLabel(mode)}
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        className="is-danger"
        disabled={snapshot?.runs.some((run) => run.projectId === project.id && run.finishedAt === null)}
        onClick={() => { setProjectMenu(null); onRemoveProject(project); }}
      >
        <Trash2 size={13} />Remove project
      </button>
    </div>
  );

  const conversationActions = (conversation: Conversation) => {
    const settled = conversation.settledAt !== null;
    const hasActiveWork = snapshot?.runs.some((run) => run.conversationId === conversation.id && run.finishedAt === null) ?? false;
    const canSettle = !hasActiveWork && conversation.status !== "running" && conversation.status !== "needs-input";
    return (
      <div className="conversation-menu" role="menu">
        <button type="button" role="menuitem" onClick={() => { setRenameDraft(conversation.title); setRenaming(conversation.id); setConversationMenu(null); }}><Pencil size={13} />Rename</button>
        {settled
          ? <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onRestoreConversation(conversation); }}><ArchiveRestore size={13} />Restore to activity</button>
          : canSettle && <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onSettleConversation(conversation); }}><CheckCircle2 size={13} />Settle</button>}
        <button type="button" role="menuitem" disabled={hasActiveWork} onClick={() => { setConversationMenu(null); onArchiveConversation(conversation); }}><Archive size={13} />Archive</button>
        <button type="button" role="menuitem" className="is-danger" disabled={hasActiveWork} onClick={() => { setConversationMenu(null); onDeleteConversation(conversation); }}><Trash2 size={13} />Delete</button>
      </div>
    );
  };

  const renameForm = (conversation: Conversation) => (
    <form
      className="conversation-rename"
      onSubmit={(event) => {
        event.preventDefault();
        if (renameDraft.trim()) onRenameConversation(conversation, renameDraft.trim());
        setRenaming(null);
      }}
    >
      <input
        value={renameDraft}
        maxLength={120}
        autoFocus
        aria-label={`Rename ${conversation.title}`}
        onChange={(event) => setRenameDraft(event.target.value)}
        onBlur={() => setRenaming(null)}
        onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }}
      />
    </form>
  );

  const activityRow = (conversation: Conversation, variant: "card" | "history") => {
    const model = sidebarThreadView(conversation, snapshot?.activeConversationId ?? null);
    const project = projectById.get(conversation.projectId);
    const provider = snapshot?.providers.find(({ id }) => id === conversation.providerId);
    const isActive = snapshot?.activeConversationId === conversation.id && view === "workspace";
    const projectMenuAnchor = `activity:${conversation.id}`;
    const projectMenuOpen = projectMenu?.anchor === projectMenuAnchor && conversationMenu === null;
    return (
      <div
        className={clsx(
          "activity-thread",
          `is-${variant}`,
          `status-${model.status}`,
          isActive && "is-active",
          model.unread && "is-unread",
        )}
        key={conversation.id}
      >
        {renaming === conversation.id ? renameForm(conversation) : (
          <button
            type="button"
            className="activity-thread-select"
            data-sidebar-nav
            aria-label={`${conversation.title}, ${statusLabels[model.status]}`}
            onClick={() => activateConversation(conversation)}
          >
            <span className="activity-thread-topline">
              <span className="activity-thread-title">{conversation.title}</span>
              <time dateTime={conversation.updatedAt}>{formatRelativeTime(conversation.updatedAt)}</time>
            </span>
            {variant === "card" && (
              <>
                <span className={clsx("thread-status-label", `is-${model.status}`)}>
                  <StatusIcon status={model.status} />
                  {statusLabels[model.status]}
                  {model.unread && <span className="thread-unread-mark">Unread</span>}
                </span>
                <span className="activity-thread-context">
                  <span><Folder size={12} />{project?.name ?? "Unknown project"}</span>
                  {(conversation.branch || conversation.worktreePath) && (
                    <span><GitBranch size={12} />{conversation.branch ?? "Worktree"}{conversation.worktreePath ? " · isolated" : ""}</span>
                  )}
                </span>
                <span
                  className="activity-thread-provider"
                  title={`${provider?.label ?? conversation.providerId}${conversation.model ? ` · ${conversation.model}` : ""}`}
                >
                  {provider?.label ?? conversation.providerId}{conversation.model ? ` · ${conversation.model}` : ""}
                </span>
              </>
            )}
            {variant === "history" && (
              <span className="activity-history-context">{project?.name ?? "Unknown project"} · {statusLabels[model.status]}</span>
            )}
          </button>
        )}
        {project && variant === "card" && (
          <IconButton
            label={`Project actions for ${project.name}`}
            className="activity-project-menu-button"
            onClick={() => {
              setConversationMenu(null);
              setProjectMenu(projectMenuOpen ? null : { projectId: project.id, anchor: projectMenuAnchor });
            }}
          >
            <Folder size={12} />
          </IconButton>
        )}
        <IconButton
          label={`Thread actions for ${conversation.title}`}
          className="activity-thread-menu-button"
          onClick={() => {
            setProjectMenu(null);
            setConversationMenu(conversationMenu === conversation.id ? null : conversation.id);
          }}
        >
          <MoreHorizontal size={13} />
        </IconButton>
        {conversationMenu === conversation.id && conversationActions(conversation)}
        {project && projectMenuOpen && projectActions(project)}
      </div>
    );
  };

  return (
    <>
      <button type="button" aria-label="Close navigation" className={clsx("sidebar-scrim", open && "is-open")} onClick={onClose} />
      <aside
        className={clsx("sidebar", open && "is-open", compact && "is-compact", `sidebar-mode-${sidebarMode}`)}
        aria-label="Project navigation"
        aria-hidden={mobile && !open ? true : undefined}
        inert={mobile && !open ? true : undefined}
      >
        <div className="sidebar-brand drag-region">
          <button type="button" className="brand-lockup no-drag" aria-label="Go to workspace" onClick={() => navigate("workspace")}>
            <img src="./inertia-logo.png" alt="" className="brand-logo" />
            <span className="brand-name">Inertia</span>
          </button>
          <IconButton label="Close navigation" className="mobile-close no-drag" onClick={onClose}><X size={17} /></IconButton>
        </div>

        <button
          type="button"
          className="new-thread-button"
          disabled={!snapshot?.activeProjectId || connectionStatus !== "online"}
          onClick={() => {
            const activeProject = snapshot?.projects.find((project) => project.id === snapshot.activeProjectId);
            if (activeProject) onCreateConversation(activeProject);
          }}
        >
          <SquarePen size={16} /><span>New thread</span>
        </button>

        <button type="button" className={clsx("sidebar-destination", view === "workspace" && "is-active")} aria-current={view === "workspace" ? "page" : undefined} onClick={() => navigate("workspace")}>
          <MessageSquare size={16} /><span>Workspace</span>
        </button>

        <div className="sidebar-mode-switch" role="group" aria-label="Sidebar mode">
          <button type="button" aria-pressed={sidebarMode === "classic"} disabled={connectionStatus !== "online"} onClick={() => onSidebarModeChange("classic")}><ListTree size={13} />Classic</button>
          <button type="button" aria-pressed={sidebarMode === "activity"} disabled={connectionStatus !== "online"} onClick={() => onSidebarModeChange("activity")}><Activity size={13} />Activity</button>
        </div>

        <div className="sidebar-search-wrap">
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search projects and conversations" placeholder={sidebarMode === "activity" ? "Search activity" : "Search projects"} type="search" />
          {query && <IconButton label="Clear search" className="search-clear" onClick={() => setQuery("")}><X size={13} /></IconButton>}
        </div>

        {activeRenameProject && (
          <form
            className="sidebar-project-rename"
            onSubmit={(event) => {
              event.preventDefault();
              if (projectRenameDraft.trim()) onRenameProject(activeRenameProject, projectRenameDraft.trim());
              setRenamingProject(null);
            }}
          >
            <label htmlFor="sidebar-project-rename">Rename project</label>
            <span>
              <input id="sidebar-project-rename" value={projectRenameDraft} autoFocus maxLength={80} onChange={(event) => setProjectRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenamingProject(null); }} />
              <button type="submit">Save</button>
            </span>
          </form>
        )}

        <div className="sidebar-section-title">
          <span>{sidebarMode === "activity" ? "Activity" : "Projects"}</span>
          <IconButton label="Add project" disabled={busy || connectionStatus !== "online"} onClick={onImportProject}>
            {busy ? <LoadingMark label="Adding project" /> : <FolderPlus size={15} />}
          </IconButton>
        </div>

        <div className="project-list" ref={navigationRef} onKeyDown={handleNavigationKeyDown} role="list" aria-label={sidebarMode === "activity" ? "Thread activity" : "Projects"}>
          {!snapshot && <div className="sidebar-loading"><LoadingMark label="Loading projects" /><span>Opening your workspace…</span></div>}
          {snapshot && visibleProjects.length === 0 && <div className="sidebar-empty"><Folder size={19} /><span>{query ? "No matching work" : "No projects yet"}</span></div>}

          {sidebarMode === "classic" && logicalGroups.map((group) => (
            <section className="logical-project-group" aria-label={group.label} key={group.key}>
              {group.projects.length > 1 && <h2><Layers3 size={12} />{group.label}<span>{group.projects.length} folders</span></h2>}
              {group.projects.map((project) => {
                const isExpanded = expanded.has(project.id) || Boolean(query);
                const isActive = snapshot?.activeProjectId === project.id;
                const conversations = snapshot?.conversations
                  .filter((conversation) => conversation.projectId === project.id && conversation.archivedAt === null)
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? [];
                return (
                  <div className="project-group" role="listitem" key={project.id}>
                    <div className={clsx("project-row", isActive && view === "workspace" && "is-active")}>
                      <IconButton label={`${isExpanded ? "Collapse" : "Expand"} ${project.name}`} className="project-expand" onClick={() => toggleExpanded(project.id)}>
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </IconButton>
                      <button
                        type="button"
                        className="project-select"
                        data-sidebar-nav
                        onClick={() => { onSelectProject(project); onViewChange("workspace"); onClose(); }}
                      >
                        <Folder className="project-icon" size={15} />
                        <span className="project-copy">
                          <span className="project-name">{project.name}</span>
                          {group.projects.length > 1 && <span className="project-scope">{project.repositoryRelativePath === "." ? "Repository root" : project.repositoryRelativePath}</span>}
                        </span>
                        <span className={clsx("project-status", `status-${project.status}`)} title={project.status} />
                      </button>
                      <IconButton
                        label={`Project actions for ${project.name}`}
                        className="project-menu-button"
                        onClick={() => {
                          const anchor = `classic:${project.id}`;
                          setProjectMenu(projectMenu?.anchor === anchor ? null : { projectId: project.id, anchor });
                        }}
                      >
                        <MoreHorizontal size={14} />
                      </IconButton>
                      {projectMenu?.anchor === `classic:${project.id}` && projectActions(project)}
                    </div>

                    {isExpanded && (
                      <div className="conversation-list" aria-label={`${project.name} threads`}>
                        {conversations.map((conversation) => {
                          const thread = sidebarThreadView(conversation, snapshot?.activeConversationId ?? null);
                          return (
                            <div className={clsx("conversation-item", thread.unread && "is-unread")} key={conversation.id}>
                              {renaming === conversation.id ? renameForm(conversation) : (
                                <button
                                  type="button"
                                  className={clsx("conversation-row", snapshot?.activeConversationId === conversation.id && view === "workspace" && "is-active")}
                                  data-sidebar-nav
                                  onClick={() => activateConversation(conversation)}
                                >
                                  <span className={clsx("thread-status-dot", `is-${thread.status}`)} title={statusLabels[thread.status]} />
                                  <span className="conversation-title">{conversation.title}</span>
                                  {thread.unread && <span className="conversation-unread" aria-label="Unread completed work" />}
                                  {!compact && <span className="conversation-time">{formatRelativeTime(conversation.updatedAt)}</span>}
                                </button>
                              )}
                              <IconButton label={`Thread actions for ${conversation.title}`} className="conversation-menu-button" onClick={() => setConversationMenu(conversationMenu === conversation.id ? null : conversation.id)}><MoreHorizontal size={13} /></IconButton>
                              {conversationMenu === conversation.id && conversationActions(conversation)}
                            </div>
                          );
                        })}
                        <button type="button" className="new-conversation-row" data-sidebar-nav onClick={() => onCreateConversation(project)} disabled={connectionStatus !== "online"}>
                          <Plus size={13} /><span>New thread</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}

          {sidebarMode === "activity" && snapshot && (
            <div className="activity-thread-stream">
              {activeThreads.length === 0 && settledThreads.length === 0 && <div className="sidebar-empty"><Activity size={19} /><span>No thread activity yet</span></div>}
              {activeThreads.map(({ conversation }) => activityRow(conversation, "card"))}
              {settledThreads.length > 0 && (
                <>
                  <div className="activity-history-heading"><History size={12} /><span>Settled history</span><span>{settledThreads.length}</span></div>
                  {visibleHistory.map(({ conversation }) => activityRow(conversation, "history"))}
                  {visibleHistory.length < settledThreads.length && (
                    <button type="button" className="activity-show-more" onClick={() => setHistoryVisible((count) => count + ACTIVITY_HISTORY_PAGE)}>
                      Show more <span>{settledThreads.length - visibleHistory.length} older</span>
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <button type="button" className={clsx("sidebar-destination", view === "settings" && "is-active")} aria-current={view === "settings" ? "page" : undefined} onClick={() => navigate("settings")}>
            <Settings size={16} /><span>Settings</span>
          </button>
        </div>
      </aside>
    </>
  );
}
