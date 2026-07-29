import type {
  Dispatch,
  SetStateAction,
} from "react";
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

import type { useAppUpdate } from "../app-update";
import type { useInertiaConnection } from "../hooks/useInertiaConnection";
import type { ProviderQuotaNoticeController } from "../hooks/useProviderQuotaNotices";
import type { useWorkspaceLayout } from "../hooks/useWorkspaceLayout";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { NewConversationLocation } from "../lib/newConversation";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { ActivityRunSummary } from "../utils/activityCenter";
import type { EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { AppNavigationOverlays } from "./AppNavigationOverlays";
import { AppStatusOverlays } from "./AppStatusOverlays";
import { CommitDialog } from "./CommitDialog";
import {
  MultiSpawnDialog,
} from "./MultiSpawnDialog";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { Sidebar } from "./Sidebar";
import { WorkspaceHeader } from "./WorkspaceHeader";
import {
  WorkspaceScene,
  type WorkspacePanelTab,
  type WorkspaceSceneProps,
} from "./WorkspaceScene";
import { SIDEBAR_MIN_WIDTH } from "../hooks/useWorkspaceLayout";
import { resultEvent } from "../lib/runtimeCommands";
import type { MultiSpawnController } from "../hooks/useMultiSpawn";

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
  setView: Dispatch<SetStateAction<"workspace" | "settings">>;
  busyAction: string | null;
  visibleError: string | null;
  setActionError: Dispatch<SetStateAction<string | null>>;
  commitDialogOpen: boolean;
  setCommitDialogOpen: Dispatch<SetStateAction<boolean>>;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  activityOpen: boolean;
  setActivityOpen: Dispatch<SetStateAction<boolean>>;
  activityNow: number;
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
  reviewStates: Parameters<typeof CommitDialog>[0]["reviewStates"];
  structuredDiff: Parameters<typeof CommitDialog>[0]["diff"];
  multiSpawn: MultiSpawnController;
  scene: WorkspaceSceneProps;
  providerAuth: Parameters<typeof AppStatusOverlays>[0]["providerAuth"];
  actions: AppLayoutActions;
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
  activityNow,
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
  multiSpawn,
  scene,
  providerAuth,
  actions,
}: AppLayoutProps): React.JSX.Element {
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
  useNativePreviewSuspension(
    Boolean(visibleError)
      || providerQuotaNotices.notices.length > 0
      || Boolean(appUpdate.visible && appUpdate.status),
  );

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
      style={appShellStyle}
    >
      {(mobileNavigation || !sidebarCollapsed) && (
        <Sidebar
          snapshot={connection.snapshot}
          connectionStatus={connection.status}
          view={view}
          open={sidebarOpen}
          busy={busyAction === "project.create"}
          onClose={() => setSidebarOpen(false)}
          onViewChange={setView}
          onImportProject={() => void actions.importProject()}
          onSelectProject={actions.selectProject}
          onSelectConversation={actions.selectConversation}
          splitConversationId={splitConversationId}
          onOpenConversationInSplit={actions.openConversationInSplit}
          onCloseConversationSplit={actions.closeConversationSplit}
          onCreateConversation={actions.createConversation}
          onOpenMultiSpawn={multiSpawn.openDialog}
          onRenameConversation={(thread, title) => {
            void actions.run("conversation.update", {
              type: "conversation.update",
              payload: { conversationId: thread.id, title },
            }).catch(() => undefined);
          }}
          onArchiveConversation={(thread) => {
            void actions.run("conversation.archive", {
              type: "conversation.archive",
              payload: { conversationId: thread.id },
            }).catch(() => undefined);
          }}
          onSettleConversation={(thread) => {
            void actions.run("conversation.settle", {
              type: "conversation.settle",
              payload: { conversationId: thread.id },
            }).catch(() => undefined);
          }}
          onRestoreConversation={(thread) => {
            void actions.run("conversation.unsettle", {
              type: "conversation.unsettle",
              payload: { conversationId: thread.id },
            }).catch(() => undefined);
          }}
          onDeleteConversation={(thread) => {
            const confirmed = !settings.confirmDestructiveActions
              || window.confirm(`Delete “${thread.title}”? This cannot be undone.`);
            if (confirmed) {
              void actions.run("conversation.delete", {
                type: "conversation.delete",
                payload: { conversationId: thread.id },
              }).catch(() => undefined);
            }
          }}
          onAcknowledgeRun={actions.acknowledgeActivity}
          onDismissRun={actions.dismissActivity}
          onOpenProject={(item) => actions.openProjectPath({
            projectId: item.id,
            relativePath: ".",
            action: "open-externally",
          })}
          onRenameProject={(item, name) => {
            void actions.run("project.update", {
              type: "project.update",
              payload: { projectId: item.id, name },
            }).catch(() => undefined);
          }}
          onSetProjectGrouping={(item, groupingMode) => {
            void actions.run("project.update", {
              type: "project.update",
              payload: { projectId: item.id, groupingMode },
            }).catch(() => undefined);
          }}
          onSetProjectGitRepositoryLimit={(item, gitRepositoryLimit) => {
            void actions.run("project.update", {
              type: "project.update",
              payload: { projectId: item.id, gitRepositoryLimit },
            }).catch(() => undefined);
          }}
          onSidebarModeChange={(sidebarMode) => {
            void actions.updateSettings({ sidebarMode });
          }}
          onRemoveProject={(item) => {
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
          }}
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
              void actions.run("git.pr.open", {
                type: "git.pr.open",
                payload: {
                  projectId: project.id,
                  conversationId: conversation?.id,
                },
              }).then(resultEvent).then((event) => {
                if (event.result.kind === "external.url") {
                  return window.inertia.openExternal(event.result.url);
                }
              }).catch(() => undefined);
            }}
            onPull={() => {
              if (!project) return;
              void actions.run("git.pull", {
                type: "git.pull",
                payload: {
                  projectId: project.id,
                  conversationId: conversation?.id,
                },
              }).then(() => actions.loadGit()).catch(() => undefined);
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

      <CommitDialog
        open={commitDialogOpen}
        repositoryPath="."
        status={gitStatus}
        reviewStates={reviewStates}
        diff={structuredDiff}
        busy={busyAction === "git.commit" || busyAction === "git.push"}
        onClose={() => setCommitDialogOpen(false)}
        onCommit={async (...args) => {
          await actions.commit(...args);
          setCommitDialogOpen(false);
        }}
      />
      <MultiSpawnDialog
        open={multiSpawn.open}
        snapshot={connection.snapshot}
        settings={settings}
        submitting={multiSpawn.submitting}
        error={multiSpawn.error}
        onClose={multiSpawn.closeDialog}
        onSubmit={multiSpawn.submit}
        onOpenProviderSetup={actions.openProviderSetup}
        onOpenBackendSetup={actions.openBackendSetup}
      />
      <AppNavigationOverlays
        snapshot={connection.snapshot}
        activityOpen={activityOpen}
        paletteOpen={paletteOpen}
        now={activityNow}
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
      />
    </div>
  );
}
