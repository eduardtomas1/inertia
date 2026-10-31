import type {
  CSSProperties,
  Dispatch,
  SetStateAction,
} from "react";
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AppSettings,
  AppSnapshot,
  Conversation,
  GitBranchInfo,
  GitDiffSnapshot,
  GitStatusSnapshot,
  Project,
  ProjectAction,
  ServerEvent,
  WorkspaceRun,
} from "@shared/contracts";
import { MAC_BRAND_SAFE_INSET } from "@shared/window-chrome";
import type { ProjectAppearancePatch } from "@shared/project-preferences";

import type { useAppUpdate } from "../app-update";
import type { UpdateEverythingController } from "../hooks/useUpdateEverything";
import type { useInertiaConnection } from "../hooks/useInertiaConnection";
import { useProjectScope } from "../hooks/useProjectScope";
import type { ProviderQuotaNoticeController } from "../hooks/useProviderQuotaNotices";
import type {
  useWorkspaceLayout,
  WorkspacePanelActions,
} from "../hooks/useWorkspaceLayout";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { useStableActions } from "../hooks/useStableController";
import type { NewConversationLocation } from "../lib/newConversation";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { SplitDropZone } from "../utils/splitConversation";
import type { SplitDropPlan, SplitPaneOwner } from "../utils/splitLayout";
import { rootGitMutationScope } from "../utils/workspaceGit";
import { paletteWorkspaceCommands } from "../utils/paletteWorkspaceCommands";
import { requestHeaderBranchMenu } from "../utils/checkoutBranchMenu";
import { AppNavigationOverlays } from "./AppNavigationOverlays";
import type { CommandPaletteView } from "./CommandPalette";
import type { MessageSearchHit } from "@shared/message-search";
import { AppStatusOverlays, StatusToastStack } from "./AppStatusOverlays";
import { DialogPresence } from "./DialogPresence";
import type { CommitDialogProps } from "./CommitDialog";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { SplitDropLayer } from "./SplitDropLayer";
import { LoadingMark } from "./ui";
import { TaskCreatedNotice } from "./tasks/TaskCreatedNotice";
import { TaskCreationContext, useTaskCreationController } from "./tasks/taskCreation";
import { WelcomeGuideHost } from "./WelcomeGuideHost";
import { HelpGuideHost } from "./HelpGuideHost";
import { useHelpGuideOpen } from "../hooks/useHelpGuideOpen";
import type { SettingsSection, SettingsTarget } from "../lib/settingsTarget";
import { openWelcomeGuide } from "../utils/welcomeGuide";
import { WorkspaceHeader, type HeaderConversationMenu } from "./WorkspaceHeader";
import { PanelLayoutControls } from "./workspace-header/PanelLayoutControls";
import {
  WorkspaceScene,
  type WorkspaceSceneProps,
} from "./WorkspaceScene";
import { SIDEBAR_MIN_WIDTH } from "../hooks/useWorkspaceLayout";
import { useLaunchIntro } from "../hooks/useLaunchIntro";
import { useSidebarCollapseMotion } from "../hooks/useSidebarCollapseMotion";
import { RuntimeConnectionBanner } from "./RuntimeConnectionBanner";
import type { MultiSpawnController } from "../hooks/useMultiSpawn";
import type { MainWindowTargetAppActions } from "../hooks/useMainWindowTargets";
import type { AppView } from "../appView";
import type { UsageViewProps } from "./UsageView";
import {
  loadCommitDialog,
  loadDailyWorkDialog,
  loadMultiSpawnDialog,
  scheduleFrequentSurfacePrefetch,
  loadTasksView,
  loadUsageView,
} from "./lazySurfaceLoaders";

const RootCommitDialog = lazy(async () => ({
  default: (await loadCommitDialog()).RootCommitDialog,
}));
const MultiSpawnDialog = lazy(async () => ({
  default: (await loadMultiSpawnDialog()).MultiSpawnDialog,
}));
const PullRequestDialog = lazy(() => import("./PullRequestDialog"));
const GitHistoryPanel = lazy(() => import("./GitHistoryPanel"));
const ThreadNotifications = lazy(async () => ({
  default: (await import("../hooks/useThreadNotifications")).ThreadNotifications,
}));
const MainWindowTargets = lazy(async () => ({
  default: (await import("../hooks/useMainWindowTargets")).MainWindowTargets,
}));
const CompletionSounds = lazy(async () => ({
  default: (await import("../hooks/useCompletionSounds")).CompletionSounds,
}));
const Sidebar = lazy(async () => ({
  default: (await import("./Sidebar")).Sidebar,
}));

type Connection = ReturnType<typeof useInertiaConnection>;
type AppUpdate = ReturnType<typeof useAppUpdate>;
type WorkspaceLayout = ReturnType<typeof useWorkspaceLayout>;

