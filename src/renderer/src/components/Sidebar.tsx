import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Activity,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CircleX,
  Columns2,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  Layers3,
  ListTree,
  MessageCircleQuestion,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Pencil,
  Pin,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import clsx from "clsx";
import type { AppSnapshot, Conversation, Project, ProjectGroupingMode, WorkspaceRun } from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";
import { formatRelativeTime } from "../lib/format";
import { agentRequestProviderName } from "../utils/agentInput";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { useSnoozeClock } from "../hooks/useSnoozeClock";
import {
  buildLogicalProjectGroups,
  classicSidebarSearch,
  groupWorkThreads,
  nextSidebarNavigationIndex,
  sidebarThreadView,
  sidebarThreadViewMap,
  sortSidebarThreadViews,
  type SidebarThreadStatus,
  type SidebarWorkSectionId,
} from "../utils/sidebarModel";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { IconButton, LoadingMark } from "./ui";
import { loadMultiSpawnDialog, loadSettingsView } from "./lazySurfaceLoaders";

const WORK_DONE_PAGE_SIZE = 10;
const EMPTY_CONVERSATIONS: readonly Conversation[] = [];
const COLLAPSIBLE_WORK_SECTIONS: ReadonlySet<SidebarWorkSectionId> = new Set([
  "earlier",
  "done",
  "snoozed",
]);

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
  splitConversationId: string | null;
  onOpenConversationInSplit: (conversation: Conversation) => void;
  onCloseConversationSplit: () => void;
  onCreateConversation: (project: Project) => void;
  onOpenMultiSpawn: () => void;
  onRenameConversation: (conversation: Conversation, title: string) => void;
  onPinConversation: (conversation: Conversation, pinned: boolean) => void;
  onSnoozeConversation: (conversation: Conversation, until: string | null) => void;
  onArchiveConversation: (conversation: Conversation) => void;
  onSettleConversation: (conversation: Conversation) => void;
  onRestoreConversation: (conversation: Conversation) => void;
  onDeleteConversation: (conversation: Conversation) => void;
  onAcknowledgeRun: (run: WorkspaceRun) => void;
  onDismissRun: (run: WorkspaceRun) => void;
  onOpenProject: (project: Project) => void;
  onRenameProject: (project: Project, name: string) => void;
  onSetProjectGrouping: (project: Project, groupingMode: ProjectGroupingMode | null) => void;
  onSetProjectGitRepositoryLimit: (project: Project, limit: number) => void;
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

const workStatusIcons: Record<SidebarThreadStatus, typeof CircleDot> = {
  working: CircleDot,
  approval: ShieldAlert,
  input: MessageCircleQuestion,
  failed: CircleX,
  completed: CheckCircle2,
  idle: Minus,
};

function workProjectLabel(project: Project | undefined): string {
  return project?.name ?? "Unknown project";
}

function groupingLabel(mode: ProjectGroupingMode): string {
  if (mode === "repository") return "Repository";
  if (mode === "repository-path") return "Repository + folder";
  return "Keep separate";
}

function workRepositoryLabel(project: Project | undefined): string | null {
  const repositoryName = project?.repositoryRoot
    ?.split(/[\\/]/u)
    .filter(Boolean)
    .at(-1);
  if (!repositoryName || !project) return null;
  if (project.repositoryRelativePath && project.repositoryRelativePath !== ".") {
    return `${repositoryName}/${project.repositoryRelativePath}`;
  }
  return repositoryName.toLocaleLowerCase() !== project.name.toLocaleLowerCase()
    ? repositoryName
    : null;
}

