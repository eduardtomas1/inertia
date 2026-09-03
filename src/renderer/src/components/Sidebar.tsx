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
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CircleX,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Layers3,
  ListTree,
  MessageCircleQuestion,
  MessageSquare,
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
import { formatRelativeTime } from "../lib/format";
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
  buildLogicalProjectGroups,
  classicSidebarSearch,
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
import type { SidebarProps } from "./sidebar/SidebarProps";
import {
  EMPTY_DETACHED_CONVERSATION_IDS,
  SidebarConversationMarks,
} from "./sidebar/SidebarConversationMarks";

const PROJECT_STATUS_LABELS: Record<Project["status"], string> = {
  ready: "Idle",
  working: "Working",
  attention: "Needs attention",
};

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
  onSelectProject,
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
  onSidebarModeChange,
  onRemoveProject,
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  useLayoutEffect(() => {
    setQuery("");
    dismissMenu("context-change");
    setRenaming(null);
    setRenameDraft("");
  }, [dismissMenu, sidebarMode]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (sidebarMode !== "activity") return;
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
  }, [sidebarMode]);

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
    enabled: sidebarMode === "activity",
    expandedSections: expandedWorkSections,
    motionEnabled: sidebarMode === "activity" && !reducedMotion,
    navigationRef,
    searchActive: workSearchActive,
    sections: workSections,
  });
  useLayoutEffect(() => {
    if (sidebarMode !== "activity") return;
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
    sidebarMode,
    visibleWorkConversationIds,
  ]);
  useLayoutEffect(() => {
    if (sidebarMode !== "activity" || !virtualizedWorkIndex) return;
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
    sidebarMode,
    virtualizedWorkIndex,
  ]);
  useLayoutEffect(() => {
    if (sidebarMode !== "activity") {
      workFocusIdentityRef.current = null;
      workFocusIndexRef.current = null;
      workFocusConversationIdsRef.current = [];
      return;
    }
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
    sidebarMode,
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

  const toggleExpanded = (projectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

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
    if (sidebarMode === "activity") {
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
      return;
    }
    const items = [...(navigationRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-nav]") ?? [])]
      .filter((item) => !item.hasAttribute("disabled"));
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextSidebarNavigationIndex(
      currentIndex,
      event.key,
      items.length,
    );
    event.preventDefault();
    items[nextIndex]?.focus();
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
        activity={sidebarMode === "activity"}
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
        data-work-focus-id={sidebarMode === "activity"
          ? `thread:${conversation.id}`
          : undefined}
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
            <span
              className="activity-thread-provider"
              aria-hidden="true"
            >
              <ProviderBrandIcon
                providerId={conversation.providerId}
                size={15}
              />
              <span
                className="activity-thread-state-mark"
                data-work-status={model.status}
              >
                <WorkStatusIcon size={8} />
              </span>
            </span>
            <span className="activity-thread-copy">
              <span className="activity-thread-topline">
                <span className="activity-thread-title">{conversation.title}</span>
                <SidebarConversationMarks
                  pinned={Boolean(conversation.pinnedAt)}
                  detached={isDetached}
                  split={splitConversationId === conversation.id}
                />
                {model.unread && <span className="thread-unread-mark">New</span>}
              </span>
              <span className="work-thread-meta">
                <span className="activity-thread-provider-label">{providerLabel}</span>
                <span className="activity-thread-project-meta">
                  <Folder size={10} aria-hidden="true" />
                  {projectLabel}
                </span>
                {repositoryLabel && (
                  <span className="activity-thread-repository-meta">
                    {repositoryLabel}
                  </span>
                )}
                {conversation.branch && (
                  <span className="activity-thread-branch-meta">
                    <GitBranch size={10} aria-hidden="true" />
                    {conversation.branch}
                  </span>
                )}
              </span>
            </span>
            <span className="activity-thread-trailing" aria-hidden="true">
              <span className="activity-thread-status-label">
                {statusLabels[model.status]}
              </span>
              <time dateTime={conversation.updatedAt}>
                {formatRelativeTime(conversation.updatedAt)}
              </time>
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
          `sidebar-mode-${sidebarMode}`,
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
              <Share2 size={15} strokeWidth={1.75} />
            </IconButton>
          </div>
        )}

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
              <input id="sidebar-project-rename" value={projectRenameDraft} autoFocus maxLength={80} onChange={(event) => setProjectRenameDraft(event.target.value)} onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault(); event.stopPropagation();
                setRenamingProject(null);
              }} />
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

        <div className="project-list" data-sidebar-mode={sidebarMode} ref={navigationRef} onKeyDown={handleNavigationKeyDown} onScroll={updateWorkViewport} role="list" aria-label={sidebarMode === "activity" ? "Work" : "Projects"}>
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
                      <button
                        type="button"
                        className="project-expand"
                        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${project.name}`}
                        aria-expanded={isExpanded}
                        onClick={() => toggleExpanded(project.id)}
                      >
                        {isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                      </button>
                      <button
                        type="button"
                        className="project-select"
                        data-sidebar-nav
                        aria-current={isActive && view === "workspace"
                          ? "page"
                          : undefined}
                        onClick={() => { onSelectProject(project); onViewChange("workspace"); onClose(); }}
                      >
                        <span className="project-copy">
                          <span className="project-name">{project.name}</span>
                          {group.projects.length > 1 && <span className="project-scope">{project.repositoryRelativePath === "." ? "Repository root" : project.repositoryRelativePath}</span>}
                        </span>
                        {project.status === "ready" ? null : (
                          <span className={clsx("project-state", `state-${project.status}`)}>
                            <span
                              className={clsx("project-status", `status-${project.status}`)}
                              aria-label={`Project status: ${project.status}`}
                              title={project.status}
                            />
                            {PROJECT_STATUS_LABELS[project.status]}
                          </span>
                        )}
                        {conversations.length > 0 && (
                          <span className="project-count">{conversations.length}</span>
                        )}
                      </button>
                      <span className="project-row-actions">
                        <IconButton
                          label={`New chat in ${project.name}`}
                          className="project-new-chat-button"
                          disabled={connectionStatus !== "online"}
                          onClick={(event) => {
                            event.stopPropagation();
                            dismissMenu("context-change");
                            onCreateConversation(project);
                          }}
                        >
                          <SquarePen size={13} />
                        </IconButton>
                        <IconButton
                          ref={(node) => setMenuTrigger(`:${project.id}`, node)}
                          label={`Project actions for ${project.name}`}
                          className="project-menu-button"
                          aria-haspopup="menu"
                          aria-controls={`project-actions-${project.id}`}
                          aria-expanded={projectMenu === project.id}
                          onClick={() => toggleMenu(`:${project.id}`)}
                        >
                          <MoreHorizontal size={14} />
                        </IconButton>
                      </span>
                      {projectMenu === project.id && projectActions(project)}
                    </div>

                    {isExpanded && (
                      <div className="conversation-list" aria-label={`${project.name} threads`}>
                        {conversations.map((conversation, conversationIndex) => {
                          const thread = threadViewsById.get(conversation.id)
                            ?? sidebarThreadView(
                              conversation,
                              snapshot?.activeConversationId ?? null,
                            );
                          const isDetached = detachedConversationIds.has(
                            conversation.id,
                          );
                          return (
                            <div
                              className={clsx(
                                "conversation-item",
                                thread.unread && "is-unread",
                              )}
                              style={{ "--chat-index": conversationIndex } as React.CSSProperties}
                              key={conversation.id}
                            >
                              {renaming === conversation.id ? renameForm(conversation) : (
                                <button
                                  type="button"
                                  className={clsx(
                                    "conversation-row",
                                    snapshot?.activeConversationId === conversation.id
                                      && view === "workspace"
                                      && "is-active",
                                    isDetached && "is-detached",
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
                                  <SidebarConversationMarks
                                    pinned={Boolean(conversation.pinnedAt)}
                                    detached={isDetached}
                                    split={splitConversationId === conversation.id}
                                  />
                                  {thread.unread && <span className="conversation-unread" aria-label="Unread completed work" />}
                                  {!compact && <span className="conversation-time">{formatRelativeTime(conversation.updatedAt)}</span>}
                                </button>
                              )}
                              <IconButton
                                ref={(node) => setMenuTrigger(
                                  conversation.id,
                                  node,
                                )}
                                label={`Thread actions for ${conversation.title}`}
                                className="conversation-menu-button"
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
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}

          {sidebarMode === "activity" && snapshot && (
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

        <div className="sidebar-footer">
          <button type="button" title="Workspace" className={clsx("sidebar-destination", view === "workspace" && "is-active")} aria-current={view === "workspace" ? "page" : undefined} onClick={() => navigate("workspace")}>
            <MessageSquare size={16} /><span>Workspace</span>
          </button>
          <button type="button" className={clsx("sidebar-destination", dailyWorkOpen && "is-open")} title="Daily work" aria-haspopup="dialog" aria-expanded={dailyWorkOpen} onFocus={() => void loadDailyWorkDialog()} onPointerDown={() => void loadDailyWorkDialog()} onPointerEnter={() => void loadDailyWorkDialog()} onClick={() => { onOpenDailyWork(); onClose(); }}>
            <DailyWorkMark size={16} /><span>Daily work</span>
          </button>
          <button type="button" className={clsx("sidebar-destination", view === "usage" && "is-active")} title="Usage" aria-current={view === "usage" ? "page" : undefined} onFocus={() => void loadUsageView()} onPointerDown={() => void loadUsageView()} onPointerEnter={() => void loadUsageView()} onClick={() => navigate("usage")}>
            <BarChart3 size={16} /><span>Usage</span>
          </button>
          <button type="button" className={clsx("sidebar-destination", view === "settings" && "is-active")} title="Settings" aria-current={view === "settings" ? "page" : undefined} onFocus={() => void loadSettingsView()} onPointerDown={() => void loadSettingsView()} onPointerEnter={() => void loadSettingsView()} onClick={() => navigate("settings")}>
            <Settings size={16} /><span>Settings</span>
          </button>
        </div>
      </aside>
    </>
  );
}

export const Sidebar = memo(SidebarView);
Sidebar.displayName = "Sidebar";