interface AppLayoutActions {
  run: (
    key: string,
    command: CommandWithoutId,
    options?: { reportError?: boolean; passive?: boolean },
  ) => Promise<ServerEvent>;
  importProject: () => Promise<void>;
  openGlobalChat: () => void;
  openNoProjectChat: () => void;
  selectProject: (project: Project) => void;
  selectConversation: (conversation: Conversation) => void;
  selectMessage: (hit: MessageSearchHit, signal?: AbortSignal) => Promise<boolean>;
  openConversationInSplit: (conversation: Conversation) => void;
  openConversationInWindow: (conversation: Conversation) => void;
  closeConversationSplit: (conversation: Conversation) => void;
  planConversationDrop?: (
    conversationId: string,
    target: SplitPaneOwner,
    zones: readonly SplitDropZone[],
  ) => SplitDropPlan | null;
  dropConversationInSplit?: (conversationId: string, plan: SplitDropPlan) => void;
  openProviderSetup: (providerId: Conversation["providerId"]) => void;
  openBackendSetup: (profileId: string) => void;
  openProjectSettings?: (projectId: string) => void;
  openSettingsSection: (section: SettingsSection) => void;
  openSettings: (target?: SettingsTarget) => void;
  closeSettings: () => void;
  createConversation: (
    project?: Project | null,
    location?: NewConversationLocation,
    options?: { draft?: string },
  ) => void;
  updateSettings: (update: Partial<AppSettings>) => Promise<void>;
  openProjectPath: (
    request: Parameters<typeof window.inertia.openProjectPath>[0],
  ) => void;
  loadBranches: () => void;
  mutateBranch: (
    type: "git.branch.create" | "git.branch.switch",
    name: string,
    remote?: boolean,
  ) => void | Promise<void>;
  loadGit: () => Promise<void>;
  refreshGitStatus?: () => void;
  mutateRemote: (type: "git.fetch" | "git.pull" | "git.push") => Promise<void>;
  loadCommitReview: () => Promise<GitDiffSnapshot | null>;
  discardCommitReview: () => void;
  commitReviewRevision: number;
  commit: (
    message: string,
    push: boolean,
    paths: string[],
  ) => Promise<void>;
  runProjectAction: (action: ProjectAction) => void;
  acknowledgeActivity: (
    activity: Pick<WorkspaceRun, "id" | "label">,
  ) => void;
  dismissActivity: (
    activity: Pick<WorkspaceRun, "id" | "label">,
  ) => void;
}

interface AppLayoutProps {
  platform: string;
  documentActive: boolean;
  documentVisible: boolean;
  settings: AppSettings;
  connection: Connection;
  appUpdate: AppUpdate;
  updateEverything?: UpdateEverythingController;
  providerQuotaNotices: ProviderQuotaNoticeController;
  workspaceLayout: WorkspaceLayout;
  view: AppView;
  setView: (view: AppView) => void;
  busyAction: string | null;
  visibleError: string | null;
  setActionError: Dispatch<SetStateAction<string | null>>;
  commitDialogOpen: boolean;
  setCommitDialogOpen: Dispatch<SetStateAction<boolean>>;
  dailyWorkOpen: boolean;
  setDailyWorkOpen: Dispatch<SetStateAction<boolean>>;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  tasksFocusAddRequest?: number;
  setTasksFocusAddRequest?: Dispatch<SetStateAction<number>>;
  project: Project | null;
  conversation: Conversation | null;
  headerConversation: Conversation | null;
  splitConversationIds: ReadonlySet<string>;
  splitViewFull: boolean;
  detachedConversationIds: ReadonlySet<string>;
  mainWindowTargetActions: MainWindowTargetAppActions;
  detachedChatLimitReached: boolean;
  conversationSuppressedInMain: boolean;
  scenePanel: WorkspacePanelActions;
  workspaceToolsUnavailableReason: string | null;
  gitStatus: GitStatusSnapshot | null;
  branches: GitBranchInfo[];
  branchesLoading?: boolean;
  branchesError?: string | null;
  projectActions: ProjectAction[];
  reviewStates: CommitDialogProps["reviewStates"];
  multiSpawn: MultiSpawnController;
  scene: WorkspaceSceneProps;
  usage: UsageViewProps;
  providerAuth: Parameters<typeof AppStatusOverlays>[0]["providerAuth"];
  actions: AppLayoutActions;
}

export function activateNotificationConversation(
  conversation: Conversation,
  actions: {
    selectConversation: (conversation: Conversation) => void;
    showWorkspace: () => void;
    closeSidebar: () => void;
    closePalette: () => void;
    closeCommitDialog: () => void;
    closePullRequestDialog: () => void;
    closeProviderAuth: () => void;
  },
): void {
  actions.closeCommitDialog();
  actions.closePullRequestDialog();
  actions.closeProviderAuth();
  actions.closeSidebar();
  actions.closePalette();
  actions.selectConversation(conversation);
  actions.showWorkspace();
}

export function formatAppShortcutLabel(
  platform: string,
  key: string,
): string {
  return `${platform === "darwin" ? "⌘" : "Ctrl+"}${key.toUpperCase()}`;
}

export function paletteCurrentProjectId(
  snapshot: AppSnapshot | null,
  projectScopeId: string | null,
): string | null {
  const scoped = projectScopeId && snapshot?.projects.some(({ id }) => id === projectScopeId) ? projectScopeId : null;
  return scoped ?? snapshot?.activeProjectId ?? null;
}

export function conversationLinkedTask(
  todos: AppSnapshot["todos"],
  conversationId: string | null,
): { id: string; title: string } | null {
  if (!todos || !conversationId) return null;
  const linked = todos.filter((todo) => todo.conversationId === conversationId);
  const task = linked.find((todo) => todo.completedAt === null) ?? linked[0];
  return task ? { id: task.id, title: task.title } : null;
}

export function conversationDeletionPrompt(
  thread: Pick<Conversation, "title" | "projectId" | "worktreePath">,
  snapshot: AppSnapshot | null,
): string {
  const prompt = `Delete “${thread.title}”? This cannot be undone.`;
  const scratch = snapshot?.projects.some(({ id, workspaceKind }) => (
    id === thread.projectId && workspaceKind === "scratch"
  ));
  if (!scratch || !thread.worktreePath) return prompt;
  return `${prompt} Its chat folder is kept at ${thread.worktreePath}.`;
}