function SidebarView({
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
  splitConversationId,
  onOpenConversationInSplit,
  onCloseConversationSplit,
  onCreateConversation,
  onOpenMultiSpawn,
  onRenameConversation,
  onPinConversation,
  onSnoozeConversation,
  onArchiveConversation,
  onSettleConversation,
  onRestoreConversation,
  onDeleteConversation,
  onAcknowledgeRun,
  onDismissRun,
  onOpenProject,
  onRenameProject,
  onSetProjectGrouping,
  onSetProjectGitRepositoryLimit,
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
  const [doneVisible, setDoneVisible] = useState(WORK_DONE_PAGE_SIZE);
  const [expandedWorkSections, setExpandedWorkSections] = useState<Set<SidebarWorkSectionId>>(
    new Set(),
  );
  const conversations = snapshot?.conversations ?? EMPTY_CONVERSATIONS;
  const snoozeNow = useSnoozeClock(conversations);
  const sidebarRef = useRef<HTMLElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const mobile = useMediaQuery("(max-width: 760px)");
  useNativePreviewSuspension(Boolean(
    conversationMenu
      || projectMenu
      || (mobile && open),
  ));
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

  useEffect(() => setDoneVisible(WORK_DONE_PAGE_SIZE), [query, sidebarMode]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!mobile || !open) return;
    const sidebar = sidebarRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => (
      sidebar?.querySelector<HTMLElement>('[aria-label="Close navigation"]')?.focus({ preventScroll: true })
    ));
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !sidebar) return;
      const focusable = [...sidebar.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [mobile, open]);

  const classicSearch = useMemo(
    () => classicSidebarSearch(
      snapshot?.projects ?? [],
      conversations,
      query,
      snoozeNow,
    ),
    [conversations, query, snapshot?.projects, snoozeNow],
  );
  const visibleProjects = classicSearch.projects;

  const logicalGroups = useMemo(
    () => buildLogicalProjectGroups(visibleProjects, globalGrouping),
    [globalGrouping, visibleProjects],
  );
  const projectById = useMemo(
    () => new Map((snapshot?.projects ?? []).map((project) => [project.id, project])),
    [snapshot?.projects],
  );
  const threadViewsById = useMemo(
    () => sidebarThreadViewMap(
      snapshot?.conversations ?? [],
      snapshot?.activeConversationId ?? null,
      snapshot?.runs ?? [],
    ),
    [
      snapshot?.activeConversationId,
      snapshot?.conversations,
      snapshot?.runs,
    ],
  );
  const activityThreads = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sortSidebarThreadViews(
      conversations
        .filter((conversation) => {
          if (!needle) return true;
          const project = projectById.get(conversation.projectId);
          const providerLabel = snapshot?.settings.providerIdentityLabels[conversation.providerId]
            ?? agentRequestProviderName(conversation.providerId);
          const projectLabel = workProjectLabel(project);
          const repositoryLabel = workRepositoryLabel(project);
          return [
            conversation.title,
            conversation.branch,
            providerLabel,
            projectLabel,
            repositoryLabel,
            project?.path,
            project?.repositoryRoot,
            project?.repositoryRelativePath,
          ].some((value) => value?.toLocaleLowerCase().includes(needle));
        })
        .map((conversation) => threadViewsById.get(conversation.id)!),
    );
  }, [
    projectById,
    query,
    conversations,
    snapshot?.settings.providerIdentityLabels,
    threadViewsById,
  ]);
  const workSections = useMemo(
    () => groupWorkThreads(activityThreads, snoozeNow),
    [activityThreads, snoozeNow],
  );
  const visibleWorkCount = workSections.reduce(
    (count, section) => count + section.threads.length,
    0,
  );
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
      <span className="project-menu-heading"><FolderOpen size={12} />Repository display limit</span>
      {([64, 128, 256, 512, 1024] as const).map((limit) => (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={project.gitRepositoryLimit === limit}
          onClick={() => {
            setProjectMenu(null);
            onSetProjectGitRepositoryLimit(project, limit);
          }}
          key={limit}
        >
          <span className="menu-check">
            {project.gitRepositoryLimit === limit ? "✓" : ""}
          </span>
          Show up to {limit} repositories
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        className="is-danger"
        disabled={snapshot?.runs.some((run) => (
          run.projectId === project.id && (run.status === "running" || run.status === "waiting")
        ))}
        onClick={() => { setProjectMenu(null); onRemoveProject(project); }}
      >
        <Trash2 size={13} />Remove project
      </button>
    </div>
  );

  const conversationActions = (conversation: Conversation) => {
    const settled = conversation.settledAt !== null;
    const hasActiveWork = snapshot?.runs.some((run) => (
      run.conversationId === conversation.id && (run.status === "running" || run.status === "waiting")
    )) ?? false;
    const canSettle = !hasActiveWork && conversation.status !== "running" && conversation.status !== "needs-input";
    const thread = threadViewsById.get(conversation.id)
      ?? sidebarThreadView(conversation, snapshot?.activeConversationId ?? null);
    const runAttention = thread.run ? workspaceRunAttentionView(thread.run) : null;
    const isSplitConversation = splitConversationId === conversation.id;
    const canOpenInSplit = Boolean(
      snapshot?.activeConversationId
      && snapshot.activeConversationId !== conversation.id
    );
    return (
      <div className="conversation-menu" role="menu">
        <button type="button" role="menuitem" onClick={() => { setRenameDraft(conversation.title); setRenaming(conversation.id); setConversationMenu(null); }}><Pencil size={13} />Rename</button>
        <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onPinConversation(conversation, !conversation.pinnedAt); }}>
          <MessageSquare size={13} />{conversation.pinnedAt ? "Unpin" : "Pin"}
        </button>
        {conversation.snoozedUntil && Date.parse(conversation.snoozedUntil) > Date.now() ? (
          <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onSnoozeConversation(conversation, null); }}>
            <History size={13} />Unsnooze
          </button>
        ) : (
          <>
            <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onSnoozeConversation(conversation, new Date(Date.now() + 60 * 60 * 1_000).toISOString()); }}>
              <History size={13} />Snooze for 1 hour
            </button>
            <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onSnoozeConversation(conversation, new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString()); }}>
              <History size={13} />Snooze for 1 day
            </button>
          </>
        )}
        {isSplitConversation ? (
          <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onCloseConversationSplit(); }}>
            <Columns2 size={13} />Remove from split view
          </button>
        ) : (
          <button
            type="button"
            role="menuitem"
            disabled={!canOpenInSplit}
            title={canOpenInSplit
              ? undefined
              : "Choose another chat first."}
            onClick={() => {
              setConversationMenu(null);
              onOpenConversationInSplit(conversation);
            }}
          >
            <Columns2 size={13} />Add this chat to split view
          </button>
        )}
        {thread.run && thread.needsAttention && runAttention?.canAcknowledge && (
          <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onAcknowledgeRun(thread.run!); }}>
            <CheckCircle2 size={13} />Acknowledge
          </button>
        )}
        {sidebarMode === "activity" && thread.run && runAttention?.canDismiss && (
          <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onDismissRun(thread.run!); }}>
            <X size={13} />Dismiss from Work
          </button>
        )}
        {settled
          ? <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onRestoreConversation(conversation); }}><ArchiveRestore size={13} />Reopen</button>
          : canSettle && <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onSettleConversation(conversation); }}><CheckCircle2 size={13} />Done</button>}
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

  const activityRow = (conversation: Conversation) => {
    const model = threadViewsById.get(conversation.id)
      ?? sidebarThreadView(conversation, snapshot?.activeConversationId ?? null);
    const project = projectById.get(conversation.projectId);
    const isActive = snapshot?.activeConversationId === conversation.id && view === "workspace";
    const providerLabel = snapshot?.settings.providerIdentityLabels[conversation.providerId]
      ?? agentRequestProviderName(conversation.providerId);
    const projectLabel = workProjectLabel(project);
    const repositoryLabel = workRepositoryLabel(project);
    const WorkStatusIcon = workStatusIcons[model.status];
    const accessibleContext = [
      conversation.title,
      providerLabel,
      projectLabel,
      repositoryLabel ? `Repository ${repositoryLabel}` : null,
      conversation.branch ? `Branch ${conversation.branch}` : null,
      statusLabels[model.status],
      conversation.snoozedUntil && Date.parse(conversation.snoozedUntil) > snoozeNow
        ? "Snoozed"
        : null,
      conversation.pinnedAt ? "Pinned" : null,
      model.unread ? "New completion" : null,
    ].filter((value): value is string => Boolean(value)).join(", ");
    return (
      <div
        className={clsx(
          "activity-thread",
          `status-${model.status}`,
          isActive && "is-active",
          splitConversationId === conversation.id && "is-split",
          model.unread && "is-unread",
        )}
        key={conversation.id}
      >
        {renaming === conversation.id ? renameForm(conversation) : (
          <button
            type="button"
            className="activity-thread-select"
            data-sidebar-nav
            aria-current={isActive ? "page" : undefined}
            aria-label={accessibleContext}
            onClick={() => activateConversation(conversation)}
          >
            <span
              className="activity-thread-provider"
              title={`${providerLabel} provider`}
              aria-hidden="true"
            >
              <ProviderBrandIcon
                providerId={conversation.providerId}
                size={15}
                decorative
              />
              <span
                className="activity-thread-state-mark"
                data-work-status={model.status}
                aria-hidden="true"
              >
                <WorkStatusIcon size={8} />
              </span>
            </span>
            <span className="activity-thread-copy">
              <span className="activity-thread-topline">
                <span className="activity-thread-title">{conversation.title}</span>
                {conversation.pinnedAt && <Pin className="conversation-pin" size={10} aria-label="Pinned thread" />}
                {model.unread && <span className="thread-unread-mark">New</span>}
                <time dateTime={conversation.updatedAt}>{formatRelativeTime(conversation.updatedAt)}</time>
              </span>
              <span className="work-thread-meta">
                <span className="activity-thread-provider-label">{providerLabel}</span>
                <span className="activity-thread-project-meta" title={project?.path}>
                  <Folder size={10} aria-hidden="true" />
                  {projectLabel}
                </span>
                {repositoryLabel && (
                  <span className="activity-thread-repository-meta" title={project?.repositoryRoot ?? undefined}>
                    {repositoryLabel}
                  </span>
                )}
                {conversation.branch && (
                  <span className="activity-thread-branch-meta" title={`Branch ${conversation.branch}`}>
                    <GitBranch size={10} aria-hidden="true" />
                    {conversation.branch}
                  </span>
                )}
              </span>
            </span>
          </button>
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
      </div>
    );
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close navigation"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        className={clsx("sidebar-scrim", open && "is-open")}
        onClick={onClose}
      />
      <aside
        ref={sidebarRef}
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

        {snapshot && snapshot.projects.length > 0 && (
          <div className="new-chat-actions">
            <button
              type="button"
              className="new-chat-button"
              disabled={connectionStatus !== "online"}
              onClick={() => {
                const targetProject = snapshot.projects.find((project) => project.id === snapshot.activeProjectId)
                  ?? snapshot.projects[0];
                if (targetProject) onCreateConversation(targetProject);
              }}
            >
              <SquarePen size={16} /><span>New chat</span>
            </button>
            <IconButton
              label="Launch two chats"
              className="multi-spawn-button"
              disabled={connectionStatus !== "online"}
              onFocus={() => void loadMultiSpawnDialog()}
              onPointerDown={() => void loadMultiSpawnDialog()}
              onPointerEnter={() => void loadMultiSpawnDialog()}
              onClick={onOpenMultiSpawn}
            >
              <Zap size={15} fill="currentColor" />
            </IconButton>
          </div>
        )}

        <button type="button" className={clsx("sidebar-destination", view === "workspace" && "is-active")} aria-current={view === "workspace" ? "page" : undefined} onClick={() => navigate("workspace")}>
          <MessageSquare size={16} /><span>Workspace</span>
        </button>

        <div className="sidebar-mode-switch" role="group" aria-label="Sidebar mode">
          <button type="button" aria-pressed={sidebarMode === "classic"} disabled={connectionStatus !== "online"} onClick={() => onSidebarModeChange("classic")}><ListTree size={13} />Projects</button>
          <button type="button" aria-pressed={sidebarMode === "activity"} disabled={connectionStatus !== "online"} onClick={() => onSidebarModeChange("activity")}><Activity size={13} />Work</button>
        </div>

        <div className="sidebar-search-wrap">
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search projects and conversations" placeholder={sidebarMode === "activity" ? "Search work" : "Search projects"} type="search" />
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

        {sidebarMode === "classic" && (
          <div className="sidebar-section-title">
            <span>Projects</span>
            <IconButton label="Add project" disabled={busy || connectionStatus !== "online"} onClick={onImportProject}>
              {busy ? <LoadingMark label="Adding project" /> : <FolderPlus size={15} />}
            </IconButton>
          </div>
        )}

        <div className="project-list" ref={navigationRef} onKeyDown={handleNavigationKeyDown} role="list" aria-label={sidebarMode === "activity" ? "Work" : "Projects"}>
          {!snapshot && <div className="sidebar-loading"><LoadingMark label="Loading projects" /><span>Opening your workspace…</span></div>}
          {snapshot && sidebarMode === "classic" && visibleProjects.length === 0 && (
            <div className="sidebar-empty"><Folder size={19} /><span>{query ? "No matching projects" : "No projects yet"}</span></div>
          )}

          {sidebarMode === "classic" && logicalGroups.map((group) => (
            <section className="logical-project-group" aria-label={group.label} key={group.key}>
              {group.projects.length > 1 && <h2><Layers3 size={12} />{group.label}<span>{group.projects.length} folders</span></h2>}
              {group.projects.map((project) => {
                const isExpanded = expanded.has(project.id) || Boolean(query);
                const isActive = snapshot?.activeProjectId === project.id;
                const conversations =
                  classicSearch.conversationsByProject.get(project.id) ?? [];
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
                        aria-current={isActive && view === "workspace"
                          ? "page"
                          : undefined}
                        onClick={() => { onSelectProject(project); onViewChange("workspace"); onClose(); }}
                      >
                        <Folder className="project-icon" size={15} />
                        <span className="project-copy">
                          <span className="project-name">{project.name}</span>
                          {group.projects.length > 1 && <span className="project-scope">{project.repositoryRelativePath === "." ? "Repository root" : project.repositoryRelativePath}</span>}
                        </span>
                        <span
                          className={clsx("project-status", `status-${project.status}`)}
                          aria-label={`Project status: ${project.status}`}
                          title={project.status}
                        />
                      </button>
                      <span className="project-row-actions">
                        <IconButton
                          label={`New chat in ${project.name}`}
                          className="project-new-chat-button"
                          disabled={connectionStatus !== "online"}
                          onClick={(event) => {
                            event.stopPropagation();
                            setConversationMenu(null);
                            setProjectMenu(null);
                            onCreateConversation(project);
                          }}
                        >
                          <SquarePen size={13} />
                        </IconButton>
                        <IconButton
                          label={`Project actions for ${project.name}`}
                          className="project-menu-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            const anchor = `classic:${project.id}`;
                            setProjectMenu(projectMenu?.anchor === anchor ? null : { projectId: project.id, anchor });
                          }}
                        >
                          <MoreHorizontal size={14} />
                        </IconButton>
                      </span>
                      {projectMenu?.anchor === `classic:${project.id}` && projectActions(project)}
                    </div>

                    {isExpanded && (
                      <div className="conversation-list" aria-label={`${project.name} threads`}>
                        {conversations.map((conversation) => {
                          const thread = threadViewsById.get(conversation.id)
                            ?? sidebarThreadView(
                              conversation,
                              snapshot?.activeConversationId ?? null,
                            );
                          return (
                            <div className={clsx("conversation-item", thread.unread && "is-unread")} key={conversation.id}>
                              {renaming === conversation.id ? renameForm(conversation) : (
                                <button
                                  type="button"
                                  className={clsx(
                                    "conversation-row",
                                    snapshot?.activeConversationId === conversation.id
                                      && view === "workspace"
                                      && "is-active",
                                    splitConversationId === conversation.id
                                      && "is-split",
                                  )}
                                  data-sidebar-nav
                                  aria-current={snapshot?.activeConversationId === conversation.id
                                    && view === "workspace"
                                    ? "page"
                                    : undefined}
                                  onClick={() => activateConversation(conversation)}
                                >
                                  <span
                                    className={clsx("thread-status-dot", `is-${thread.status}`)}
                                    aria-label={`Chat status: ${statusLabels[thread.status]}`}
                                    title={statusLabels[thread.status]}
                                  />
                                  <span className="conversation-title">{conversation.title}</span>
                                  {conversation.pinnedAt && <Pin className="conversation-pin" size={10} aria-label="Pinned thread" />}
                                  {splitConversationId === conversation.id && (
                                    <Columns2
                                      className="conversation-split-mark"
                                      size={11}
                                      aria-label="Open in split view"
                                    />
                                  )}
                                  {thread.unread && <span className="conversation-unread" aria-label="Unread completed work" />}
                                  {!compact && <span className="conversation-time">{formatRelativeTime(conversation.updatedAt)}</span>}
                                </button>
                              )}
                              <IconButton label={`Thread actions for ${conversation.title}`} className="conversation-menu-button" onClick={() => setConversationMenu(conversationMenu === conversation.id ? null : conversation.id)}><MoreHorizontal size={13} /></IconButton>
                              {conversationMenu === conversation.id && conversationActions(conversation)}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}

          {sidebarMode === "activity" && snapshot && (
            <div className="activity-thread-stream">
              {visibleWorkCount === 0 && (
                <div className="sidebar-empty">
                  <Activity size={19} />
                  <span>{query ? "No matching work" : snapshot.projects.length === 0 ? "No projects yet" : "No work yet"}</span>
                </div>
              )}
              {workSections.map((section) => {
                if (section.threads.length === 0) return null;
                const collapsible = COLLAPSIBLE_WORK_SECTIONS.has(section.id);
                const searchActive = Boolean(query.trim());
                const disclosure = collapsible && !searchActive;
                const expanded = !collapsible || searchActive || expandedWorkSections.has(section.id);
                const visibleThreads = section.id === "done"
                  ? section.threads.slice(0, doneVisible)
                  : section.threads;
                return (
                  <section className={`work-thread-section is-${section.id}`} aria-labelledby={`work-section-${section.id}`} key={section.id}>
                    {disclosure ? (
                      <h2 id={`work-section-${section.id}`}>
                        <button
                          type="button"
                          className="work-thread-section-toggle"
                          data-sidebar-nav
                          aria-expanded={expanded}
                          onClick={() => setExpandedWorkSections((current) => {
                            const next = new Set(current);
                            if (next.has(section.id)) next.delete(section.id);
                            else next.add(section.id);
                            return next;
                          })}
                        >
                          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span>{section.label}</span>
                          <span>{section.threads.length}</span>
                        </button>
                      </h2>
                    ) : (
                      <h2 id={`work-section-${section.id}`}><span>{section.label}</span><span>{section.threads.length}</span></h2>
                    )}
                    {expanded && visibleThreads.map(({ conversation }) => activityRow(conversation))}
                    {expanded && section.id === "done" && visibleThreads.length < section.threads.length && (
                      <button type="button" className="activity-show-more" onClick={() => setDoneVisible((count) => count + WORK_DONE_PAGE_SIZE)}>
                        Show more <span>{section.threads.length - visibleThreads.length} older</span>
                      </button>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <button type="button" className={clsx("sidebar-destination", view === "settings" && "is-active")} aria-current={view === "settings" ? "page" : undefined} onFocus={() => void loadSettingsView()} onPointerDown={() => void loadSettingsView()} onPointerEnter={() => void loadSettingsView()} onClick={() => navigate("settings")}>
            <Settings size={16} /><span>Settings</span>
          </button>
        </div>
      </aside>
    </>
  );
}

export const Sidebar = memo(SidebarView);
Sidebar.displayName = "Sidebar";
