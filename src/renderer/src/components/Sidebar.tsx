import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CircleX,
  FolderOpen,
  FolderGit2,
  Download,
  GitBranch,
  Layers3,
  MessageCircleQuestion,
  Minus,
  MoreHorizontal,
  Pencil,
  Search,
  Settings,
  Share2,
  ShieldAlert,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import clsx from "clsx";
import type { Conversation, Project, ProjectGroupingMode } from "@shared/contracts";
import { formatRelativeTime, formatWorkAge } from "../lib/format";
import { agentRequestProviderName } from "../utils/agentInput";
import { focusModalOnAnimationFrame, trapModalFocus } from "../utils/modalFocus";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { useSnoozeClock } from "../hooks/useSnoozeClock";
import {
  COLLAPSIBLE_WORK_SECTIONS,
  useSidebarWorkIndex,
  type WorkIndexItem,
} from "../hooks/useSidebarWorkIndex";
import {
  groupWorkThreads,
  nextSidebarNavigationIndex,
  isSidebarNavigationKey,
  sidebarThreadView,
  sidebarThreadViewMap,
  sortSidebarThreadViews,
  type SidebarThreadStatus,
  type SidebarWorkSectionId,
} from "../utils/sidebarModel";
import { navigateMenuItems } from "../utils/menuKeyboard";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { ConversationActionsMenu } from "./ConversationActionsMenu";
import { DailyWorkMark } from "./DailyWorkMark";
import { IconButton, LoadingMark } from "./ui";
import { loadDailyWorkDialog, loadMultiSpawnDialog, loadSettingsView, loadUsageView } from "./lazySurfaceLoaders";
import type { AppView } from "../appView";
import { ProjectScopePicker } from "./sidebar/ProjectScopePicker";
import "./sidebar/workspace-navigation.css";
import type { SidebarProps } from "./sidebar/SidebarProps";
import {
  EMPTY_DETACHED_CONVERSATION_IDS,
  SidebarConversationMarks,
} from "./sidebar/SidebarConversationMarks";
const WORK_DONE_PAGE_SIZE = 10;
const WORK_SECTIONS_STORAGE_KEY = "inertia:sidebar:work-sections:v1";
const EMPTY_CONVERSATIONS: readonly Conversation[] = [];

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

function workFocusConversationId(identity: string): string | null {
  if (identity.startsWith("thread-actions:")) {
    return identity.slice("thread-actions:".length);
  }
  return identity.startsWith("thread:")
    ? identity.slice("thread:".length)
    : null;
}

