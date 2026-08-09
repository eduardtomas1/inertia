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
import type { ActivityRunSummary } from "../utils/activityCenter";
import type { EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { AppNavigationOverlays } from "./AppNavigationOverlays";
import { AppStatusOverlays } from "./AppStatusOverlays";
import type { CommitDialogProps } from "./CommitDialog";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { Sidebar } from "./Sidebar";
import { WorkspaceHeader } from "./WorkspaceHeader";
import {
  WorkspaceScene,
  type WorkspacePanelTab,
  type WorkspaceSceneProps,
} from "./WorkspaceScene";
import { SIDEBAR_MIN_WIDTH } from "../hooks/useWorkspaceLayout";
import type { MultiSpawnController } from "../hooks/useMultiSpawn";
import {
  loadCommitDialog,
  loadMultiSpawnDialog,
  scheduleFrequentSurfacePrefetch,
} from "./lazySurfaceLoaders";

const CommitDialog = lazy(async () => ({
  default: (await loadCommitDialog()).CommitDialog,
}));
const MultiSpawnDialog = lazy(async () => ({
  default: (await loadMultiSpawnDialog()).MultiSpawnDialog,
}));
const PullRequestDialog = lazy(() => import("./PullRequestDialog"));
const ThreadNotifications = lazy(async () => ({
  default: (await import("../hooks/useThreadNotifications")).ThreadNotifications,
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
  selectProject: (project: Project) => void;
  selectConversation: (conversation: Conversation) => void;
  openConversationInSplit: (conversation: Conversation) => void;
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
  commit: (
    message: string,
    push: boolean,
    paths: string[],
  ) => Promise<void>;
  runProjectAction: (action: ProjectAction) => void;
  activateActivityContext: (
    activity: WorkspaceRun,
    tool?: WorkspacePanelTab,
  ) => void;
  openActivityLocation: (activity: WorkspaceRun) => void;
  openActivityPreview: (activity: WorkspaceRun) => void;
  stopActivity: (activity: WorkspaceRun) => void;
  rerunActivity: (activity: WorkspaceRun) => void;
  markActivitySeen: (activity: WorkspaceRun) => void;
  acknowledgeActivity: (activity: WorkspaceRun) => void;
  dismissActivity: (activity: WorkspaceRun) => void;
}

interface AppLayoutProps {
  platform: string;
  documentActive: boolean;
  settings: AppSettings;
  connection: Connection;
  appUpdate: AppUpdate;
  providerQuotaNotices: ProviderQuotaNoticeController;
  workspaceLayout: WorkspaceLayout;
  view: "workspace" | "settings";
  setView: (view: "workspace" | "settings") => void;
  busyAction: string | null;
  visibleError: string | null;
  setActionError: Dispatch<SetStateAction<string | null>>;
  commitDialogOpen: boolean;
  setCommitDialogOpen: Dispatch<SetStateAction<boolean>>;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  activityOpen: boolean;
  setActivityOpen: Dispatch<SetStateAction<boolean>>;
  project: Project | null;
  conversation: Conversation | null;
  splitConversationId: string | null;
  sceneActiveTool: WorkspacePanelTab | null;
  sceneToggleWorkspaceTools: () => void;
  workspaceToolsUnavailableReason: string | null;
  environmentSummary: EnvironmentSummarySnapshot;
  runsSummary: ActivityRunSummary;
  gitStatus: GitStatusSnapshot | null;
  branches: GitBranchInfo[];
  projectActions: ProjectAction[];
  reviewStates: CommitDialogProps["reviewStates"];
  structuredDiff: CommitDialogProps["diff"];
  structuredDiffParsing: CommitDialogProps["diffParsing"];
  structuredDiffError: CommitDialogProps["diffError"];
  multiSpawn: MultiSpawnController;
  scene: WorkspaceSceneProps;
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
    closeActivity: () => void;
  },
): void {
  actions.selectConversation(conversation);
  actions.showWorkspace();
  actions.closeSidebar();
  actions.closePalette();
  actions.closeActivity();
}

export function AppLayout({
  platform,
  documentActive,
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
  paletteOpen,
  setPaletteOpen,
  activityOpen,
  setActivityOpen,
  project,
  conversation,
  splitConversationId,
  sceneActiveTool,
  sceneToggleWorkspaceTools,
  workspaceToolsUnavailableReason,
  environmentSummary,
  runsSummary,
  gitStatus,
  branches,
  projectActions,
  reviewStates,
  structuredDiff,
  structuredDiffParsing,
  structuredDiffError,
  multiSpawn,
  scene,
  providerAuth,
  actions,
}: AppLayoutProps): React.JSX.Element {
  const [pullRequestDialogOpen, setPullRequestDialogOpen] = useState(false);
  const {
    sidebarOpen,
    setSidebarOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    environmentOpen,
    setEnvironmentOpen,
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
      || multiSpawn.open,
  );
  const sidebarActions = useStableActions({
    close: () => setSidebarOpen(false),
    viewChange: setView,
    importProject: () => void actions.importProject(),
    selectProject: actions.selectProject,
    selectConversation: actions.selectConversation,
    openConversationInSplit: actions.openConversationInSplit,
    closeConversationSplit: actions.closeConversationSplit,
    createConversation: actions.createConversation,
    openMultiSpawn: multiSpawn.openDialog,
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
    activate: (thread: Conversation) => activateNotificationConversation(
      thread,
      {
        selectConversation: actions.selectConversation,
        showWorkspace: () => setView("workspace"),
        closeSidebar: () => setSidebarOpen(false),
        closePalette: () => setPaletteOpen(false),
        closeActivity: () => setActivityOpen(false),
      },
    ),
  });
  useEffect(() => {
    if (connection.status !== "online") return;
    return scheduleFrequentSurfacePrefetch();
  }, [connection.status]);

  return (
    <div
      ref={appShellRef}
      className={`app-shell platform-${platform}${
        sidebarCollapsed && !mobileNavigation ? " is-sidebar-collapsed" : ""
      }`}
      data-interface-scale={settings.interfaceScale}
      data-runtime-generation={connection.runtimeGeneration ?? undefined}
      data-connection-status={connection.status}
      data-document-active={documentActive ? "true" : "false"}
      style={shellStyle}
    >
      {settings.desktopNotifications && (
        <Suspense fallback={null}>
          <ThreadNotifications
            snapshot={connection.snapshot}
            documentActive={documentActive}
            onActivate={notificationActions.activate}
          />
        </Suspense>
      )}
      {(mobileNavigation || !sidebarCollapsed) && (
        <Sidebar
          snapshot={connection.snapshot}
          connectionStatus={connection.status}
          view={view}
          open={sidebarOpen}
          busy={busyAction === "project.create"}
          onClose={sidebarActions.close}
          onViewChange={sidebarActions.viewChange}
          onImportProject={sidebarActions.importProject}
          onSelectProject={sidebarActions.selectProject}
          onSelectConversation={sidebarActions.selectConversation}
          splitConversationId={splitConversationId}
          onOpenConversationInSplit={sidebarActions.openConversationInSplit}
          onCloseConversationSplit={sidebarActions.closeConversationSplit}
          onCreateConversation={sidebarActions.createConversation}
          onOpenMultiSpawn={sidebarActions.openMultiSpawn}
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
            conversation={conversation}
            view={view}
            activeTool={sceneActiveTool}
            sidebarCollapsed={sidebarCollapsed}
            theme={settings.theme}
            gitStatus={gitStatus}
            branches={branches}
            actions={projectActions}
            busy={Boolean(busyAction)}
            activityOpen={activityOpen}
            activeRunCount={runsSummary.activeCount}
            attentionRunCount={runsSummary.attentionCount}
            environmentSummary={environmentSummary}
            environmentOpen={environmentOpen}
            onOpenSidebar={() => {
              if (mobileNavigation) setSidebarOpen(true);
              else setSidebarCollapsed((collapsed) => !collapsed);
            }}
            onToggleTools={sceneToggleWorkspaceTools}
            workspaceToolsUnavailableReason={workspaceToolsUnavailableReason}
            onSetEnvironmentOpen={setEnvironmentOpen}
            onCycleTheme={actions.cycleTheme}
            onOpenSettings={() => setView("settings")}
            onOpenConnectionsSettings={actions.openConnectionsSettings}
            onToggleActivity={() => setActivityOpen((open) => !open)}
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
              setPullRequestDialogOpen(true);
            }}
            onPull={() => {
              if (!project) return;
              void actions.run("git.pull", {
                type: "git.pull",
                payload: {
                  projectId: project.id,
                  conversationId: conversation?.id,
                },
              }).catch(() => undefined);
            }}
          />

          <div
            ref={workspaceBodyRef}
            id="workspace-content"
            className={`workspace-body${
              !splitConversationId && toolsVisible ? " has-tools" : ""
            }${!splitConversationId && stackedTools
              ? " is-tools-stacked"
              : ""}`}
            style={workspaceBodyStyle}
          >
            <WorkspaceScene {...scene} />
          </div>
        </div>
      </section>

      {commitDialogOpen && (
        <Suspense fallback={null}>
          <CommitDialog
            open
            repositoryPath="."
            status={gitStatus}
            reviewStates={reviewStates}
            diff={structuredDiff}
            diffParsing={structuredDiffParsing}
            diffError={structuredDiffError}
            busy={busyAction === "git.commit" || busyAction === "git.push"}
            onClose={() => setCommitDialogOpen(false)}
            onCommit={async (...args) => {
              await actions.commit(...args);
              setCommitDialogOpen(false);
            }}
          />
        </Suspense>
      )}
      {pullRequestDialogOpen && project && (
        <Suspense fallback={null}>
          <PullRequestDialog
            open
            initialTitle={conversation?.title ?? gitStatus?.branch ?? "Pull request"}
            busy={busyAction === "git.pr.create" || busyAction === "git.pr.open"}
            projectId={project.id}
            conversationId={conversation?.id}
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
        activityOpen={activityOpen}
        paletteOpen={paletteOpen}
        setActivityOpen={setActivityOpen}
        setPaletteOpen={setPaletteOpen}
        setWorkspaceView={() => setView("workspace")}
        selectProject={actions.selectProject}
        selectConversation={actions.selectConversation}
        createConversation={() => actions.createConversation()}
        importProject={actions.importProject}
        activateActivityContext={actions.activateActivityContext}
        openActivityLocation={actions.openActivityLocation}
        openActivityPreview={actions.openActivityPreview}
        stopActivity={actions.stopActivity}
        rerunActivity={actions.rerunActivity}
        markActivitySeen={actions.markActivitySeen}
        acknowledgeActivity={actions.acknowledgeActivity}
        dismissActivity={actions.dismissActivity}
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
