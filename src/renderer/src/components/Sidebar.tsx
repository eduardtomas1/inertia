import {
  lazy,
  Suspense,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  Check,
  Clock,
  Columns2,
  Folder,
  FolderGit2,
  FolderOpen,
  Gauge,
  GitBranch,
  ListTodo,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import clsx from "clsx";
import type { Conversation, ConversationShell, Project, ProjectGroupingMode } from "@shared/contracts";
import { canOrganizeThread } from "../../../shared/thread-organization";
import { projectRepositoryLimitChoices } from "../../../shared/project-repository-limit";
import { useThreadPreview } from "./sidebar/useThreadPreview";
import { ProjectIcon, ProjectName } from "./ProjectIcon";
import { HintButton } from "./HintButton";
import { agentRequestProviderName } from "../utils/agentInput";
import { focusModalOnAnimationFrame, trapModalFocus } from "../utils/modalFocus";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { useSnoozeClock } from "../hooks/useSnoozeClock";
import {
  COLLAPSIBLE_WORK_SECTIONS,
  WORK_ROW_COMPACT_HEIGHT,
  WORK_ROW_HEIGHT,
  useSidebarWorkIndex,
  type PaginatedWorkSectionId,
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
import { startChatDrag } from "../utils/chatDrag";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { WatcherWorkRow } from "./sidebar/WatcherWorkRow";
import { nestWatcherThreads } from "../utils/watcherSidebar";
import { watcherRowName } from "../utils/watcherLinks";
import { loadThreadActions } from "./sidebar/threadActionLoader";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import "./sidebar/thread-actions.css";
import { DailyWorkMark } from "./DailyWorkMark";
import { IconButton, LoadingMark } from "./ui";
import { loadDailyWorkDialog, loadMultiSpawnDialog, loadSettingsView, loadTasksView, loadUsageView } from "./lazySurfaceLoaders";
import type { AppView } from "../appView";
import { ProjectScopePicker } from "./sidebar/ProjectScopePicker";
import { SidebarAurora } from "./sidebar/SidebarAurora";
import { SidebarHelpButton } from "./sidebar/SidebarHelpButton";
import "./sidebar/workspace-navigation.css";
import type { SidebarProps } from "./sidebar/SidebarProps";
import {
  EMPTY_DETACHED_CONVERSATION_IDS,
  SidebarConversationMarks,
} from "./sidebar/SidebarConversationMarks";
import { WorkStatusCue } from "./sidebar/WorkStatusCue";
import { INTERFACE_LOCALE } from "../lib/locale";
const SidebarUpdateControl = lazy(async () => ({
  default: (await import("./sidebar/SidebarUpdateControl")).SidebarUpdateControl,
}));
const WORK_DONE_PAGE_SIZE = 10;
const INITIAL_DONE_VISIBLE: Readonly<Record<PaginatedWorkSectionId, number>> = {
  done: WORK_DONE_PAGE_SIZE,
  "no-project-done": WORK_DONE_PAGE_SIZE,
};
const WORK_SECTIONS_STORAGE_KEY = "inertia:sidebar:work-sections:v1";
const EMPTY_CONVERSATIONS: readonly Conversation[] = [];

const statusLabels: Record<SidebarThreadStatus, string> = {
  working: "Working",
  approval: "Approval",
  input: "Input",
  failed: "Failed",
  limited: "Limited",
  completed: "Completed",
  idle: "Idle",
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
  if (!project?.repositoryRoot) return null;
  const relativeSegments = project.repositoryRelativePath && project.repositoryRelativePath !== "."
    ? project.repositoryRelativePath.split("/").filter(Boolean)
    : [];
  const pathSegments = project.path.split(/[\\/]/u).filter(Boolean);
  const tail = pathSegments.slice(pathSegments.length - relativeSegments.length - 1);
  const aligned = tail.length === relativeSegments.length + 1
    && tail.slice(1).join("/").toLocaleLowerCase() === relativeSegments.join("/").toLocaleLowerCase();
  const repositoryName = aligned
    ? tail[0]
    : project.repositoryRoot.split(/[\\/]/u).filter(Boolean).at(-1);
  if (!repositoryName) return null;
  if (relativeSegments.length > 0) {
    return `${repositoryName}/${(aligned ? tail.slice(1) : relativeSegments).join("/")}`;
  }
  return repositoryName.toLocaleLowerCase() !== project.name.toLocaleLowerCase()
    ? repositoryName
    : null;
}

function workFocusConversationId(identity: string): string | null {
  const prefix = ["thread-actions:", "thread:", "watcher:"].find((candidate) => identity.startsWith(candidate));
  return prefix ? identity.slice(prefix.length) : null;
}

function workConversationIdentities(conversationId: string): readonly string[] {
  return [`thread:${conversationId}`, `watcher:${conversationId}`];
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
  splitConversationIds,
  splitViewFull,
  onOpenConversationInSplit,
  onOpenConversationInWindow,
  onCloseConversationSplit,
  onCreateConversation,
  onChooseNewChatProject,
  onOpenMultiSpawn,
  onOpenDailyWork,
  newChatShortcut,
  dailyWorkOpen,
  onRenameConversation,
  onMarkConversationUnread,
  onRegenerateConversationTitle,
  onOpenProjectSettings,
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
  onUpdateProjectAppearance,
  appUpdate,
  updateEverything,
  projectScopeId,
  onProjectScopeChange,
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
  } = useDismissibleMenu<string>();
  const projectMenu = menu?.[0] === ":" ? menu.slice(1) : null;
  const conversationMenu = projectMenu ? null : menu;
  const ConversationActionsMenu = useLoadedSurface(loadThreadActions, conversationMenu !== null);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | undefined>();
  const [initialSubmenu, setInitialSubmenu] = useState<"snooze" | undefined>();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameOriginalRef = useRef("");
  const renameFocusRef = useRef<string | null>(null);
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");
  const [doneVisible, setDoneVisible] = useState(INITIAL_DONE_VISIBLE);
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
  const preview = useThreadPreview(conversations, snapshot?.projects ?? [], Boolean(menu));
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
  const newChatShortcutId = useId();
  const globalGrouping = snapshot?.settings.projectGrouping ?? "separate";

  useEffect(() => setDoneVisible(INITIAL_DONE_VISIBLE), [query]);
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
      if (focusOwner && (sidebarRef.current?.contains(focusOwner)
        || (focusOwner instanceof HTMLElement && focusOwner.dataset.workFocusOwner?.startsWith("thread-actions:")))) return;
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
      // Project search is portalled above the drawer and owns its own focus.
      if (event.target instanceof Node && !sidebar?.contains(event.target)) return;
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
  const regularProjects = useMemo(
    () => (snapshot?.projects ?? []).filter(({ workspaceKind }) => workspaceKind !== "scratch"),
    [snapshot?.projects],
  );
  const scratchProjectIds = useMemo(
    () => new Set((snapshot?.projects ?? []).filter(({ workspaceKind }) => workspaceKind === "scratch").map(({ id }) => id)),
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
  const scopedProjectId = projectScopeId && regularProjects.some(({ id }) => id === projectScopeId) ? projectScopeId : null;
  const activityThreads = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sortSidebarThreadViews(
      conversations
        .filter((conversation) => {
          if (scopedProjectId && conversation.projectId !== scopedProjectId
            && !scratchProjectIds.has(conversation.projectId)) return false;
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
    scratchProjectIds,
    projectById,
    query,
    conversations,
    snapshot?.settings.providerIdentityLabels,
    threadViewsById,
  ]);
  const watcherLinks = snapshot?.watchers;
  const nestedWork = useMemo(
    () => nestWatcherThreads(activityThreads, watcherLinks),
    [activityThreads, watcherLinks],
  );
  const workSections = useMemo(
    () => groupWorkThreads(nestedWork.threads, snoozeNow, scratchProjectIds),
    [nestedWork.threads, snoozeNow, scratchProjectIds],
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
    retainFocusedWorkItem,
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
    watchersByParent: nestedWork.watchersByParent,
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
    const conversationId = renameFocusRef.current;
    if (renaming || !conversationId) return;
    renameFocusRef.current = null;
    workConversationIdentities(conversationId).some((identity) => focusWorkIdentity(identity));
  }, [focusWorkIdentity, renaming]);
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
    const destinationThreadIdentity = focusedConversationIds
      .flatMap(workConversationIdentities)
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
    const currentItemIdentity = identity.startsWith("thread-actions:")
      ? `thread:${identity.slice("thread-actions:".length)}`
      : identity;
    const fallbackIdentity = previousIndex === null
      ? undefined
      : workFocusOrder[Math.min(previousIndex, workFocusOrder.length - 1)];
    const targetIdentity = workIndexByIdentity.has(currentItemIdentity)
      ? currentItemIdentity
      : destinationThreadIdentity
        ? destinationThreadIdentity
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
    onViewChange("workspace");
    onSelectConversation(conversation);
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
    const identity = focusOwner?.dataset.workFocusId;
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

  const endProjectRename = (): void => {
    setRenamingProject(null);
    sidebarRef.current?.querySelector<HTMLElement>(".project-scope-trigger")?.focus({ preventScroll: true });
  };

  const startProjectRename = (project: Project) => {
    dismissMenu("context-change");
    setProjectRenameDraft(project.name);
    setRenamingProject(project.id);
  };

  const projectActions = (project: Project) => {
    const running = snapshot?.runs.some((run) => (
      run.projectId === project.id
      && (run.status === "running" || run.status === "waiting")
    )) ?? false;
    const detached = snapshot?.conversations.some((conversation) => (
      conversation.projectId === project.id
      && detachedConversationIds.has(conversation.id)
    )) ?? false;
    return (
      <div
        ref={(node) => setMenuPopover(`:${project.id}`, node)}
        id={`project-actions-${project.id}`}
        data-project-menu-id={project.id}
        className="project-menu"
        role="menu"
        aria-label={`Project actions for ${project.name}`}
        onKeyDown={navigateMenuItems}
      >
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { dismissMenu("selection"); onCreateConversation(project); }}><SquarePen size={14} />New chat in {project.name}</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { dismissMenu("selection"); onOpenProject(project); }}><FolderOpen size={14} />Open folder</button>
        {onOpenProjectSettings && <button type="button" role="menuitem" tabIndex={-1} onClick={() => { dismissMenu("context-change"); onOpenProjectSettings(project); }}><Settings size={14} />Project settings</button>}
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => startProjectRename(project)}><Pencil size={14} />Rename</button>
        <div role="separator" />
        <div role="group" aria-label="Grouping behavior">
          <button
            type="button"
            role="menuitemradio"
            tabIndex={-1}
            aria-checked={project.groupingMode === null}
            onClick={() => { dismissMenu("selection"); onSetProjectGrouping(project, null); }}
          >
            <span className="menu-check">{project.groupingMode === null && <Check size={14} aria-hidden="true" />}</span>
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
              <span className="menu-check">{project.groupingMode === mode && <Check size={14} aria-hidden="true" />}</span>
              {groupingLabel(mode)}
            </button>
          ))}
        </div>
        <div role="separator" />
        <div role="group" aria-label="Repository display limit">
          {projectRepositoryLimitChoices(project.gitRepositoryLimit).map((limit) => (
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
                {project.gitRepositoryLimit === limit && <Check size={14} aria-hidden="true" />}
              </span>
              Show up to {limit} repositories
            </button>
          ))}
        </div>
        <div role="separator" />
        <HintButton
          role="menuitem"
          tabIndex={-1}
          className="is-danger"
          aria-disabled={running || detached || undefined}
          hint={detached
            ? "Return this project's detached chats before removing it."
            : running ? "Stop this project's running work before removing it." : undefined}
          onClick={() => {
            if (running || detached) return;
            dismissMenu("selection");
            onRemoveProject(project);
          }}
        >
          <Trash2 size={14} />Remove project
        </HintButton>
      </div>
    );
  };

  const conversationActions = (conversation: Conversation) => {
    if (!ConversationActionsMenu) return null;
    const thread = threadViewsById.get(conversation.id)
      ?? sidebarThreadView(conversation, snapshot?.activeConversationId ?? null);
    return (
      <ConversationActionsMenu
        anchor={menuAnchor}
        initialSubmenu={initialSubmenu}
        projectPath={projectById.get(conversation.projectId)?.path}
        onMarkUnread={onMarkConversationUnread ? () => onMarkConversationUnread(conversation) : undefined}
        onRegenerateTitle={onRegenerateConversationTitle ? () => onRegenerateConversationTitle(conversation) : undefined}
        onProjectSettings={onOpenProjectSettings && projectById.has(conversation.projectId)
          ? () => onOpenProjectSettings(projectById.get(conversation.projectId)!) : undefined}
        activeConversationId={snapshot?.activeConversationId ?? null}
        activity
        conversation={conversation}
        detachedChatLimitReached={detachedChatLimitReached}
        isDetached={detachedConversationIds.has(conversation.id)}
        runs={snapshot?.runs ?? []}
        splitConversationIds={splitConversationIds}
        splitViewFull={splitViewFull}
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
          renameOriginalRef.current = conversation.title;
          setRenameDraft(conversation.title);
          setRenaming(conversation.id);
        }}
      />
    );
  };

  const endRename = (conversation: Conversation, save: boolean, refocus: boolean): void => {
    const title = renameDraft.trim();
    if (save && title && title !== renameOriginalRef.current) onRenameConversation(conversation, title);
    if (refocus) renameFocusRef.current = conversation.id;
    setRenaming(null);
  };

  const renameForm = (conversation: Conversation) => (
    <form
      className="conversation-rename"
      onSubmit={(event) => {
        event.preventDefault();
        endRename(conversation, true, true);
      }}
    >
      <input
        value={renameDraft}
        maxLength={120}
        autoFocus
        data-work-focus-id={`thread:${conversation.id}`}
        aria-label={`Rename ${conversation.title}`}
        onChange={(event) => setRenameDraft(event.target.value)}
        onBlur={(event) => {
          if (!document.hasFocus() || document.activeElement === event.currentTarget) return;
          endRename(conversation, true, false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault(); event.stopPropagation();
          endRename(conversation, false, true);
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
    const chatFolder = project?.workspaceKind === "scratch";
    const isDetached = detachedConversationIds.has(conversation.id);
    const canOrganize = canOrganizeThread(conversation, snapshot?.runs ?? []);
    const workingSince = model.run?.status === "running" ? model.run.startedAt : null;
    const watcherLink = nestedWork.topLevelWatchers.get(conversation.id);
    const unread = model.unread && (!watcherLink || Boolean(conversation.markedUnreadAt));
    const watcherParent = watcherLink?.watchedConversationId
      ? conversations.find(({ id }) => id === watcherLink.watchedConversationId)
      : undefined;
    const accessibleContext = [
      conversation.title,
      watcherLink
        ? `${watcherRowName(watcherLink.preset)}${watcherParent ? `, watching ${watcherParent.title}` : ""}`
        : null,
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
      splitConversationIds.has(conversation.id) ? "Open in split view" : null,
      unread ? conversation.markedUnreadAt ? "Unread" : "New completion" : null,
    ].filter((value): value is string => Boolean(value)).join(", ");
    return (
      <div
        className={clsx(
          "activity-thread",
          `status-${model.status}`,
          isActive && "is-active",
          isDetached && "is-detached",
          splitConversationIds.has(conversation.id) && "is-split",
          unread && "is-unread",
          conversationMenu === conversation.id && "has-open-menu",
          canOrganize && "has-thread-inline-actions",
        )}
        role="listitem"
        aria-posinset={position}
        aria-setsize={visibleWorkConversationIds.size}
        data-sidebar-motion-id={`thread:${conversation.id}`}
        data-work-section={sectionId}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest("input")) return;
          event.preventDefault(); preview.close();
          setMenuAnchor({ x: event.clientX, y: event.clientY });
          setInitialSubmenu(undefined);
          if (conversationMenu !== conversation.id) toggleMenu(conversation.id);
        }}
      >
        {renaming === conversation.id ? renameForm(conversation) : (
          <button
            type="button"
            ref={(node) => setMenuTrigger(conversation.id, node)}
            className="activity-thread-select"
            data-sidebar-nav
            data-work-focus-id={`thread:${conversation.id}`}
            aria-current={isActive ? "page" : undefined}
            aria-label={accessibleContext}
            aria-description={`${workingSince ? `Working since ${new Date(workingSince).toLocaleString(INTERFACE_LOCALE)}. ` : ""}Right-click or press Shift+F10 for thread actions.`}
            aria-haspopup="menu"
            aria-expanded={conversationMenu === conversation.id}
            aria-controls={conversationMenu === conversation.id ? `conversation-actions-${conversation.id}` : undefined}
            aria-describedby={preview.conversationId === conversation.id ? preview.describedId : undefined}
            onPointerEnter={(event) => preview.enter(conversation.id, event.currentTarget)}
            onPointerLeave={preview.leave}
            onFocus={(event) => preview.enter(conversation.id, event.currentTarget)}
            onBlur={preview.leave}
            onPointerDown={view === "workspace" && !isDetached && conversation.archivedAt === null
              ? (event) => startChatDrag(event, { conversationId: conversation.id, title: conversation.title }, preview.close)
              : undefined}
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault(); event.stopPropagation(); preview.close();
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenuAnchor({ x: bounds.right, y: bounds.top });
              setInitialSubmenu(undefined);
              if (conversationMenu !== conversation.id) toggleMenu(conversation.id);
            }}
            onClick={() => activateConversation(conversation)}
          >
            <span className="activity-thread-topline">
              <span className="activity-thread-provider" aria-hidden="true"><ProviderBrandIcon providerId={conversation.providerId} size={14} /></span>
              <span className="activity-thread-title">{conversation.title}</span>
              {watcherLink && <span className="thread-watcher-mark" aria-hidden="true">Watcher</span>}
              {unread && <span className="thread-unread-mark">{conversation.markedUnreadAt ? "Unread" : "New"}</span>}
              <SidebarConversationMarks pinned={Boolean(conversation.pinnedAt)} detached={isDetached} split={splitConversationIds.has(conversation.id)} />
              <span className="activity-thread-trailing" aria-hidden="true">
                <WorkStatusCue
                  conversationId={conversation.id}
                  status={model.status}
                  label={statusLabels[model.status]}
                  updatedAt={conversation.updatedAt}
                  workingSince={workingSince}
                  latestTurn={(conversation as Partial<ConversationShell>).latestTurn}
                />
              </span>
            </span>
            <span className="activity-thread-projectline">
              {chatFolder ? <Folder size={14} aria-hidden="true" /> : project ? <ProjectIcon project={project} size={14} /> : <FolderGit2 size={14} aria-hidden="true" />}
              {chatFolder ? <span className="activity-thread-project-meta">Chat folder</span>
                : <ProjectName project={project} className="activity-thread-project-meta">{projectLabel}</ProjectName>}
              {conversation.branch
                ? <span className="activity-thread-branch-meta"><GitBranch size={14} aria-hidden="true" /><span>{conversation.branch}</span></span>
                : !chatFolder && <span className="activity-thread-branch-meta">{repositoryLabel ?? "Local workspace"}</span>}
            </span>
          </button>
        )}
        {canOrganize && <div className="thread-inline-actions" data-work-focus-owner={`thread-actions:${conversation.id}`}>
            <IconButton label="Snooze thread" aria-label={`Snooze ${conversation.title}`}
              onClick={(event) => {
                preview.close(); setInitialSubmenu("snooze");
                const bounds = event.currentTarget.getBoundingClientRect();
                setMenuAnchor({ x: bounds.right, y: bounds.bottom });
                if (conversationMenu !== conversation.id) toggleMenu(conversation.id);
              }}><Clock size={14} /></IconButton>
            <IconButton label={conversation.settledAt ? "Reopen thread" : "Settle thread"}
              aria-label={`${conversation.settledAt ? "Reopen" : "Settle"} ${conversation.title}`}
              onClick={() => { preview.close(); if (conversation.settledAt) onRestoreConversation(conversation); else onSettleConversation(conversation); }}>
              {conversation.settledAt ? <RotateCcw size={14} /> : <CircleCheck size={14} />}
            </IconButton>
        </div>}
        {conversationMenu === conversation.id && conversationActions(conversation)}
      </div>
    );
  };

  const renderWorkIndexItem = (item: WorkIndexItem): React.JSX.Element => {
    if (item.kind === "thread") {
      return activityRow(item.conversation, item.position, item.sectionId);
    }
    if (item.kind === "watcher") {
      const watcher = item.conversation;
      const model = threadViewsById.get(watcher.id);
      const isDetached = detachedConversationIds.has(watcher.id);
      return (
        <WatcherWorkRow
          conversation={watcher}
          parentTitle={threadViewsById.get(item.parentId)?.conversation.title ?? "this chat"}
          link={watcherLinks?.find(({ watcherConversationId }) => watcherConversationId === watcher.id)}
          position={item.position}
          setSize={visibleWorkConversationIds.size}
          active={snapshot?.activeConversationId === watcher.id && view === "workspace"}
          statusLabel={statusLabels[model?.status ?? "idle"]}
          menu={{
            open: conversationMenu === watcher.id,
            actions: conversationMenu === watcher.id ? conversationActions(watcher) : null,
            renameForm: renaming === watcher.id ? renameForm(watcher) : null,
            triggerRef: (node) => setMenuTrigger(watcher.id, node),
            onOpen: (anchor) => {
              preview.close();
              setMenuAnchor(anchor);
              setInitialSubmenu(undefined);
              if (conversationMenu !== watcher.id) toggleMenu(watcher.id);
            },
            onPointerDown: view === "workspace" && !isDetached && watcher.archivedAt === null
              ? (event) => startChatDrag(event, { conversationId: watcher.id, title: watcher.title }, preview.close)
              : undefined,
          }}
          onActivate={activateConversation}
        />
      );
    }
    if (item.kind === "show-more") {
      return (
        <button
          type="button"
          className="activity-show-more"
          data-sidebar-nav
          data-work-focus-id={item.id}
          onClick={() => setDoneVisible((current) => ({
            ...current,
            [item.sectionId]: current[item.sectionId] + WORK_DONE_PAGE_SIZE,
          }))}
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
              aria-label={section.id.startsWith("no-project-") ? `${section.label} ${section.threads.length}, No project` : undefined}
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
              <span>{section.label}</span>
              <ChevronRight size={14} aria-hidden="true" />
              <span>{section.threads.length}</span>
            </button>
          </h2>
        ) : (
          <h2 id={`work-section-${section.id}`}>
            <span>{section.label}</span><span>{section.totalCount ?? section.threads.length}</span>
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
        <SidebarAurora moving={!reducedMotion && (!mobile || open)} />
        <div className="sidebar-brand drag-region">
          {preview.preview}
          <button type="button" className="brand-lockup no-drag" aria-label="Start a new chat" onClick={onOpenHome}>
            <img src="./inertia-logo.png" alt="" className="brand-logo" />
            <span className="brand-name">Inertia</span>
          </button>
          <IconButton label="Close navigation" className="mobile-close no-drag" onClick={onClose}><X size={16} /></IconButton>
        </div>

        <div className="sidebar-primary-row">
          <button type="button" className="sidebar-primary-action" aria-describedby={newChatShortcut ? newChatShortcutId : undefined} aria-haspopup={regularProjects.length !== 1 ? "dialog" : undefined} disabled={connectionStatus !== "online"} onClick={(event) => {
            if (regularProjects.length > 1 && !event.shiftKey) { onChooseNewChatProject(); return; }
            const target = regularProjects.find((project) => project.id === (scopedProjectId ?? snapshot?.activeProjectId)) ?? regularProjects[0];
            if (target) onCreateConversation(target); else onChooseNewChatProject();
          }}>
            <SquarePen size={16} aria-hidden="true" />
            <span>New chat</span>
            {newChatShortcut && <kbd id={newChatShortcutId} aria-hidden="true">{newChatShortcut}</kbd>}
          </button>
          <IconButton label="Launch two chats" className="multi-spawn-button" disabled={connectionStatus !== "online" || !regularProjects.length} onFocus={() => void loadMultiSpawnDialog()} onPointerDown={() => void loadMultiSpawnDialog()} onPointerEnter={() => void loadMultiSpawnDialog()} onClick={onOpenMultiSpawn}><Columns2 size={16} /></IconButton>
        </div>
        <button type="button" className={clsx("sidebar-primary-action sidebar-tasks-action", view === "tasks" && "is-active")} aria-current={view === "tasks" ? "page" : undefined} onFocus={() => void loadTasksView()} onPointerDown={() => void loadTasksView()} onPointerEnter={() => void loadTasksView()} onClick={() => navigate("tasks")}>
          <ListTodo size={16} aria-hidden="true" />
          <span>Tasks</span>
        </button>
        <div className="sidebar-search-wrap">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search projects and conversations" placeholder="Search" type="search" />
          {query && <IconButton label="Clear search" className="search-clear" onClick={() => setQuery("")}><X size={14} /></IconButton>}
        </div>
        <div className="sidebar-project-navigation">
        <ProjectScopePicker projects={regularProjects} selectedId={scopedProjectId} onSelect={onProjectScopeChange} onAdd={onImportProject} disabled={busy || connectionStatus !== "online"}
          onCustomize={connectionStatus === "online" ? onUpdateProjectAppearance : undefined} onOpenSettings={onOpenProjectSettings} onManage={(project, trigger) => {
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
              endProjectRename();
            }}
          >
            <label htmlFor="sidebar-project-rename" className="visually-hidden">Rename project</label>
            <span>
              <input id="sidebar-project-rename" value={projectRenameDraft} autoFocus maxLength={80} onChange={(event) => setProjectRenameDraft(event.target.value)} onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault(); event.stopPropagation();
                endProjectRename();
              }} />
              <button type="submit">Save</button>
            </span>
          </form>
        )}

        <div className="project-list" ref={navigationRef} onKeyDown={handleNavigationKeyDown} onScroll={updateWorkViewport} role="list" aria-label="Work">
          {!snapshot && <div className="sidebar-loading"><LoadingMark label="Loading projects" /></div>}
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
                  <span>{query ? "No matching work" : regularProjects.length === 0 ? "No projects yet" : "No work yet"}</span>
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
                  ?? rendered.index * (compact ? WORK_ROW_COMPACT_HEIGHT : WORK_ROW_HEIGHT);
                return (
                  <div
                    className="work-index-virtual-item"
                    key={rendered.item.id}
                    style={{ transform: `translateY(${start}px)` }}
                    onFocusCapture={() => retainFocusedWorkItem(rendered.item.id)}
                  >
                    {renderWorkIndexItem(rendered.item)}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="sidebar-footer sidebar-utility-footer">
          {view !== "workspace" && view !== "home" && <IconButton label="Back to workspace" aria-label="Workspace" className="sidebar-destination" onClick={() => navigate("workspace")}><ArrowLeft size={16} /></IconButton>}
          <IconButton label="Daily work" className={clsx("sidebar-destination", dailyWorkOpen && "is-open")} aria-haspopup="dialog" aria-expanded={dailyWorkOpen} onFocus={() => void loadDailyWorkDialog()} onPointerDown={() => void loadDailyWorkDialog()} onPointerEnter={() => void loadDailyWorkDialog()} onClick={() => { onOpenDailyWork(); onClose(); }}>
            <DailyWorkMark size={16} />
          </IconButton>
          <IconButton label="Usage" className={clsx("sidebar-destination", view === "usage" && "is-active")} aria-current={view === "usage" ? "page" : undefined} onFocus={() => void loadUsageView()} onPointerDown={() => void loadUsageView()} onPointerEnter={() => void loadUsageView()} onClick={() => navigate("usage")}>
            <Gauge size={16} />
          </IconButton>
          <IconButton label="Settings" className={clsx("sidebar-destination", view === "settings" && "is-active")} aria-current={view === "settings" ? "page" : undefined} onFocus={() => void loadSettingsView()} onPointerDown={() => void loadSettingsView()} onPointerEnter={() => void loadSettingsView()} onClick={() => navigate("settings")}>
            <Settings size={16} />
          </IconButton>
          <SidebarHelpButton />
          {appUpdate && <Suspense fallback={<IconButton label="Loading application updates" className="sidebar-update-button" disabled><RefreshCw size={16} /></IconButton>}>
            <SidebarUpdateControl controller={appUpdate} everything={updateEverything} snapshot={snapshot} />
          </Suspense>}
        </div>
      </aside>
    </>
  );
}

export const Sidebar = memo(SidebarView);
Sidebar.displayName = "Sidebar";