function SidebarView({
  snapshot,
  connectionStatus,
  view,
  open,
  busy,
  layoutWidth,
  onClose,
  onViewChange, onOpenHome,
  onImportProject,
  onSelectConversation,
  detachedConversationIds = EMPTY_DETACHED_CONVERSATION_IDS,
  detachedChatLimitReached = false,
  splitConversationId,
  onOpenConversationInSplit,
  onOpenConversationInWindow,
  onCloseConversationSplit,
  onCreateConversation,
  onOpenMultiSpawn,
  onOpenDailyWork,
  dailyWorkOpen,
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
  onRemoveProject,
  updateAvailable = false,
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [projectScopeId, setProjectScopeId] = useState<string | null>(null);
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
  } = useDismissibleMenu<string>();
  const projectMenu = menu?.[0] === ":" ? menu.slice(1) : null;
  const conversationMenu = projectMenu ? null : menu;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");
  const [doneVisible, setDoneVisible] = useState(WORK_DONE_PAGE_SIZE);
  const [expandedWorkSections, setExpandedWorkSections] = useState<Set<SidebarWorkSectionId>>(() => {
    try {
      const stored = (window.localStorage.getItem(WORK_SECTIONS_STORAGE_KEY) ?? "")
        .split(",");
      return new Set([...COLLAPSIBLE_WORK_SECTIONS].filter((section) => (
        stored.includes(section)
      )));
    } catch { return new Set(); }
  });
  const conversations = snapshot?.conversations ?? EMPTY_CONVERSATIONS;
  const snoozeNow = useSnoozeClock(conversations);
  const sidebarRef = useRef<HTMLElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const workFocusIdentityRef = useRef<string | null>(null);
  const workFocusIndexRef = useRef<number | null>(null);
  const workFocusConversationIdsRef = useRef<readonly string[]>([]);
  const onCloseRef = useRef(onClose);
  const mobile = useMediaQuery("(max-width: 760px)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  useNativePreviewSuspension(Boolean(
    conversationMenu
      || projectMenu
      || (mobile && open),
  ));
  const compact = snapshot?.settings.compactSidebar ?? false;
  const globalGrouping = snapshot?.settings.projectGrouping ?? "separate";

  useEffect(() => setDoneVisible(WORK_DONE_PAGE_SIZE), [query]);
  useLayoutEffect(() => {
    if (!projectMenu) return;
    sidebarRef.current?.querySelector<HTMLButtonElement>(
      `[data-project-menu-id="${projectMenu}"] [role^="menuitem"]:not([disabled])`,
    )
      ?.focus({ preventScroll: true });
  }, [projectMenu]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        WORK_SECTIONS_STORAGE_KEY,
        [...expandedWorkSections].join(","),
      );
    } catch { /* Storage can be unavailable in hardened renderer sessions. */ }
  }, [expandedWorkSections]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const clearWorkFocusIfUnowned = (event: Event): void => {
      const target = event.target;
      const focusOwner = target instanceof Element
        ? target.closest("[data-work-focus-id], [data-work-focus-owner]")
        : null;
      if (focusOwner && sidebarRef.current?.contains(focusOwner)) return;
      workFocusIdentityRef.current = null;
      workFocusIndexRef.current = null;
      workFocusConversationIdsRef.current = [];
    };
    document.addEventListener("focusin", clearWorkFocusIfUnowned);
    document.addEventListener("pointerdown", clearWorkFocusIfUnowned, true);
    return () => {
      document.removeEventListener("focusin", clearWorkFocusIfUnowned);
      document.removeEventListener("pointerdown", clearWorkFocusIfUnowned, true);
    };
  }, []);

  useEffect(() => {
    if (!mobile || !open) return;
    const sidebar = sidebarRef.current;
    const restoreFocus = focusModalOnAnimationFrame(() => (
      sidebar?.querySelector<HTMLElement>('[aria-label="Close navigation"]')?.focus({ preventScroll: true })
    ));
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (sidebar) trapModalFocus(event, sidebar);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreFocus();
    };
  }, [mobile, open]);

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
  const scopedProjectId = projectScopeId && projectById.has(projectScopeId) ? projectScopeId : null;
  const activityThreads = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sortSidebarThreadViews(
      conversations
        .filter((conversation) => {
          if (scopedProjectId && conversation.projectId !== scopedProjectId) return false;
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
    scopedProjectId,
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
  const workSearchActive = Boolean(query.trim());
  const [
    focusWorkIdentity,
    workFocusOrder,
    workIndexByIdentity,
    workNavigationOrder,
    renderedWorkConversationIds,
    renderedWorkItems,
    workStreamRef,
    workIndexTotalSize,
    updateWorkViewport,
    virtualizedWorkIndex,
    visibleWorkConversationIds,
  ] = useSidebarWorkIndex({
    activeConversationId: snapshot?.activeConversationId ?? null,
    compact,
    doneVisible,
    enabled: true,
    expandedSections: expandedWorkSections,
    motionEnabled: !reducedMotion,
    navigationRef,
    searchActive: workSearchActive,
    sections: workSections,
  });
  useLayoutEffect(() => {
    if (conversationMenu && !visibleWorkConversationIds.has(conversationMenu)) {
      dismissMenu("context-change");
    }
    if (renaming && !visibleWorkConversationIds.has(renaming)) {
      setRenaming(null);
      setRenameDraft("");
    }
  }, [
    conversationMenu,
    dismissMenu,
    renaming,
    visibleWorkConversationIds,
  ]);
  useLayoutEffect(() => {
    if (!virtualizedWorkIndex) return;
    if (conversationMenu && !renderedWorkConversationIds.has(conversationMenu)) {
      dismissMenu("context-change");
    }
    if (renaming && !renderedWorkConversationIds.has(renaming)) {
      setRenaming(null);
      setRenameDraft("");
    }
  }, [
    conversationMenu,
    dismissMenu,
    renaming,
    renderedWorkConversationIds,
    virtualizedWorkIndex,
  ]);
  useLayoutEffect(() => {
    const identity = workFocusIdentityRef.current;
    if (!identity) return;
    const focusedSectionId = identity.startsWith("section:")
      ? identity.slice("section:".length)
      : null;
    const focusedSection = focusedSectionId
      ? workSections.find((section) => section.id === focusedSectionId)
      : undefined;
    if (focusedSection?.threads.length) {
      workFocusConversationIdsRef.current = focusedSection.threads.map(
        ({ conversation }) => conversation.id,
      );
    }
    const currentIdentityIndex = workFocusOrder.indexOf(identity);
    if (currentIdentityIndex >= 0) workFocusIndexRef.current = currentIdentityIndex;
    const activeElement = document.activeElement;
    if (
      identity.startsWith("thread-actions:")
      && activeElement instanceof HTMLElement
      && activeElement.closest(".conversation-menu")
    ) return;
    if (
      activeElement instanceof HTMLElement
      && activeElement !== document.body
      && activeElement.isConnected
    ) return;
    const previousIndex = workFocusIndexRef.current;
    const focusedConversationId = workFocusConversationId(identity);
    const focusedConversationIds = focusedConversationId
      ? [focusedConversationId]
      : workFocusConversationIdsRef.current;
    const wantsThreadAction = identity.startsWith("thread-actions:");
    const destinationThreadIdentity = focusedConversationIds
      .map((conversationId) => `thread:${conversationId}` as const)
      .find((candidate) => workIndexByIdentity.has(candidate));
    const destinationSection = focusedConversationIds
      .map((conversationId) => workSections.find((section) => (
        section.threads.some(({ conversation }) => conversation.id === conversationId)
      )))
      .find((section) => section !== undefined);
    const collapsedDestinationSection = destinationSection
      && COLLAPSIBLE_WORK_SECTIONS.has(destinationSection.id)
      && !workSearchActive
      && !expandedWorkSections.has(destinationSection.id)
      ? destinationSection
      : undefined;
    const currentItemIdentity = wantsThreadAction
      ? `thread:${identity.slice("thread-actions:".length)}`
      : identity;
    const fallbackIdentity = previousIndex === null
      ? undefined
      : workFocusOrder[Math.min(previousIndex, workFocusOrder.length - 1)];
    const targetIdentity = workIndexByIdentity.has(currentItemIdentity)
      ? identity
      : destinationThreadIdentity
        ? wantsThreadAction
          ? `thread-actions:${destinationThreadIdentity.slice("thread:".length)}`
          : destinationThreadIdentity
        : collapsedDestinationSection
          ? `section:${collapsedDestinationSection.id}`
          : fallbackIdentity;
    if (targetIdentity && focusWorkIdentity(targetIdentity)) {
      workFocusIdentityRef.current = targetIdentity;
      const targetIndex = workFocusOrder.indexOf(targetIdentity);
      workFocusIndexRef.current = targetIndex >= 0 ? targetIndex : null;
      return;
    }
    sidebarRef.current
      ?.querySelector<HTMLInputElement>('input[type="search"]')
      ?.focus({ preventScroll: true });
    workFocusIdentityRef.current = null;
    workFocusIndexRef.current = null;
  }, [
    doneVisible,
    expandedWorkSections,
    focusWorkIdentity,
    snoozeNow,
    workIndexByIdentity,
    workFocusOrder,
    workNavigationOrder,
    workSearchActive,
    workSections,
  ]);
  const visibleWorkCount = workSections.reduce(
    (count, section) => count + section.threads.length,
    0,
  );
  const activeRenameProject = renamingProject ? projectById.get(renamingProject) : undefined;

  const navigate = (nextView: AppView) => {
    onViewChange(nextView);
    onClose();
  };

  const activateConversation = (conversation: Conversation) => {
    onSelectConversation(conversation);
    onViewChange("workspace");
    onClose();
  };

  const handleNavigationKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isSidebarNavigationKey(event.key)) return;
    const eventTarget = event.target instanceof HTMLElement ? event.target : null;
    if (
      eventTarget?.matches("input, textarea, select")
      || eventTarget?.isContentEditable
    ) return;
    const focusOwner = eventTarget?.closest<HTMLElement>("[data-work-focus-id]");
    const rawIdentity = focusOwner?.dataset.workFocusId;
    const identity = rawIdentity?.startsWith("thread-actions:")
      ? `thread:${rawIdentity.slice("thread-actions:".length)}`
      : rawIdentity;
    const currentIndex = identity
      ? workNavigationOrder.indexOf(identity)
      : -1;
    const nextIndex = nextSidebarNavigationIndex(
      currentIndex,
      event.key,
      workNavigationOrder.length,
    );
    const nextIdentity = workNavigationOrder[nextIndex];
    if (!nextIdentity) return;
    event.preventDefault();
    focusWorkIdentity(nextIdentity);
    workFocusIdentityRef.current = nextIdentity;
    workFocusIndexRef.current = nextIndex;

  };

  const startProjectRename = (project: Project) => {
    dismissMenu("context-change");
    setProjectRenameDraft(project.name);
    setRenamingProject(project.id);
  };

  const projectActions = (project: Project) => (
    <div
      ref={(node) => setMenuPopover(`:${project.id}`, node)}
      id={`project-actions-${project.id}`}
      data-project-menu-id={project.id}
      className="project-menu"
      role="menu"
      aria-label={`Project actions for ${project.name}`}
      onKeyDown={navigateMenuItems}
    >
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { dismissMenu("selection"); onCreateConversation(project); }}><SquarePen size={13} />New chat in {project.name}</button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { dismissMenu("selection"); onOpenProject(project); }}><FolderOpen size={13} />Open folder</button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => startProjectRename(project)}><Pencil size={13} />Rename</button>
      <span className="project-menu-heading"><Layers3 size={12} />Grouping behavior</span>
      <button
        type="button"
        role="menuitemradio"
        tabIndex={-1}
        aria-checked={project.groupingMode === null}
        onClick={() => { dismissMenu("selection"); onSetProjectGrouping(project, null); }}
      >
        <span className="menu-check">{project.groupingMode === null ? "✓" : ""}</span>
        Use global ({groupingLabel(globalGrouping)})
      </button>
      {(["repository", "repository-path", "separate"] as const).map((mode) => (
        <button
          type="button"
          role="menuitemradio"
          tabIndex={-1}
          aria-checked={project.groupingMode === mode}
          onClick={() => { dismissMenu("selection"); onSetProjectGrouping(project, mode); }}
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
          tabIndex={-1}
          aria-checked={project.gitRepositoryLimit === limit}
          onClick={() => {
            dismissMenu("selection");
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
        tabIndex={-1}
        className="is-danger"
        disabled={
          snapshot?.runs.some((run) => (
            run.projectId === project.id
            && (run.status === "running" || run.status === "waiting")
          ))
          || snapshot?.conversations.some((conversation) => (
            conversation.projectId === project.id
            && detachedConversationIds.has(conversation.id)
          ))
        }
        title={snapshot?.conversations.some((conversation) => (
          conversation.projectId === project.id
          && detachedConversationIds.has(conversation.id)
        ))
          ? "Return this project's detached chats before removing it."
          : undefined}
        onClick={() => { dismissMenu("selection"); onRemoveProject(project); }}
      >
        <Trash2 size={13} />Remove project
      </button>
    </div>
  );

  const conversationActions = (conversation: Conversation) => {
    const thread = threadViewsById.get(conversation.id)
      ?? sidebarThreadView(conversation, snapshot?.activeConversationId ?? null);
    return (
      <ConversationActionsMenu
        activeConversationId={snapshot?.activeConversationId ?? null}
        activity
        conversation={conversation}
        detachedChatLimitReached={detachedChatLimitReached}
        isDetached={detachedConversationIds.has(conversation.id)}
        runs={snapshot?.runs ?? []}
        splitConversationId={splitConversationId}
        thread={thread}
        onAcknowledgeRun={onAcknowledgeRun}
        onArchiveConversation={onArchiveConversation}
        onCloseConversationSplit={onCloseConversationSplit}
        onDeleteConversation={onDeleteConversation}
        onDismiss={dismissMenu}
        onDismissRun={onDismissRun}
        onOpenConversationInSplit={onOpenConversationInSplit}
        onOpenConversationInWindow={onOpenConversationInWindow}
        onPinConversation={onPinConversation}
        onRestoreConversation={onRestoreConversation}
        onSetPopover={(node) => setMenuPopover(conversation.id, node)}
        onSettleConversation={onSettleConversation}
        onSnoozeConversation={onSnoozeConversation}
        onStartRename={() => {
          setRenameDraft(conversation.title);
          setRenaming(conversation.id);
        }}
      />
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
        data-work-focus-id={`thread:${conversation.id}`}
        aria-label={`Rename ${conversation.title}`}
        onChange={(event) => setRenameDraft(event.target.value)}
        onBlur={() => setRenaming(null)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault(); event.stopPropagation();
          setRenaming(null);
        }}
      />
    </form>
  );

  const activityRow = (
    conversation: Conversation,
    position: number,
    sectionId: SidebarWorkSectionId,
  ) => {
    const model = threadViewsById.get(conversation.id)
      ?? sidebarThreadView(conversation, snapshot?.activeConversationId ?? null);
    const project = projectById.get(conversation.projectId);
    const isActive = snapshot?.activeConversationId === conversation.id && view === "workspace";
    const providerLabel = snapshot?.settings.providerIdentityLabels[conversation.providerId]
      ?? agentRequestProviderName(conversation.providerId);
    const projectLabel = workProjectLabel(project);
    const repositoryLabel = workRepositoryLabel(project);
    const WorkStatusIcon = workStatusIcons[model.status];
    const isDetached = detachedConversationIds.has(conversation.id);
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
      isDetached ? "Open in a separate chat window" : null,
      splitConversationId === conversation.id ? "Open in split view" : null,
      model.unread ? "New completion" : null,
    ].filter((value): value is string => Boolean(value)).join(", ");
    return (
      <div
        className={clsx(
          "activity-thread",
          `status-${model.status}`,
          isActive && "is-active",
          isDetached && "is-detached",
          splitConversationId === conversation.id && "is-split",
          model.unread && "is-unread",
        )}
        role="listitem"
        aria-posinset={position}
        aria-setsize={visibleWorkConversationIds.size}
        data-sidebar-motion-id={`thread:${conversation.id}`}
        data-work-section={sectionId}
      >
        {renaming === conversation.id ? renameForm(conversation) : (
          <button
            type="button"
            className="activity-thread-select"
            data-sidebar-nav
            data-work-focus-id={`thread:${conversation.id}`}
            aria-current={isActive ? "page" : undefined}
            aria-label={accessibleContext}
            onClick={() => activateConversation(conversation)}
          >
            <span className="activity-thread-projectline">
              <FolderGit2 size={15} className="activity-project-icon" style={{ color: project?.color }} aria-hidden="true" />
              <span className="activity-thread-project-meta" title={project?.path}>{projectLabel}</span>
              <SidebarConversationMarks pinned={Boolean(conversation.pinnedAt)} detached={isDetached} split={splitConversationId === conversation.id} />
              <span className="activity-thread-trailing" aria-hidden="true">
                {model.status !== "idle" ? <span className="activity-thread-status-label"><span data-work-status={model.status}><WorkStatusIcon size={12} /></span>{statusLabels[model.status]}</span> : <time dateTime={conversation.updatedAt} title={formatRelativeTime(conversation.updatedAt)}><span className="activity-idle-icon" data-work-status="idle"><Minus size={10} /></span>{formatWorkAge(conversation.updatedAt)}</time>}
              </span>
            </span>
            <span className="activity-thread-topline">
              <span className="activity-thread-title">{conversation.title}</span>
              {model.unread && <span className="thread-unread-mark">New</span>}
            </span>
            <span className="work-thread-meta">
              {conversation.branch ? <span className="activity-thread-branch-meta" title={conversation.branch}><GitBranch size={12} aria-hidden="true" />{conversation.branch}</span> : <span className="activity-thread-branch-meta">{repositoryLabel ?? "Local workspace"}</span>}
              <span className="activity-thread-provider" title={providerLabel} aria-hidden="true"><ProviderBrandIcon providerId={conversation.providerId} size={15} /></span>
            </span>
          </button>
        )}
        <IconButton
          ref={(node) => setMenuTrigger(conversation.id, node)}
          label={`Thread actions for ${conversation.title}`}
          className="activity-thread-menu-button"
          data-work-focus-id={`thread-actions:${conversation.id}`}
          aria-haspopup="menu"
          aria-expanded={conversationMenu === conversation.id}
          aria-controls={conversationMenu === conversation.id
            ? `conversation-actions-${conversation.id}`
            : undefined}
          onClick={() => {
            toggleMenu(conversation.id);
          }}
        >
          <MoreHorizontal size={13} />
        </IconButton>
        {conversationMenu === conversation.id && conversationActions(conversation)}
      </div>
    );
  };

  const renderWorkIndexItem = (item: WorkIndexItem): React.JSX.Element => {
    if (item.kind === "thread") {
      return activityRow(item.conversation, item.position, item.sectionId);
    }
    if (item.kind === "show-more") {
      return (
        <button
          type="button"
          className="activity-show-more"
          data-sidebar-nav
          data-work-focus-id="show-more:done"
          onClick={() => setDoneVisible((count) => count + WORK_DONE_PAGE_SIZE)}
        >
          Show more <span>{item.remaining} older</span>
        </button>
      );
    }
    const { disclosure, expanded, section } = item;
    return (
      <div
        className={`work-thread-section is-${section.id}`}
        role="presentation"
      >
        {disclosure ? (
          <h2 id={`work-section-${section.id}`}>
            <button
              type="button"
              className="work-thread-section-toggle"
              data-sidebar-nav
              data-work-focus-id={`section:${section.id}`}
              aria-expanded={expanded}
              onClick={() => {
                dismissMenu("context-change");
                setExpandedWorkSections((current) => {
                  const next = new Set(current);
                  if (next.has(section.id)) next.delete(section.id);
                  else next.add(section.id);
                  return next;
                });
              }}
            >
              {expanded
                ? <ChevronDown size={12} />
                : <ChevronRight size={12} />}
              <span>{section.label}</span>
              <span>{section.threads.length}</span>
            </button>
          </h2>
        ) : (
          <h2 id={`work-section-${section.id}`}>
            <span>{section.label}</span><span>{section.threads.length}</span>
          </h2>
        )}
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
        className={clsx(
          "sidebar", open && "is-open", compact && "is-compact",
          layoutWidth <= 255 && "is-narrow", layoutWidth >= 335 && "is-wide",
          "sidebar-mode-activity",
        )}
        aria-label="Project navigation"
        aria-hidden={mobile && !open ? true : undefined}
        inert={mobile && !open ? true : undefined}
        onFocusCapture={(event) => {
          const target = event.target instanceof HTMLElement ? event.target : null;
          const focusOwner = target?.closest<HTMLElement>(
            "[data-work-focus-id], [data-work-focus-owner]",
          );
          const identity = focusOwner?.dataset.workFocusId
            ?? focusOwner?.dataset.workFocusOwner
            ?? null;
          workFocusIdentityRef.current = identity;
          if (!identity) {
            workFocusIndexRef.current = null;
            workFocusConversationIdsRef.current = [];
            return;
          }
          const focusedConversationId = workFocusConversationId(identity);
          const focusedSectionId = identity.startsWith("section:")
            ? identity.slice("section:".length)
            : null;
          workFocusConversationIdsRef.current = focusedConversationId
            ? [focusedConversationId]
            : workSections.find((section) => section.id === focusedSectionId)
              ?.threads.map(({ conversation }) => conversation.id) ?? [];
          const identityIndex = workFocusOrder.indexOf(identity);
          workFocusIndexRef.current = identityIndex >= 0 ? identityIndex : null;
        }}
      >
        <div className="sidebar-brand drag-region">
          <button type="button" className="brand-lockup no-drag" aria-label="Start a new chat" onClick={onOpenHome}>
            <img src="./inertia-logo.png" alt="" className="brand-logo" />
            <span className="brand-name">Inertia</span>
          </button>
          <IconButton label="Close navigation" className="mobile-close no-drag" onClick={onClose}><X size={17} /></IconButton>
        </div>

        <div className="sidebar-search-row">
          <div className="sidebar-search-wrap">
            <Search size={16} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search projects and conversations" placeholder="Search" type="search" />
            {query && <IconButton label="Clear search" className="search-clear" onClick={() => setQuery("")}><X size={13} /></IconButton>}
          </div>
          <IconButton label="New chat" disabled={connectionStatus !== "online" || !snapshot?.projects.length} onClick={() => {
            const target = snapshot?.projects.find((project) => project.id === (scopedProjectId ?? snapshot.activeProjectId)) ?? snapshot?.projects[0];
            if (target) onCreateConversation(target);
          }}><SquarePen size={17} /></IconButton>
          <IconButton label="Launch two chats" className="multi-spawn-button" disabled={connectionStatus !== "online" || !snapshot?.projects.length} onFocus={() => void loadMultiSpawnDialog()} onPointerDown={() => void loadMultiSpawnDialog()} onPointerEnter={() => void loadMultiSpawnDialog()} onClick={onOpenMultiSpawn}><Share2 size={15} /></IconButton>
        </div>
        <div className="sidebar-project-navigation">
        <ProjectScopePicker projects={snapshot?.projects ?? []} selectedId={scopedProjectId} onSelect={setProjectScopeId} onAdd={onImportProject} disabled={busy || connectionStatus !== "online"} onManage={(project, trigger) => {
          setMenuTrigger(`:${project.id}`, trigger);
          toggleMenu(`:${project.id}`);
        }} />
        {projectMenu && projectById.get(projectMenu) && <div className="sidebar-scope-actions">{projectActions(projectById.get(projectMenu)!)}</div>}
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
              <input id="sidebar-project-rename" value={projectRenameDraft} autoFocus maxLength={80} onChange={(event) => setProjectRenameDraft(event.target.value)} onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault(); event.stopPropagation();
                setRenamingProject(null);
              }} />
              <button type="submit">Save</button>
            </span>
          </form>
        )}

        <div className="project-list" ref={navigationRef} onKeyDown={handleNavigationKeyDown} onScroll={updateWorkViewport} role="list" aria-label="Work">
          {!snapshot && <div className="sidebar-loading"><LoadingMark label="Loading projects" /><span>Opening your workspace…</span></div>}
          {snapshot && (
            <div
              ref={workStreamRef}
              className={clsx(
                "activity-thread-stream",
                virtualizedWorkIndex && "is-virtualized",
              )}
              data-work-index-virtualized={virtualizedWorkIndex ? "true" : "false"}
              style={virtualizedWorkIndex ? {
                height: `${workIndexTotalSize}px`,
              } : undefined}
            >
              {visibleWorkCount === 0 && (
                <div className="sidebar-empty">
                  <Activity size={19} />
                  <span>{query ? "No matching work" : snapshot.projects.length === 0 ? "No projects yet" : "No work yet"}</span>
                </div>
              )}
              {renderedWorkItems.map((rendered) => {
                if (!virtualizedWorkIndex) {
                  return (
                    <div className="work-index-static-item" key={rendered.item.id}>
                      {renderWorkIndexItem(rendered.item)}
                    </div>
                  );
                }
                const start = rendered.start
                  ?? rendered.index * (compact ? 42 : 48);
                return (
                  <div
                    className="work-index-virtual-item"
                    key={rendered.item.id}
                    style={{ transform: `translateY(${start}px)` }}
                  >
                    {renderWorkIndexItem(rendered.item)}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="sidebar-footer sidebar-utility-footer">
          {view !== "workspace" && view !== "home" && <button type="button" className="sidebar-destination" aria-label="Workspace" title="Back to workspace" onClick={() => navigate("workspace")}><ArrowLeft size={16} /><span>Workspace</span></button>}
          <button type="button" className={clsx("sidebar-destination", dailyWorkOpen && "is-open")} aria-label="Daily work" title="Daily work" aria-haspopup="dialog" aria-expanded={dailyWorkOpen} onFocus={() => void loadDailyWorkDialog()} onPointerDown={() => void loadDailyWorkDialog()} onPointerEnter={() => void loadDailyWorkDialog()} onClick={() => { onOpenDailyWork(); onClose(); }}>
            <DailyWorkMark size={16} /><span>Daily work</span>
          </button>
          <button type="button" className={clsx("sidebar-destination", view === "usage" && "is-active")} aria-label="Usage" title="Usage" aria-current={view === "usage" ? "page" : undefined} onFocus={() => void loadUsageView()} onPointerDown={() => void loadUsageView()} onPointerEnter={() => void loadUsageView()} onClick={() => navigate("usage")}>
            <BarChart3 size={16} /><span>Usage</span>
          </button>
          <button type="button" className={clsx("sidebar-destination", view === "settings" && "is-active")} aria-label="Settings" title="Settings" aria-current={view === "settings" ? "page" : undefined} onFocus={() => void loadSettingsView()} onPointerDown={() => void loadSettingsView()} onPointerEnter={() => void loadSettingsView()} onClick={() => navigate("settings")}>
            <Settings size={16} /><span>Settings</span>
          </button>
          <IconButton label={updateAvailable ? "Update available — open settings" : "Application updates"} className={clsx("sidebar-update-button", updateAvailable && "has-update")} onClick={() => navigate("settings")}><Download size={18} /></IconButton>
        </div>
      </aside>
    </>
  );
}

export const Sidebar = memo(SidebarView);
Sidebar.displayName = "Sidebar";
