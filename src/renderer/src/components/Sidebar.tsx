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
  COLLAPSIBLE_WORK_SECTIONS,
  useSidebarWorkIndex,
  type WorkIndexItem,
} from "../hooks/useSidebarWorkIndex";
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
import { loadMultiSpawnDialog, loadSettingsView, loadUsageView } from "./lazySurfaceLoaders";
import type { AppView } from "../appView";

const WORK_DONE_PAGE_SIZE = 10;
const WORK_SECTIONS_STORAGE_KEY = "inertia:sidebar:work-sections:v1";
const EMPTY_CONVERSATIONS: readonly Conversation[] = [];
type SidebarProps = {
  snapshot: AppSnapshot | null;
  connectionStatus: ConnectionStatus;
  view: AppView;
  open: boolean;
  busy: boolean;
  layoutWidth: number;
  onClose: () => void;
  onViewChange: (view: AppView) => void;
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
    setConversationMenu(null);
    setRenaming(null);
    setRenameDraft("");
  }, [sidebarMode]);

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
      setConversationMenu(null);
    }
    if (renaming && !visibleWorkConversationIds.has(renaming)) {
      setRenaming(null);
      setRenameDraft("");
    }
  }, [conversationMenu, renaming, sidebarMode, visibleWorkConversationIds]);
  useLayoutEffect(() => {
    if (!virtualizedWorkIndex) return;
    if (conversationMenu && !renderedWorkConversationIds.has(conversationMenu)) {
      setConversationMenu(null);
    }
    if (renaming && !renderedWorkConversationIds.has(renaming)) {
      setRenaming(null);
      setRenameDraft("");
    }
  }, [
    conversationMenu,
    renaming,
    renderedWorkConversationIds,
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
      && focusWorkIdentity(identity)
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
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
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
        event.key as "ArrowDown" | "ArrowUp" | "Home" | "End",
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
      <div
        className="conversation-menu"
        role="menu"
        data-work-focus-owner={sidebarMode === "activity"
          ? `thread-actions:${conversation.id}`
          : undefined}
      >
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
        data-work-focus-id={sidebarMode === "activity"
          ? `thread:${conversation.id}`
          : undefined}
        aria-label={`Rename ${conversation.title}`}
        onChange={(event) => setRenameDraft(event.target.value)}
        onBlur={() => setRenaming(null)}
        onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }}
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
      splitConversationId === conversation.id ? "Open in split view" : null,
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
                {conversation.pinnedAt && <Pin className="conversation-pin" size={10} aria-label="Pinned thread" />}
                {splitConversationId === conversation.id && (
                  <Columns2
                    className="conversation-split-mark"
                    size={11}
                    aria-label="Open in split view"
                  />
                )}
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
          label={`Thread actions for ${conversation.title}`}
          className="activity-thread-menu-button"
          data-work-focus-id={`thread-actions:${conversation.id}`}
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
                setConversationMenu(null);
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

        <div className="project-list" ref={navigationRef} onKeyDown={handleNavigationKeyDown} onScroll={updateWorkViewport} role="list" aria-label={sidebarMode === "activity" ? "Work" : "Projects"}>
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
          <button type="button" className={clsx("sidebar-destination", view === "usage" && "is-active")} aria-current={view === "usage" ? "page" : undefined} onFocus={() => void loadUsageView()} onPointerDown={() => void loadUsageView()} onPointerEnter={() => void loadUsageView()} onClick={() => navigate("usage")}>
            <BarChart3 size={16} /><span>Usage</span>
          </button>
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
