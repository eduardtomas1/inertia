import type {
  CSSProperties,
  Dispatch,
  SetStateAction,
} from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import type {
  AppSettings,
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

import type { useAppUpdate } from "../app-update";
import type { useInertiaConnection } from "../hooks/useInertiaConnection";
import type { ProviderQuotaNoticeController } from "../hooks/useProviderQuotaNotices";
import type { useWorkspaceLayout } from "../hooks/useWorkspaceLayout";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { useStableActions } from "../hooks/useStableController";
import type { NewConversationLocation } from "../lib/newConversation";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { rootGitMutationScope } from "../utils/workspaceGit";
import { AppNavigationOverlays } from "./AppNavigationOverlays";
import { AppStatusOverlays } from "./AppStatusOverlays";
import type { CommitDialogProps } from "./CommitDialog";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { LoadingMark } from "./ui";
import { WorkspaceHeader } from "./WorkspaceHeader";
import {
  WorkspaceScene,
  type WorkspacePanelTab,
  type WorkspaceSceneProps,
} from "./WorkspaceScene";
import { SIDEBAR_MIN_WIDTH } from "../hooks/useWorkspaceLayout";
import type { MultiSpawnController } from "../hooks/useMultiSpawn";
import type { AppView } from "../appView";
import type { UsageViewProps } from "./UsageView";
import {
  loadCommitDialog,
  loadDailyWorkDialog,
  loadMultiSpawnDialog,
  scheduleFrequentSurfacePrefetch,
  loadUsageView,
} from "./lazySurfaceLoaders";

const RootCommitDialog = lazy(async () => ({
  default: (await loadCommitDialog()).RootCommitDialog,
}));
const DailyWorkDialog = lazy(async () => ({
  default: (await loadDailyWorkDialog()).DailyWorkDialog,
}));
const MultiSpawnDialog = lazy(async () => ({
  default: (await loadMultiSpawnDialog()).MultiSpawnDialog,
}));
const PullRequestDialog = lazy(() => import("./PullRequestDialog"));
const ThreadNotifications = lazy(async () => ({
  default: (await import("../hooks/useThreadNotifications")).ThreadNotifications,
}));
const Sidebar = lazy(async () => ({
  default: (await import("./Sidebar")).Sidebar,
}));
const UsageView = lazy(async () => ({
  default: (await loadUsageView()).UsageView,
}));

type Connection = ReturnType<typeof useInertiaConnection>;
type AppUpdate = ReturnType<typeof useAppUpdate>;
type WorkspaceLayout = ReturnType<typeof useWorkspaceLayout>;

interface AppLayoutActions {
  run: (
    key: string,
    command: CommandWithoutId,
  ) => Promise<ServerEvent>;
  importProject: () => Promise<void>;
  openGlobalChat: () => void;
  selectProject: (project: Project) => void;
  selectConversation: (conversation: Conversation) => void;
  openConversationInSplit: (conversation: Conversation) => void;
  openConversationInWindow: (conversation: Conversation) => void;
  closeConversationSplit: () => void;
  openProviderSetup: (providerId: Conversation["providerId"]) => void;
  openBackendSetup: (profileId: string) => void;
  openConnectionsSettings: () => void;
  createConversation: (
    project?: Project | null,
    location?: NewConversationLocation,
  ) => void;
  updateSettings: (update: Partial<AppSettings>) => Promise<void>;
  openProjectPath: (
    request: Parameters<typeof window.inertia.openProjectPath>[0],
  ) => void;
  cycleTheme: () => void;
  loadBranches: () => void;
  mutateBranch: (
    type: "git.branch.create" | "git.branch.switch",
    name: string,
  ) => void;
  loadGit: () => Promise<void>;
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
  project: Project | null;
  conversation: Conversation | null;
  headerConversation: Conversation | null;
  splitConversationId: string | null;
  detachedConversationIds: ReadonlySet<string>;
  detachedChatLimitReached: boolean;
  conversationSuppressedInMain: boolean;
  sceneActiveTool: WorkspacePanelTab | null;
  sceneToggleWorkspaceTools: () => void;
  sceneOpenEnvironment: () => void;
  sceneOpenBrowser: () => void;
  workspaceToolsUnavailableReason: string | null;
  gitStatus: GitStatusSnapshot | null;
  branches: GitBranchInfo[];
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

export function activeConversationIsVisible(input: {
  view: AppView;
  commitDialogOpen: boolean;
  dailyWorkOpen?: boolean;
  pullRequestDialogOpen: boolean;
  multiSpawnOpen: boolean;
  paletteOpen: boolean;
  providerAuthOpen: boolean;
  mobileSidebarOpen: boolean;
}): boolean {
  return input.view === "workspace"
    && !input.commitDialogOpen
    && !input.dailyWorkOpen
    && !input.pullRequestDialogOpen
    && !input.multiSpawnOpen
    && !input.paletteOpen
    && !input.providerAuthOpen
    && !input.mobileSidebarOpen;
}

export function AppLayout({
  platform,
  documentActive,
  documentVisible,
  settings,
  connection,
  appUpdate,
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
  project,
  conversation,
  headerConversation,
  splitConversationId,
  detachedConversationIds,
  detachedChatLimitReached,
  conversationSuppressedInMain,
  sceneActiveTool,
  sceneToggleWorkspaceTools,
  sceneOpenEnvironment,
  sceneOpenBrowser,
  workspaceToolsUnavailableReason,
  gitStatus,
  branches,
  projectActions,
  reviewStates,
  multiSpawn,
  scene,
  usage,
  providerAuth,
  actions,
}: AppLayoutProps): React.JSX.Element {
  const [pullRequestDialogOpen, setPullRequestDialogOpen] = useState(false);
  const rootRepository = rootGitMutationScope(gitStatus);
  const commitReviewOwner = `${project?.id ?? ""}:${conversation?.id ?? ""}`;
  const {
    sidebarOpen,
    setSidebarOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    stackedTools,
    mobileNavigation,
    toolsVisible,
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
      || Boolean(appUpdate.visible && appUpdate.status)
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
    openMultiSpawn: multiSpawn.openDialog,
    openDailyWork: () => setDailyWorkOpen(true),
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
        || window.confirm(`Delete “${thread.title}”? This cannot be undone.`);
      if (confirmed) {
        void actions.run("conversation.delete", {
          type: "conversation.delete",
          payload: { conversationId: thread.id },
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
    setProjectGitRepositoryLimit: (
      item: Project,
      gitRepositoryLimit: number,
    ) => {
      void actions.run("project.update", {
        type: "project.update",
        payload: { projectId: item.id, gitRepositoryLimit },
      }).catch(() => undefined);
    },
    sidebarModeChange: (sidebarMode: AppSettings["sidebarMode"]) => {
      void actions.updateSettings({ sidebarMode }).catch(() => undefined);
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
    });

  return (
    <div
      ref={appShellRef}
      className={`app-shell platform-${platform}${
        sidebarCollapsed && !mobileNavigation ? " is-sidebar-collapsed" : ""
      }`}
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
          secondaryConversationId={splitConversationId}
          enabled={settings.desktopNotifications}
          onActivate={notificationActions.activate}
        />
      </Suspense>
      {(mobileNavigation || !sidebarCollapsed) && (
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
            busy={busyAction === "project.create"}
            layoutWidth={sidebarLayout.value}
            onClose={sidebarActions.close}
            onViewChange={sidebarActions.viewChange}
            onOpenHome={sidebarActions.openHome}
            onImportProject={sidebarActions.importProject}
            onSelectProject={sidebarActions.selectProject}
            onSelectConversation={sidebarActions.selectConversation}
            splitConversationId={splitConversationId}
            detachedConversationIds={detachedConversationIds}
            detachedChatLimitReached={detachedChatLimitReached}
            onOpenConversationInSplit={sidebarActions.openConversationInSplit}
            onOpenConversationInWindow={sidebarActions.openConversationInWindow}
            onCloseConversationSplit={sidebarActions.closeConversationSplit}
            onCreateConversation={sidebarActions.createConversation}
            onOpenMultiSpawn={sidebarActions.openMultiSpawn}
            onOpenDailyWork={sidebarActions.openDailyWork}
            dailyWorkOpen={dailyWorkOpen}
            onRenameConversation={sidebarActions.renameConversation}
            onPinConversation={sidebarActions.pinConversation}
            onSnoozeConversation={sidebarActions.snoozeConversation}
            onArchiveConversation={sidebarActions.archiveConversation}
            onSettleConversation={sidebarActions.settleConversation}
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
            onSidebarModeChange={sidebarActions.sidebarModeChange}
            onRemoveProject={sidebarActions.removeProject}
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
        <div className="workspace-frame">
          <WorkspaceHeader
            project={project}
            conversation={headerConversation}
            view={view}
            activeTool={sceneActiveTool}
            sidebarCollapsed={sidebarCollapsed}
            theme={settings.theme}
            gitStatus={gitStatus}
            branches={branches}
            actions={projectActions}
            busy={Boolean(busyAction)}
            conversationDetached={Boolean(
              conversation && detachedConversationIds.has(conversation.id)
            )}
            detachedChatLimitReached={detachedChatLimitReached}
            onOpenConversationInWindow={actions.openConversationInWindow}
            onOpenSidebar={() => {
              if (mobileNavigation) setSidebarOpen(true);
              else setSidebarCollapsed((collapsed) => !collapsed);
            }}
            onToggleTools={sceneToggleWorkspaceTools}
            workspaceToolsUnavailableReason={workspaceToolsUnavailableReason}
            onOpenEnvironment={sceneOpenEnvironment}
            {...(!conversationSuppressedInMain
              ? { onOpenBrowser: sceneOpenBrowser }
              : {})}
            onCycleTheme={actions.cycleTheme}
            onOpenSettings={() => setView("settings")}
            onOpenConnectionsSettings={actions.openConnectionsSettings}
            onOpenProject={() => {
              if (project) {
                actions.openProjectPath({
                  projectId: project.id,
                  relativePath: ".",
                  action: "open-externally",
                });
              }
            }}
            onRefreshBranches={actions.loadBranches}
            onSwitchBranch={(name) =>
              actions.mutateBranch("git.branch.switch", name)}
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
            onOpenPullRequest={() => {
              if (!project) return;
              if (!rootRepository) {
                setActionError(
                  "Refresh repository status before opening a pull request.",
                );
                return;
              }
              setPullRequestDialogOpen(true);
            }}
            onPull={() => {
              if (!project) return;
              if (!rootRepository) {
                setActionError("Refresh repository status before pulling.");
                return;
              }
              void actions.run("git.pull", {
                type: "git.pull",
                payload: {
                  projectId: project.id,
                  conversationId: conversation?.id,
                  ...rootRepository,
                },
              }).catch(() => undefined);
            }}
            onPush={() => {
              if (!project) return;
              if (!rootRepository) {
                setActionError("Refresh repository status before pushing.");
                return;
              }
              void actions.run("git.push", {
                type: "git.push",
                payload: {
                  projectId: project.id,
                  conversationId: conversation?.id,
                  ...rootRepository,
                },
              }).catch(() => undefined);
            }}
          />

          <div
            ref={workspaceBodyRef}
            id="workspace-content"
            className={`workspace-body${
              view === "workspace" && !splitConversationId && toolsVisible
                ? " has-tools"
                : ""
            }${view === "workspace" && !splitConversationId && stackedTools
              ? " is-tools-stacked"
              : ""}`}
            style={workspaceBodyStyle}
          >
            {view === "usage" ? (
              <Suspense fallback={(
                <div className="workspace-tool-loading usage-surface-loading">
                  <LoadingMark label="Loading usage" />
                </div>
              )}>
                <UsageView {...usage} />
              </Suspense>
            ) : (
              <WorkspaceScene {...scene} />
            )}
          </div>
        </div>
      </section>

      {commitDialogOpen && (
        <Suspense fallback={<div role="status">Preparing commit review…</div>}>
          <RootCommitDialog
            owner={commitReviewOwner}
            revision={actions.commitReviewRevision}
            status={gitStatus}
            reviewStates={reviewStates}
            busy={busyAction === "git.commit" || busyAction === "git.push"}
            loadReview={actions.loadCommitReview}
            discardReview={actions.discardCommitReview}
            onClose={() => setCommitDialogOpen(false)}
            onError={setActionError}
            onCommit={actions.commit}
          />
        </Suspense>
      )}
      {dailyWorkOpen && (
        <Suspense fallback={null}>
          <DailyWorkDialog
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
      {multiSpawn.open && (
        <Suspense fallback={null}>
          <MultiSpawnDialog
            open
            snapshot={connection.snapshot}
            settings={settings}
            submitting={multiSpawn.submitting}
            cancelling={multiSpawn.cancelling}
            launchBlocked={multiSpawn.launchBlocked}
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
            onOpenProviderSetup={actions.openProviderSetup}
            onOpenBackendSetup={actions.openBackendSetup}
          />
        </Suspense>
      )}
      <AppNavigationOverlays
        snapshot={connection.snapshot}
        paletteOpen={paletteOpen}
        newThreadShortcut={formatAppShortcutLabel(
          platform,
          settings.keybindings["new-chat"],
        )}
        setPaletteOpen={setPaletteOpen}
        setWorkspaceView={() => setView("workspace")}
        selectProject={actions.selectProject}
        selectConversation={actions.selectConversation}
        createConversation={() => actions.createConversation()}
        importProject={actions.importProject}
        openSettings={() => setView("settings")}
      />
      <AppStatusOverlays
        providerAuth={providerAuth}
        appUpdate={appUpdate}
        providerQuotaNotices={providerQuotaNotices}
        error={visibleError}
        onDismissError={() => {
          setActionError(null);
          connection.clearError();
        }}
        databaseRecoveryNotice={connection.databaseRecoveryNotice}
        onDismissDatabaseRecoveryNotice={connection.dismissDatabaseRecoveryNotice}
        onImportRecovery={async () => {
          const result = await window.inertia.importRecoveryData();
          if (result.status === "imported") {
            connection.dismissDatabaseRecoveryNotice();
          }
        }}
        onCopyRecoveryReport={async () => {
          const result = await window.inertia.copyRuntimeDiagnosticReport();
          if (!result.copied) throw new Error("The recovery report could not be copied.");
        }}
      />
    </div>
  );
}