export function activeConversationIsVisible(input: {
  view: AppView;
  commitDialogOpen: boolean;
  dailyWorkOpen?: boolean;
  pullRequestDialogOpen: boolean;
  multiSpawnOpen: boolean;
  paletteOpen: boolean;
  providerAuthOpen: boolean;
  mobileSidebarOpen: boolean;
  helpOpen?: boolean;
}): boolean {
  return input.view === "workspace"
    && !input.commitDialogOpen
    && !input.dailyWorkOpen
    && !input.pullRequestDialogOpen
    && !input.multiSpawnOpen
    && !input.paletteOpen
    && !input.providerAuthOpen
    && !input.mobileSidebarOpen
    && !input.helpOpen;
}

export const AppLayout = memo(function AppLayout({
  platform,
  documentActive,
  documentVisible,
  settings,
  connection,
  appUpdate,
  updateEverything,
  providerQuotaNotices,
  workspaceLayout,
  view,
  setView,
  busyAction,
  visibleError,
  setActionError,
  commitDialogOpen,
  setCommitDialogOpen,
  dailyWorkOpen,
  setDailyWorkOpen,
  paletteOpen,
  setPaletteOpen,
  tasksFocusAddRequest = 0,
  setTasksFocusAddRequest,
  project,
  conversation,
  headerConversation,
  splitConversationIds,
  splitViewFull,
  detachedConversationIds,
  mainWindowTargetActions,
  detachedChatLimitReached,
  conversationSuppressedInMain,
  scenePanel,
  workspaceToolsUnavailableReason,
  gitStatus,
  branches,
  branchesLoading,
  branchesError,
  projectActions,
  reviewStates,
  multiSpawn,
  scene,
  usage,
  providerAuth,
  actions,
}: AppLayoutProps): React.JSX.Element {
  const [pullRequestDialogOpen, setPullRequestDialogOpen] = useState(false);
  const [openTaskRequest, setOpenTaskRequest] = useState<{ id: string; nonce: number } | null>(null);
  if (view !== "tasks" && openTaskRequest !== null) setOpenTaskRequest(null);
  // History belongs to the chat it was opened from; switching chats hides it.
  const [gitHistoryOwner, setGitHistoryOwner] = useState<string | null>(null);
  const taskCreation = useTaskCreationController({
    snapshot: connection.snapshot,
    request: (command, options) => actions.run(command.type, command, options),
    onError: setActionError,
  });
  const UsageView = useLoadedSurface(loadUsageView, view === "usage");
  const TasksView = useLoadedSurface(loadTasksView, view === "tasks");
  const DailyWorkDialog = useLoadedSurface(loadDailyWorkDialog, dailyWorkOpen);
  const [cornerControlsWidth, setCornerControlsWidth] = useState(0);
  const [projectScopeId, setProjectScopeId] = useProjectScope(connection.snapshot);
  const [paletteView, setPaletteView] = useState<CommandPaletteView>("search");
  useEffect(() => { if (!paletteOpen) setPaletteView("search"); }, [paletteOpen]);
  const rootRepository = rootGitMutationScope(gitStatus);
  const commitReviewOwner = `${project?.id ?? ""}:${conversation?.id ?? ""}`;
  const currentOwnerRef = useRef(commitReviewOwner);
  useLayoutEffect(() => {
    currentOwnerRef.current = commitReviewOwner;
  }, [commitReviewOwner]);
  const {
    sidebarOpen,
    setSidebarOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    mobileNavigation,
    toolsVisible,
    panelPresentation,
    appShellRef,
    workspaceBodyRef,
    appShellStyle,
    workspaceBodyStyle,
    sidebar: sidebarLayout,
  } = workspaceLayout;
  const shellStyle = platform === "darwin"
    ? {
        ...appShellStyle,
        "--mac-titlebar-brand-safe-inset": `${MAC_BRAND_SAFE_INSET}px`,
      } as CSSProperties
    : appShellStyle;
  useNativePreviewSuspension(
    Boolean(visibleError)
      || providerQuotaNotices.notices.length > 0
      || taskCreation.notice !== null
      || commitDialogOpen
      || dailyWorkOpen
      || pullRequestDialogOpen
      || multiSpawn.open,
  );
  const sidebarActions = useStableActions({
    close: () => setSidebarOpen(false),
    viewChange: setView,
    openHome: actions.openGlobalChat,
    importProject: () => void actions.importProject(),
    selectProject: actions.selectProject,
    selectConversation: actions.selectConversation,
    openConversationInSplit: actions.openConversationInSplit,
    openConversationInWindow: actions.openConversationInWindow,
    closeConversationSplit: actions.closeConversationSplit,
    createConversation: actions.createConversation,
    chooseNewChatProject: () => {
      setPaletteView("new-chat");
      setPaletteOpen(true);
    },
    openMultiSpawn: multiSpawn.openDialog,
    openDailyWork: () => setDailyWorkOpen(true),
    openAgentSettings: () => actions.openSettingsSection("agents"),
    renameConversation: (thread: Conversation, title: string) => {
      void actions.run("conversation.update", {
        type: "conversation.update",
        payload: { conversationId: thread.id, title },
      }).catch(() => undefined);
    },
    pinConversation: (thread: Conversation, pinned: boolean) => {
      void actions.run("conversation.update", {
        type: "conversation.update",
        payload: { conversationId: thread.id, pinned },
      }).catch(() => undefined);
    },
    markConversationUnread: (thread: Conversation) => {
      void actions.run("conversation.mark-unread", { type: "conversation.mark-unread", payload: { conversationId: thread.id } }).catch(() => undefined);
    },
    regenerateConversationTitle: (thread: Conversation) => {
      void actions.run("conversation.regenerate-title", { type: "conversation.regenerate-title", payload: { conversationId: thread.id } }).catch(() => undefined);
    },
    openProjectSettings: (item: Project) => actions.openProjectSettings?.(item.id),
    snoozeConversation: (thread: Conversation, snoozedUntil: string | null) => {
      void actions.run("conversation.update", {
        type: "conversation.update",
        payload: { conversationId: thread.id, snoozedUntil },
      }).catch(() => undefined);
    },
    archiveConversation: (thread: Conversation) => {
      void actions.run("conversation.archive", {
        type: "conversation.archive",
        payload: { conversationId: thread.id },
      }).catch(() => undefined);
    },
    settleConversation: (thread: Conversation) => {
      void actions.run("conversation.settle", {
        type: "conversation.settle",
        payload: { conversationId: thread.id },
      }).catch(() => undefined);
    },
    restoreConversation: (thread: Conversation) => {
      void actions.run("conversation.unsettle", {
        type: "conversation.unsettle",
        payload: { conversationId: thread.id },
      }).catch(() => undefined);
    },
    deleteConversation: (thread: Conversation) => {
      const confirmed = !settings.confirmDestructiveActions
        || window.confirm(conversationDeletionPrompt(thread, connection.snapshot));
      if (confirmed) {
        void actions.run("conversation.delete", {
          type: "conversation.delete",
          payload: { conversationId: thread.id },
        }).then(async () => {
          const { releaseDeletedComposerQueue } = await import(
            "./composer/ComposerQueuedActions"
          );
          await releaseDeletedComposerQueue(
            thread.id,
            (attachmentId) => window.inertia.releaseAttachment(attachmentId),
          );
        }).catch(() => undefined);
      }
    },
    acknowledgeRun: actions.acknowledgeActivity,
    dismissRun: actions.dismissActivity,
    openProject: (item: Project) => actions.openProjectPath({
      projectId: item.id,
      relativePath: ".",
      action: "open-externally",
    }),
    renameProject: (item: Project, name: string) => {
      void actions.run("project.update", {
        type: "project.update",
        payload: { projectId: item.id, name },
      }).catch(() => undefined);
    },
    setProjectGrouping: (
      item: Project,
      groupingMode: Project["groupingMode"],
    ) => {
      void actions.run("project.update", {
        type: "project.update",
        payload: { projectId: item.id, groupingMode },
      }).catch(() => undefined);
    },
    updateProjectAppearance: async (item: Project, appearance: ProjectAppearancePatch) => {
      await actions.run("project.update", {
        type: "project.update",
        payload: { projectId: item.id, appearance },
      }, { reportError: false });
    },
    setProjectGitRepositoryLimit: (
      item: Project,
      gitRepositoryLimit: number,
    ) => {
      void actions.run("project.update", {
        type: "project.update",
        payload: { projectId: item.id, gitRepositoryLimit },
      }).catch(() => undefined);
    },
    removeProject: (item: Project) => {
      const confirmed = !settings.confirmDestructiveActions
        || window.confirm(
          `Remove “${item.name}” from Inertia? Files on disk will not be deleted.`,
        );
      if (confirmed) {
        void actions.run("project.remove", {
          type: "project.remove",
          payload: { projectId: item.id },
        }).catch(() => undefined);
      }
    },
  });
  const tasksActions = useStableActions({
    request: (command: CommandWithoutId, options?: { passive?: boolean }) => actions.run(command.type, command, options),
    openConversation: (thread: Conversation) => {
      actions.selectConversation(thread);
      setView("workspace");
    },
    open: () => setView("tasks"),
    openTask: (id: string) => {
      setOpenTaskRequest((current) => ({ id, nonce: (current?.nonce ?? 0) + 1 }));
      setView("tasks");
    },
    addTask: () => {
      setTasksFocusAddRequest?.((request) => request + 1);
      setView("tasks");
    },
  });
  const notificationActions = useStableActions({
    activate: (thread: Conversation) => {
      setDailyWorkOpen(false);
      activateNotificationConversation(thread, {
        selectConversation: actions.selectConversation,
        showWorkspace: () => setView("workspace"),
        closeSidebar: () => setSidebarOpen(false),
        closePalette: () => setPaletteOpen(false),
        closeCommitDialog: () => setCommitDialogOpen(false),
        closePullRequestDialog: () => setPullRequestDialogOpen(false),
        closeProviderAuth: providerAuth.onClose,
      });
    },
  });
  useEffect(() => {
    if (connection.status !== "online") return;
    return scheduleFrequentSurfacePrefetch();
  }, [connection.status]);
  const helpOpen = useHelpGuideOpen();
  const activeConversationVisible = !conversationSuppressedInMain
    && activeConversationIsVisible({
    view,
    commitDialogOpen,
    dailyWorkOpen,
    pullRequestDialogOpen,
    multiSpawnOpen: multiSpawn.open,
    paletteOpen,
    providerAuthOpen: Boolean(providerAuth.provider),
    mobileSidebarOpen: mobileNavigation && sidebarOpen,
    helpOpen,
    });

  const splitActive = splitConversationIds.size > 0;
  const headerTools = scene.tools;
  const isServerConversation = Boolean(
    headerConversation && conversation && headerConversation.id === conversation.id,
  );
  const cornerControlsVisible = view === "workspace" && project !== null;
  const mainPanelOpen = view === "workspace"
    && !splitActive
    && toolsVisible
    && headerTools !== null;
  const frameHasInlinePanel = mainPanelOpen && panelPresentation === "inline";
  const frameHasSheetPanel = mainPanelOpen && panelPresentation === "sheet";
  const dismissVisibleError = (): void => {
    setActionError(null);
    connection.clearError();
  };
  const frameStyle = {
    ...workspaceBodyStyle,
    "--workspace-corner-controls-width": `${cornerControlsVisible ? cornerControlsWidth : 0}px`,
  } as CSSProperties;
  const openCheckout = (action: "open-externally" | "reveal"): void => {
    if (!project) return;
    actions.openProjectPath({
      projectId: project.id,
      ...(conversation ? { conversationId: conversation.id } : {}),
      relativePath: ".",
      action,
    });
  };
  const openPullRequest = (): void => {
    if (!project) return;
    if (!rootRepository) {
      setActionError(
        "Refresh repository status before opening a pull request.",
      );
      return;
    }
    setPullRequestDialogOpen(true);
  };
  const linkedTask = view === "workspace" && isServerConversation
    ? conversationLinkedTask(connection.snapshot?.todos, headerConversation?.id ?? null)
    : null;
  const headerConversationMenu: HeaderConversationMenu | null = headerConversation
    && isServerConversation
    ? {
        projectPath: project?.path,
        onMarkUnread: () => sidebarActions.markConversationUnread(headerConversation),
        onRegenerateTitle: () =>
          sidebarActions.regenerateConversationTitle(headerConversation),
        ...(project && actions.openProjectSettings ? {
          onProjectSettings: () => actions.openProjectSettings?.(project.id),
        } : {}),
        activeConversationId: connection.snapshot?.activeConversationId ?? null,
        detachedChatLimitReached,
        isDetached: detachedConversationIds.has(headerConversation.id),
        runs: connection.snapshot?.runs ?? [],
        splitConversationIds,
        splitViewFull,
        onAcknowledgeRun: sidebarActions.acknowledgeRun,
        onArchiveConversation: sidebarActions.archiveConversation,
        onCloseConversationSplit: sidebarActions.closeConversationSplit,
        onDeleteConversation: sidebarActions.deleteConversation,
        onDismissRun: sidebarActions.dismissRun,
        onOpenConversationInSplit: sidebarActions.openConversationInSplit,
        onOpenConversationInWindow: sidebarActions.openConversationInWindow,
        onPinConversation: sidebarActions.pinConversation,
        onRestoreConversation: sidebarActions.restoreConversation,
        onSettleConversation: sidebarActions.settleConversation,
        onSnoozeConversation: sidebarActions.snoozeConversation,
      }
    : null;

  const workspaceCommands = paletteOpen && view === "workspace" && project && headerConversation
    ? paletteWorkspaceCommands({
        surfaces: headerTools ? {
          unavailable: headerTools.panel.unavailable ?? {},
          open: headerTools.panel.onOpenSurface,
        } : null,
        git: {
          status: gitStatus,
          busy: Boolean(busyAction),
          commit: () => setCommitDialogOpen(true),
          fetch: () => { void actions.mutateRemote("git.fetch").catch(() => undefined); },
          pull: () => { void actions.mutateRemote("git.pull").catch(() => undefined); },
          push: () => { void actions.mutateRemote("git.push").catch(() => undefined); },
          createPullRequest: openPullRequest,
          switchBranch: () => { requestHeaderBranchMenu(); },
        },
        terminal: headerTools ? {
          unavailableReason: workspaceToolsUnavailableReason,
          shortcut: formatAppShortcutLabel(platform, settings.keybindings["toggle-terminal"]),
          toggle: scenePanel.toggleTerminal,
        } : null,
        window: isServerConversation && conversation ? {
          conversation,
          isDetached: detachedConversationIds.has(conversation.id),
          detachedChatLimitReached,
          openInWindow: sidebarActions.openConversationInWindow,
        } : null,
      })
    : undefined;

  const [appBooted, setAppBooted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAppBooted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const launchIntro = useLaunchIntro(Boolean(connection.snapshot));
  const sidebarMotion = useSidebarCollapseMotion(sidebarCollapsed, mobileNavigation, appShellRef);

  return (
    <div
      ref={appShellRef}
      className={`app-shell platform-${platform}${
        sidebarCollapsed && !mobileNavigation ? " is-sidebar-collapsed" : ""
      }`}
      data-app-boot={appBooted ? "ready" : "initial"}
      data-app-intro={launchIntro ? "" : undefined}
      data-sidebar-collapse={sidebarMotion ?? undefined}
      data-interface-scale={settings.interfaceScale}
      data-runtime-generation={connection.runtimeGeneration ?? undefined}
      data-connection-status={connection.status}
      data-document-visible={documentVisible}
      style={shellStyle}
    >
      <Suspense fallback={null}>
        <ThreadNotifications
          snapshot={connection.snapshot}
          documentActive={documentActive}
          activeConversationVisible={activeConversationVisible}
          splitConversationIds={splitConversationIds}
          enabled={settings.desktopNotifications}
          onlyInBackground={settings.notifyOnlyInBackground}
          onActivate={notificationActions.activate}
        />
        <MainWindowTargets
          snapshot={connection.snapshot}
          detachedConversationIds={detachedConversationIds}
          activateConversation={notificationActions.activate}
          actions={mainWindowTargetActions}
        />
        {settings.completionSound.enabled && <CompletionSounds snapshot={connection.snapshot} settings={settings.completionSound} />}
      </Suspense>
      {(mobileNavigation || !sidebarCollapsed || sidebarMotion === "collapsing") && (
        <Suspense
          fallback={(
            <aside
              className={`sidebar${sidebarOpen ? " is-open" : ""}`}
              aria-label="Project navigation"
              aria-busy="true"
              aria-hidden={mobileNavigation && !sidebarOpen ? true : undefined}
              inert={mobileNavigation && !sidebarOpen ? true : undefined}
            />
          )}
        >
          <Sidebar
            snapshot={connection.snapshot}
            connectionStatus={connection.status}
            view={view}
            open={sidebarOpen}
            concealed={sidebarMotion === "collapsing"}
            busy={busyAction === "project.create"}
            projectScopeId={projectScopeId}
            onProjectScopeChange={setProjectScopeId}
            appUpdate={appUpdate}
            updateEverything={updateEverything}
            layoutWidth={sidebarMotion === "collapsing" ? sidebarLayout.openValue : sidebarLayout.value}
            onClose={sidebarActions.close}
            onViewChange={sidebarActions.viewChange}
            onOpenHome={sidebarActions.openHome}
            onImportProject={sidebarActions.importProject}
            onSelectConversation={sidebarActions.selectConversation}
            splitConversationIds={splitConversationIds}
            splitViewFull={splitViewFull}
            detachedConversationIds={detachedConversationIds}
            detachedChatLimitReached={detachedChatLimitReached}
            onOpenConversationInSplit={sidebarActions.openConversationInSplit}
            onOpenConversationInWindow={sidebarActions.openConversationInWindow}
            onCloseConversationSplit={sidebarActions.closeConversationSplit}
            onCreateConversation={sidebarActions.createConversation}
            onChooseNewChatProject={sidebarActions.chooseNewChatProject}
            onOpenMultiSpawn={sidebarActions.openMultiSpawn}
            onOpenDailyWork={sidebarActions.openDailyWork}
            onOpenAgentSettings={sidebarActions.openAgentSettings}
            newChatShortcut={formatAppShortcutLabel(platform, settings.keybindings["new-chat"])}
            dailyWorkOpen={dailyWorkOpen}
            onRenameConversation={sidebarActions.renameConversation}
            onPinConversation={sidebarActions.pinConversation}
            onSnoozeConversation={sidebarActions.snoozeConversation}
            onArchiveConversation={sidebarActions.archiveConversation}
            onSettleConversation={sidebarActions.settleConversation}
            onMarkConversationUnread={sidebarActions.markConversationUnread}
            onRegenerateConversationTitle={sidebarActions.regenerateConversationTitle}
            onOpenProjectSettings={sidebarActions.openProjectSettings}
            onRestoreConversation={sidebarActions.restoreConversation}
            onDeleteConversation={sidebarActions.deleteConversation}
            onAcknowledgeRun={sidebarActions.acknowledgeRun}
            onDismissRun={sidebarActions.dismissRun}
            onOpenProject={sidebarActions.openProject}
            onRenameProject={sidebarActions.renameProject}
            onSetProjectGrouping={sidebarActions.setProjectGrouping}
            onSetProjectGitRepositoryLimit={
              sidebarActions.setProjectGitRepositoryLimit
            }
            onRemoveProject={sidebarActions.removeProject}
            onUpdateProjectAppearance={sidebarActions.updateProjectAppearance}
          />
        </Suspense>
      )}

      {!mobileNavigation && !sidebarCollapsed && (
        <PaneResizeHandle
          label="Resize project navigation"
          controls="main-workspace"
          containerRef={appShellRef}
          orientation="vertical"
          value={sidebarLayout.value}
          min={SIDEBAR_MIN_WIDTH}
          max={sidebarLayout.max}
          defaultValue={276}
          onChange={sidebarLayout.onChange}
          onCommit={sidebarLayout.onCommit}
          valueText={(value) => `${value} pixels for project navigation`}
          className="sidebar-resize-handle"
        />
      )}

      <section
        className="workspace-shell"
        id="main-workspace"
        tabIndex={-1}
        inert={mobileNavigation && sidebarOpen ? true : undefined}
      >
        <div
          className={`workspace-frame${frameHasInlinePanel ? " has-right-panel" : ""}${frameHasSheetPanel ? " has-right-sheet" : ""}${cornerControlsVisible ? " has-corner-controls" : ""}`}
          style={frameStyle}
        >
          <WorkspaceHeader
            project={project}
            conversation={headerConversation}
            isServerConversation={isServerConversation}
            view={view}
            sidebarCollapsed={sidebarCollapsed}
            sidebarShortcut={formatAppShortcutLabel(platform, settings.keybindings["toggle-sidebar"])}
            compact={mobileNavigation}
            gitStatus={gitStatus}
            gitNotice={headerTools?.gitNotice ?? null}
            branches={branches}
            branchesLoading={branchesLoading}
            branchesError={branchesError}
            actions={projectActions}
            runs={headerTools?.runs ?? null}
            busy={Boolean(busyAction)}
            checkoutPath={headerConversation?.worktreePath ?? project?.path ?? null}
            filesAvailable={!workspaceToolsUnavailableReason}
            conversationMenu={headerConversationMenu}
            linkedTask={linkedTask}
            onOpenTask={tasksActions.openTask}
            onOpenSidebar={() => {
              if (mobileNavigation) setSidebarOpen(true);
              else setSidebarCollapsed((collapsed) => !collapsed);
            }}
            onOpenSettings={() => setView("settings")}
            onCloseSettings={actions.closeSettings}
            {...(project ? {
              onCreateConversationInProject: () => actions.createConversation(project),
            } : {})}
            {...(headerConversation && isServerConversation ? {
              onRenameConversation: (title: string) =>
                sidebarActions.renameConversation(headerConversation, title),
            } : {})}
            onOpenFolder={() => openCheckout("open-externally")}
            onRevealFolder={() => openCheckout("reveal")}
            onOpenFiles={() => scenePanel.openSurface("files")}
            {...(project && actions.openProjectSettings ? {
              onAddAction: () => actions.openProjectSettings?.(project.id),
            } : {})}
            onRefreshBranches={actions.loadBranches}
            onSwitchBranch={(name, remote) =>
              actions.mutateBranch("git.branch.switch", name, remote)}
            onCreateBranch={(name) =>
              actions.mutateBranch("git.branch.create", name)}
            onCommit={() => setCommitDialogOpen(true)}
            onRunAction={actions.runProjectAction}
            onCreateConversationOnBranch={(branch) =>
              actions.createConversation(project, { kind: "branch", branch })}
            onCreateConversationInWorktree={() => {
              if (conversation?.worktreePath) {
                actions.createConversation(project, {
                  kind: "worktree",
                  branch: gitStatus?.branch ?? conversation.branch,
                  path: conversation.worktreePath,
                });
              }
            }}
            onCreateConversationInIsolatedWorktree={() =>
              actions.createConversation(project, {
                kind: "isolated-worktree",
              })}
            onOpenPullRequest={openPullRequest}
            onPushAndCreatePullRequest={() => {
              const owner = commitReviewOwner;
              void actions.mutateRemote("git.push")
                .then(() => { if (currentOwnerRef.current === owner) openPullRequest(); })
                .catch(() => undefined);
            }}
            onFetch={() => { void actions.mutateRemote("git.fetch").catch(() => undefined); }}
            onPull={() => { void actions.mutateRemote("git.pull").catch(() => undefined); }}
            onPush={() => { void actions.mutateRemote("git.push").catch(() => undefined); }}
            {...(actions.refreshGitStatus ? { onRefreshGitStatus: actions.refreshGitStatus } : {})}
            onOpenGitHistory={() => setGitHistoryOwner(commitReviewOwner)}
          />
          <RuntimeConnectionBanner connection={connection} />
          {cornerControlsVisible && (
            <PanelLayoutControls
              usage={headerTools?.usage.usage ?? null}
              terminalAvailable={Boolean(headerTools) && !workspaceToolsUnavailableReason}
              {...(workspaceToolsUnavailableReason
                ? { terminalUnavailableLabel: workspaceToolsUnavailableReason }
                : {})}
              terminalOpen={scenePanel.terminalOpen}
              terminalShortcutLabel={formatAppShortcutLabel(
                platform,
                settings.keybindings["toggle-terminal"],
              )}
              rightPanelAvailable={Boolean(headerTools)}
              rightPanelOpen={Boolean(headerTools) && scenePanel.panel.isOpen}
              rightPanelUnavailableLabel={workspaceToolsUnavailableReason ?? "Right panel is unavailable"}
              activeBackgroundTaskCount={headerTools?.panel.activeBackgroundTaskCount ?? 0}
              onToggleTerminal={scenePanel.toggleTerminal}
              onToggleRightPanel={scenePanel.toggleWorkspaceTools}
              onOpenUsage={() => scenePanel.openSurface("usage")}
              onWidthChange={setCornerControlsWidth}
            />
          )}

          <div
            ref={workspaceBodyRef}
            id="workspace-content"
            data-view={view}
            className={`workspace-body${
              frameHasInlinePanel ? " has-tools" : ""
            }${frameHasSheetPanel ? " has-tools-sheet" : ""}`}
          >
          {view === "usage" ? (
              UsageView ? <UsageView {...usage} /> : (
                <div className="workspace-tool-loading usage-surface-loading">
                  <LoadingMark label="Loading usage" />
                </div>
              )
            ) : view === "tasks" ? (
              TasksView ? (
                <TasksView
                  snapshot={connection.snapshot}
                  settings={settings}
                  status={connection.status}
                  projectScopeId={projectScopeId}
                  request={tasksActions.request}
                  onOpenConversation={tasksActions.openConversation}
                  onError={setActionError}
                  openTaskRequest={openTaskRequest}
                  focusAddRequest={tasksFocusAddRequest}
                />
              ) : (
                <div className="workspace-tool-loading tasks-view-loading">
                  <LoadingMark label="Loading tasks" />
                </div>
              )
            ) : (
              <TaskCreationContext.Provider value={taskCreation.creator}>
                <WorkspaceScene {...scene} />
              </TaskCreationContext.Provider>
            )}
          </div>
          {view === "workspace" && (
            <SplitDropLayer
              surfaceRef={workspaceBodyRef}
              planDrop={conversation && actions.dropConversationInSplit
                ? actions.planConversationDrop ?? null
                : null}
              onDrop={(conversationId, plan) =>
                actions.dropConversationInSplit?.(conversationId, plan)}
            />
          )}
          <StatusToastStack
            confirmation={taskCreation.notice && (
              <TaskCreatedNotice
                key={taskCreation.notice.id}
                notice={taskCreation.notice}
                onOpenTasks={() => setView("tasks")}
                onDismiss={taskCreation.dismissNotice}
              />
            )}
            appUpdate={appUpdate}
            providerQuotaNotices={providerQuotaNotices}
            error={visibleError}
            onDismissError={dismissVisibleError}
            databaseRecoveryNotice={connection.databaseRecoveryNotice}
            onDismissDatabaseRecoveryNotice={connection.dismissDatabaseRecoveryNotice}
            onImportRecovery={async () => {
              const result = await window.inertia.importRecoveryData();
              if (result.status === "imported") {
                connection.dismissDatabaseRecoveryNotice();
              }
            }}
            onCopyRecoveryReport={async () => {
              const result = await window.inertia.copyRuntimeDiagnosticReport(
                connection.snapshot?.lifecycleDiagnostics ?? null,
              );
              if (!result.copied) throw new Error("The recovery report could not be copied.");
            }}
          />
        </div>
      </section>

      {commitDialogOpen && (
        <Suspense fallback={<LoadingMark label="Preparing commit review" />}>
          <RootCommitDialog
            owner={commitReviewOwner}
            revision={actions.commitReviewRevision}
            status={gitStatus}
            reviewStates={reviewStates}
            busy={busyAction === "git.commit" || busyAction === "git.push"}
            reviewSummary={headerTools?.changes.summary ?? null}
            loadReview={actions.loadCommitReview}
            discardReview={actions.discardCommitReview}
            onClose={() => setCommitDialogOpen(false)}
            onError={setActionError}
            onCommit={actions.commit}
          />
        </Suspense>
      )}
      <DialogPresence open={dailyWorkOpen}>
        {DailyWorkDialog && (
          <DailyWorkDialog
            open={dailyWorkOpen}
            status={usage.status}
            request={usage.request}
            onClose={() => setDailyWorkOpen(false)}
            onOpenConversation={(conversationId) => {
              const selected = connection.snapshot?.conversations.find(
                (candidate) => candidate.id === conversationId,
              );
              if (!selected) return;
              setDailyWorkOpen(false);
              actions.selectConversation(selected);
              setView("workspace");
              setSidebarOpen(false);
            }}
          />
        )}
      </DialogPresence>
      {gitHistoryOwner === commitReviewOwner && project && (
        <Suspense fallback={null}>
          <GitHistoryPanel
            open
            projectId={project.id}
            conversationId={conversation?.id}
            {...(rootRepository ? { repositoryPath: rootRepository.repositoryPath, authorityRef: rootRepository.authorityRef } : {})}
            branch={gitStatus?.branch ?? null}
            run={actions.run}
            onClose={() => setGitHistoryOwner(null)}
          />
        </Suspense>
      )}
      {pullRequestDialogOpen && project && rootRepository && (
        <Suspense fallback={null}>
          <PullRequestDialog
            open
            initialTitle={conversation?.title ?? gitStatus?.branch ?? "Pull request"}
            busy={busyAction === "git.pr.create" || busyAction === "git.pr.open"}
            projectId={project.id}
            conversationId={conversation?.id}
            repositoryPath={rootRepository.repositoryPath}
            authorityRef={rootRepository.authorityRef}
            forge={gitStatus?.pullRequest?.forge ?? "github"}
            run={actions.run}
            onClose={() => setPullRequestDialogOpen(false)}
          />
        </Suspense>
      )}
      <DialogPresence open={multiSpawn.open}>
        <Suspense fallback={null}>
          <MultiSpawnDialog
            open={multiSpawn.open}
            snapshot={connection.snapshot}
            settings={settings}
            submitting={multiSpawn.submitting}
            cancelling={multiSpawn.cancelling}
            launchBlocked={multiSpawn.launchBlocked}
            offline={connection.status !== "online"}
            error={multiSpawn.error}
            recoveryGuidance={multiSpawn.recoveryGuidance}
            recoveryStatus={multiSpawn.recoveryStatus}
            recheckingRecovery={multiSpawn.recheckingRecovery}
            acknowledgingRecovery={multiSpawn.acknowledgingRecovery}
            retryingComparison={multiSpawn.retryingComparison}
            cancellingComparison={multiSpawn.cancellingComparison}
            onClose={multiSpawn.closeDialog}
            onSubmit={multiSpawn.submit}
            onRecheckRecovery={multiSpawn.recheckRecovery}
            onAcknowledgeRecovery={multiSpawn.acknowledgeRecovery}
            onRetryComparison={multiSpawn.retryComparison}
            onCancelComparison={multiSpawn.cancelComparison}
            onOpenJudge={multiSpawn.openJudge}
            onOpenProviderSetup={actions.openProviderSetup}
            onOpenBackendSetup={actions.openBackendSetup}
          />
        </Suspense>
      </DialogPresence>
      <AppNavigationOverlays
        snapshot={connection.snapshot}
        paletteOpen={paletteOpen}
        paletteView={paletteView}
        currentProjectId={paletteCurrentProjectId(connection.snapshot, projectScopeId)}
        newThreadShortcut={formatAppShortcutLabel(
          platform,
          settings.keybindings["new-chat"],
        )}
        setPaletteOpen={setPaletteOpen}
        setWorkspaceView={() => setView("workspace")}
        selectProject={actions.selectProject}
        selectConversation={actions.selectConversation}
        selectMessage={actions.selectMessage}
        sendCommand={connection.sendCommand}
        createConversation={() => actions.createConversation()}
        createConversationIn={(project) => actions.createConversation(project)}
        openNoProjectChat={actions.openNoProjectChat}
        importProject={actions.importProject}
        openSettings={actions.openSettings}
        openTasks={tasksActions.open}
        addTask={tasksActions.addTask}
        {...(workspaceCommands ? { workspaceCommands } : {})}
      />
      <AppStatusOverlays
        providerAuth={providerAuth}
        appUpdate={appUpdate}
        providerQuotaNotices={providerQuotaNotices}
        error={visibleError}
        databaseRecoveryNotice={connection.databaseRecoveryNotice}
      />
      <WelcomeGuideHost
        snapshot={connection.snapshot}
        blocked={Boolean(providerAuth.provider)}
        existingProfile={Boolean(connection.databaseRecoveryNotice)}
        shortcuts={[
          { keys: formatAppShortcutLabel(platform, settings.keybindings.search), label: "Search" },
          { keys: formatAppShortcutLabel(platform, settings.keybindings["new-chat"]), label: "New chat" },
          { keys: formatAppShortcutLabel(platform, settings.keybindings["toggle-sidebar"]), label: "Sidebar" },
          { keys: formatAppShortcutLabel(platform, settings.keybindings["toggle-terminal"]), label: "Terminal" },
        ]}
        onOpenProviderSetup={actions.openProviderSetup}
        onAddProject={() => void actions.importProject()}
      />
      <HelpGuideHost
        shortcutLabel={(action) => formatAppShortcutLabel(platform, settings.keybindings[action])}
        commands={{
          "add-project": () => void actions.importProject(),
          search: () => setPaletteOpen(true),
          usage: () => setView("usage"),
          "daily-work": () => setDailyWorkOpen(true),
          tasks: tasksActions.open,
          "welcome-guide": openWelcomeGuide,
        }}
        projects={connection.snapshot?.projects ?? []}
        currentProjectId={paletteCurrentProjectId(connection.snapshot, projectScopeId)}
        onOpenSettings={actions.openSettings}
        onLeave={() => setSidebarOpen(false)}
        onLoadError={setActionError}
      />
    </div>
  );
});
