import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultSettings,
  type AgentApprovalDecision,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AppSettings,
  type ChatAttachment,
  type ClientCommand,
  type Conversation,
  type ModelSelection,
  type Project,
  type ProviderId,
  type ProviderMaintenanceProviderId,
  type ServerEvent,
  type TurnRequestContext,
  type WorkspaceRun,
} from "@shared/contracts";
import { selectConversationWorkspaceRun } from "../../shared/attention";
import { CommitDialog } from "./components/CommitDialog";
import { AppNavigationOverlays } from "./components/AppNavigationOverlays";
import { AppStatusOverlays } from "./components/AppStatusOverlays";
import { PaneResizeHandle } from "./components/PaneResizeHandle";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import {
  WorkspaceScene,
  type WorkspacePanelTab,
} from "./components/WorkspaceScene";
import { useInertiaConnection } from "./hooks/useInertiaConnection";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useProviderMaintenance } from "./hooks/useProviderMaintenance";
import { useConversationProjection } from "./hooks/useConversationProjection";
import { useBackendProfiles } from "./hooks/useBackendProfiles";
import { useDesktopTools } from "./hooks/useDesktopTools";
import { useActivityActions } from "./hooks/useActivityActions";
import {
  useStableActions,
  useStableController,
} from "./hooks/useStableController";
import { useAppUpdate } from "./app-update";
import { useWorkspaceTools } from "./hooks/useWorkspaceTools";
import { useTheme } from "./hooks/useTheme";
import {
  SIDEBAR_MIN_WIDTH,
  useWorkspaceLayout,
} from "./hooks/useWorkspaceLayout";
import { activityRunSummary } from "./utils/activityCenter";
import { shouldMarkWorkspaceRunSeen } from "./utils/attentionVisibility";
import {
  buildNewConversationPayload,
  type NewConversationLocation,
  withNewConversationModelSelection,
} from "./lib/newConversation";
import { cacheThemePreference, cachedThemePreference, nextQuickTheme } from "./utils/theme";
import { projectNameFromPath } from "./lib/format";
import { applyInterfaceScale } from "./utils/interfaceScale";
import {
  commandRefreshesConversationDetail,
  resultEvent,
  withRequestId,
  type CommandWithoutId,
} from "./lib/runtimeCommands";
import { planFromText } from "./utils/planFromText";
import {
  createWorkspaceSceneModel,
} from "./components/workspace-scene/createWorkspaceSceneModel";
import {
  createWorkspaceTurnActions,
} from "./components/workspace-scene/createWorkspaceTurnActions";

type ConversationCreatePayload = Extract<
  ClientCommand,
  { type: "conversation.create" }
>["payload"];

function useDocumentActive(): boolean {
  const [active, setActive] = useState(
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  useEffect(() => {
    const synchronize = (): void => {
      setActive(document.visibilityState === "visible" && document.hasFocus());
    };
    document.addEventListener("visibilitychange", synchronize);
    window.addEventListener("focus", synchronize);
    window.addEventListener("blur", synchronize);
    return () => {
      document.removeEventListener("visibilitychange", synchronize);
      window.removeEventListener("focus", synchronize);
      window.removeEventListener("blur", synchronize);
    };
  }, []);
  return active;
}

export default function App(): React.JSX.Element {
  const connection = useStableController(useInertiaConnection());
  const sendCommand = connection.sendCommand;
  const appUpdate = useStableController(useAppUpdate());
  const documentActive = useDocumentActive();
  const providerMaintenance = useStableController(
    useProviderMaintenance(
      connection.snapshot,
      sendCommand,
      connection.subscribe,
    ),
  );
  const [view, setView] = useState<"workspace" | "settings">("workspace");
  const [settingsTarget, setSettingsTarget] = useState<{
    section: "providers" | "backends";
    profileId?: string;
  } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [authProviderId, setAuthProviderId] = useState<ProviderId | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityNow, setActivityNow] = useState(Date.now());
  const [latestContentVisible, setLatestContentVisible] = useState(false);
  const [attentionVisibilityVersion, setAttentionVisibilityVersion] = useState(0);
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const pendingSeenRunsRef = useRef(new Set<string>());
  const settings = useMemo(
    () => connection.snapshot?.settings ?? {
      ...defaultSettings,
      theme: cachedThemePreference(window.localStorage) ?? defaultSettings.theme,
    },
    [connection.snapshot?.settings],
  );
  useTheme(settings.theme);

  useEffect(() => {
    const preference = connection.snapshot?.settings.theme;
    if (!preference) return;
    cacheThemePreference(window.localStorage, preference);
    void window.inertia.syncThemePreference(preference).catch(() => undefined);
  }, [connection.snapshot?.settings.theme]);

  useEffect(() => {
    applyInterfaceScale(settings.interfaceScale);
  }, [settings.interfaceScale]);

  useEffect(() => {
    setActivityNow(Date.now());
    const runs = connection.snapshot?.runs ?? [];
    const hasUnfinishedRun = runs.some(({ status }) => status === "running" || status === "waiting");
    if (!hasUnfinishedRun) return;
    const interval = window.setInterval(
      () => setActivityNow(Date.now()),
      activityOpen && hasUnfinishedRun ? 1_000 : 60_000,
    );
    return () => window.clearInterval(interval);
  }, [activityOpen, connection.snapshot?.runs]);

  useEffect(() => {
    const refreshVisibility = () => setAttentionVisibilityVersion((version) => version + 1);
    document.addEventListener("visibilitychange", refreshVisibility);
    window.addEventListener("focus", refreshVisibility);
    window.addEventListener("blur", refreshVisibility);
    return () => {
      document.removeEventListener("visibilitychange", refreshVisibility);
      window.removeEventListener("focus", refreshVisibility);
      window.removeEventListener("blur", refreshVisibility);
    };
  }, []);

  const request = useCallback(
    (command: CommandWithoutId) =>
      sendCommand(withRequestId(command)),
    [sendCommand],
  );
  const project = useMemo(
    () => connection.snapshot?.projects.find((item) => item.id === connection.snapshot?.activeProjectId) ?? null,
    [connection.snapshot],
  );
  const workspaceLayout = useWorkspaceLayout(view, Boolean(project));
  const {
    sidebarOpen,
    setSidebarOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    activeTool,
    setActiveTool,
    mobileNavigation,
    toolsVisible,
    appShellRef,
    workspaceBodyRef,
    appShellStyle,
    workspaceBodyStyle,
    sidebar: sidebarLayout,
  } = workspaceLayout;
  const conversationProjection = useStableController(
    useConversationProjection({
      snapshot: connection.snapshot,
      status: connection.status,
      request,
      subscribe: connection.subscribe,
      autoOpenPlan: settings.autoOpenPlan,
      onOpenPlan: (conversationId) => {
        if (conversationId === connection.snapshot?.activeConversationId) {
          setActiveTool("plan");
        }
      },
      onTerminal: () => setGitRefreshVersion((version) => version + 1),
    }),
  );
  const {
    conversation,
    detail: conversationDetail,
    detailState: conversationDetailState,
    refreshDetail,
    messages,
    streamingText,
    nativePlans,
  } = conversationProjection;
  const authProvider = useMemo(
    () => connection.snapshot?.providers.find(({ id }) => id === authProviderId) ?? null,
    [authProviderId, connection.snapshot?.providers],
  );
  const selectedMaintenanceProviderId = conversation?.providerId as
    | ProviderMaintenanceProviderId
    | undefined;
  const selectedMaintenanceStatus = selectedMaintenanceProviderId
    ? providerMaintenance.statuses.get(selectedMaintenanceProviderId) ?? null
    : null;
  const selectedMaintenanceOperation = selectedMaintenanceProviderId
    ? providerMaintenance.operations.get(selectedMaintenanceProviderId) ?? null
    : null;
  const runsSummary = useMemo(
    () => activityRunSummary(connection.snapshot?.runs ?? [], activityNow),
    [activityNow, connection.snapshot?.runs],
  );
  const visibleConversationRun = useMemo(
    () => conversation
      ? selectConversationWorkspaceRun(conversation.id, connection.snapshot?.runs ?? [])
      : null,
    [connection.snapshot?.runs, conversation],
  );
  const planSteps = useMemo(() => {
    const nativePlan = conversation ? nativePlans[conversation.id] : undefined;
    if (nativePlan) {
      return nativePlan.steps.map((step, index) => ({
        id: `native-${index}`,
        title: step.step,
        status: step.status === "inProgress" ? "in-progress" as const : step.status,
      }));
    }
    const text = [...messages].reverse().find((message) => message.role === "assistant")?.content ?? streamingText;
    return planFromText(text, conversation?.status ?? "idle");
  }, [conversation, messages, nativePlans, streamingText]);

  const run = useCallback(async (key: string, command: CommandWithoutId): Promise<ServerEvent> => {
    setBusyAction(key);
    setActionError(null);
    try {
      const event = await sendCommand(withRequestId(command));
      if (commandRefreshesConversationDetail(command, event)) {
        refreshDetail();
      }
      return event;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That action could not be completed.");
      throw error;
    } finally {
      setBusyAction((current) => current === key ? null : current);
    }
  }, [refreshDetail, sendCommand]);
  const openProjectPath = useCallback((
    pathRequest: Parameters<typeof window.inertia.openProjectPath>[0],
  ) => {
    void window.inertia.openProjectPath(pathRequest)
      .then((error) => {
        if (error) setActionError(error);
      })
      .catch((error) => {
        setActionError(
          error instanceof Error
            ? error.message
            : "The project path could not be opened.",
        );
      });
  }, []);
  const workspaceTools = useStableController(
    useWorkspaceTools({
      project,
      conversation,
      detail: conversationDetail,
      online: connection.status === "online",
      ignoreWhitespace: settings.ignoreWhitespace,
      confirmDestructiveActions: settings.confirmDestructiveActions,
      refreshVersion: gitRefreshVersion,
      request,
      run,
      setActionError,
      setActiveTool,
      openProjectPath,
    }),
  );
  const backendProfileActions = useStableController(
    useBackendProfiles({ request, run }),
  );
  const desktopTools = useStableController(
    useDesktopTools({ setActionError }),
  );
  const { navigatePreview } = desktopTools;
  const {
    gitStatus,
    branches,
    structuredDiff,
    reviewStates,
    loadGit,
    loadBranches,
    mutateBranch,
    commit,
    projectActions,
  } = workspaceTools;

  useEffect(() => {
    const run = visibleConversationRun;
    if (!run || pendingSeenRunsRef.current.has(run.id)) return;
    const shouldMark = shouldMarkWorkspaceRunSeen(
      run,
      view === "workspace" ? conversation?.id ?? null : null,
      {
        documentVisible: document.visibilityState === "visible",
        documentFocused: document.hasFocus(),
        workspaceVisible: view === "workspace",
        latestContentVisible,
        obstructed: activityOpen
          || paletteOpen
          || commitDialogOpen
          || authProviderId !== null
          || (mobileNavigation && sidebarOpen),
      },
    );
    if (!shouldMark) return;
    pendingSeenRunsRef.current.add(run.id);
    void request({
      type: "activity.mark-seen",
      payload: { runId: run.id },
    }).catch(() => undefined).finally(() => {
      pendingSeenRunsRef.current.delete(run.id);
    });
  }, [
    activityOpen,
    attentionVisibilityVersion,
    authProviderId,
    commitDialogOpen,
    conversation?.id,
    latestContentVisible,
    mobileNavigation,
    paletteOpen,
    request,
    sidebarOpen,
    view,
    visibleConversationRun,
  ]);

  const importProject = async () => {
    if (busyAction) return;
    try {
      const path = await window.inertia.selectDirectory();
      if (!path) return;
      await run("project.create", { type: "project.create", payload: { name: projectNameFromPath(path), path } });
      setView("workspace"); setSidebarOpen(false); setActiveTool("terminal");
    } catch { /* The toast carries the error. */ }
  };

  const selectProject = (nextProject: Project) => {
    if (nextProject.id === project?.id) return;
    void run("project.select", { type: "project.select", payload: { projectId: nextProject.id } }).catch(() => undefined);
  };
  const selectConversation = (nextConversation: Conversation) => {
    if (nextConversation.id === conversation?.id) return;
    void run("conversation.select", { type: "conversation.select", payload: { conversationId: nextConversation.id } }).catch(() => undefined);
  };
  const activateActivityContext = (activity: WorkspaceRun, tool?: WorkspacePanelTab) => {
    const targetConversation = connection.snapshot?.conversations.find(({ id }) => id === activity.conversationId);
    const targetProject = connection.snapshot?.projects.find(({ id }) => id === activity.projectId);
    if (targetConversation) selectConversation(targetConversation);
    else if (targetProject) selectProject(targetProject);
    setView("workspace");
    setSidebarOpen(false);
    if (tool) setActiveTool(tool);
  };
  const activityActions = useStableController(
    useActivityActions({
      snapshot: connection.snapshot,
      project,
      conversationId: conversation?.id ?? null,
      request,
      run,
      setActiveTool,
      setActivityOpen,
      setActionError,
      activateContext: activateActivityContext,
      openProjectPath,
      navigatePreview,
    }),
  );
  const {
    runProjectAction,
    openActivityLocation,
    openActivityPreview,
    stopActivity,
    rerunActivity,
    markActivitySeen,
    acknowledgeActivity,
    dismissActivity,
  } = activityActions;
  const createConversation = (
    targetProject: Project | null = project,
    location: NewConversationLocation = { kind: "defaults" },
  ) => {
    if (!targetProject) return;
    const backendDefault = connection.snapshot?.backendDefaults?.find(
      ({ scope, projectId }) =>
        scope === "project" && projectId === targetProject.id,
    ) ?? connection.snapshot?.backendDefaults?.find(({ scope }) =>
      scope === "global");
    const defaultPayload = buildNewConversationPayload(
      targetProject.id,
      settings,
      location,
    );
    const payload: ConversationCreatePayload = backendDefault
      ? withNewConversationModelSelection(
        defaultPayload,
        backendDefault.selection,
      )
      : defaultPayload;
    const select = targetProject.id === project?.id ? Promise.resolve() : run("project.select", { type: "project.select", payload: { projectId: targetProject.id } });
    void select
      .then(() => run("conversation.create", {
        type: "conversation.create",
        payload,
      }))
      .then(() => { setView("workspace"); setSidebarOpen(false); })
      .catch(() => undefined);
  };
  useGlobalShortcuts({
    createConversation: () => createConversation(),
    mobileNavigation,
    setActiveTool,
    setPaletteOpen,
    setSidebarCollapsed,
    setSidebarOpen,
  });
  const createConversationForSelection = async (
    selection: ModelSelection,
  ): Promise<void> => {
    if (!project) throw new Error("Select a project before creating a chat.");
    await run("conversation.create", {
      type: "conversation.create",
      payload: withNewConversationModelSelection(
        buildNewConversationPayload(project.id, settings),
        selection,
      ),
    });
    setView("workspace");
    setSidebarOpen(false);
  };
  const sendMessage = async (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ) => {
    if (!conversation) return;
    await run("message.send", {
      type: "message.send",
      payload: {
        conversationId: conversation.id,
        content,
        attachments,
        ...(context ? { context } : {}),
      },
    });
  };
  const respondToApproval = async (request: AgentApprovalRequest, decision: AgentApprovalDecision) => {
    await run("agent.approval.respond", {
      type: "agent.approval.respond",
      payload: { conversationId: request.conversationId, requestId: request.id, decision },
    });
  };
  const respondToInput = async (request: AgentInputRequest, answers: Record<string, string[]>) => {
    await run("agent.input.respond", {
      type: "agent.input.respond",
      payload: { conversationId: request.conversationId, requestId: request.id, answers },
    });
  };
  const updateConversation = (update: Partial<Pick<Conversation, "providerId" | "modelSelection" | "model" | "reasoningEffort" | "interactionMode" | "accessMode">>) => {
    if (!conversation) return;
    const { modelSelection, ...legacyUpdate } = update;
    const payload = modelSelection
      ? {
          ...legacyUpdate,
          modelSelection: {
            ...modelSelection,
            providerOptions: { ...modelSelection.providerOptions },
            capabilities: modelSelection.capabilities.map((capability) => ({ ...capability })),
          },
        }
      : legacyUpdate;
    void run("conversation.update", { type: "conversation.update", payload: { conversationId: conversation.id, ...payload } }).catch(() => undefined);
  };
  const updateSettings = async (updates: Partial<AppSettings>): Promise<void> => {
    await run("settings.update", { type: "settings.update", payload: updates }).catch(() => undefined);
  };
  const chooseCodexBinary = async (): Promise<void> => {
    const path = await window.inertia.selectCodexExecutable();
    if (path) await updateSettings({ codexBinaryPath: path });
  };
  const cycleTheme = () => updateSettings({
    theme: nextQuickTheme(settings.theme, window.matchMedia("(prefers-color-scheme: dark)").matches),
  });
  const refreshProvider = useCallback((providerId?: ProviderId) => {
    void run("provider.refresh", {
      type: "provider.refresh",
      payload: providerId ? { providerId } : {},
    }).catch(() => undefined);
  }, [run]);
  const connectProvider = useCallback((providerId: ProviderId) => setAuthProviderId(providerId), []);
  const closeProviderAuth = useCallback(() => setAuthProviderId(null), []);
  const openProviderSetup = useCallback((_providerId: ProviderId) => {
    setSettingsTarget({ section: "providers" });
    setView("settings");
  }, []);
  const openBackendSetup = useCallback((profileId: string) => {
    setSettingsTarget({ section: "backends", profileId });
    setView("settings");
  }, []);

  useEffect(() => {
    if (view === "workspace" && settingsTarget) setSettingsTarget(null);
  }, [settingsTarget, view]);

  const visibleError = actionError ?? connection.error;
  const visibleConversationDetailState = conversationDetailState?.conversationId === conversation?.id
    ? conversationDetailState
    : null;
  const detailLoading = Boolean(
    conversation
    && (!visibleConversationDetailState || visibleConversationDetailState.state === "loading"),
  );
  const platform = window.inertia?.getPlatform() ?? "unknown";
  const turnSceneActions = createWorkspaceTurnActions({
    conversation,
    confirmDestructiveActions: settings.confirmDestructiveActions,
    run,
    loadGit: workspaceTools.loadGit,
    openTurnDiff: workspaceTools.openTurnDiff,
    compareTurnArtifacts: workspaceTools.compareTurnArtifacts,
  });
  const workspaceSceneActions = useStableActions({
      importProject,
      createConversation,
      createConversationForSelection,
      sendMessage,
      respondToApproval,
      respondToInput,
      updateConversation,
      updateSettings,
      chooseCodexBinary,
      refreshProvider,
      connectProvider,
      openProviderSetup,
      openBackendSetup,
      openProjectPath,
      ...turnSceneActions,
      run,
  });
  const workspaceScene = useMemo(() => createWorkspaceSceneModel({
    view,
    settingsTarget,
    settings,
    busyAction,
    project,
    connection,
    providerMaintenance,
    projection: conversationProjection,
    layout: workspaceLayout,
    workspaceTools,
    backendProfileActions,
    desktopTools,
    activityActions,
    appUpdate,
    planSteps,
    detailLoading,
    selectedMaintenanceStatus,
    selectedMaintenanceOperation,
    actions: workspaceSceneActions,
    setActionError,
    setLatestContentVisible,
  }), [
    activityActions,
    appUpdate,
    backendProfileActions,
    busyAction,
    connection,
    conversationProjection,
    desktopTools,
    detailLoading,
    planSteps,
    project,
    providerMaintenance,
    selectedMaintenanceOperation,
    selectedMaintenanceStatus,
    settings,
    settingsTarget,
    view,
    workspaceLayout,
    workspaceSceneActions,
    workspaceTools,
  ]);

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
      {(mobileNavigation || !sidebarCollapsed) && <Sidebar
        snapshot={connection.snapshot}
        connectionStatus={connection.status}
        view={view}
        open={sidebarOpen}
        busy={busyAction === "project.create"}
        onClose={() => setSidebarOpen(false)}
        onViewChange={setView}
        onImportProject={() => void importProject()}
        onSelectProject={selectProject}
        onSelectConversation={selectConversation}
        onCreateConversation={createConversation}
        onRenameConversation={(thread, title) => {
          void run("conversation.update", {
            type: "conversation.update",
            payload: { conversationId: thread.id, title },
          }).catch(() => undefined);
        }}
        onArchiveConversation={(thread) => { void run("conversation.archive", { type: "conversation.archive", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onSettleConversation={(thread) => { void run("conversation.settle", { type: "conversation.settle", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onRestoreConversation={(thread) => { void run("conversation.unsettle", { type: "conversation.unsettle", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onDeleteConversation={(thread) => {
          const confirmed = !settings.confirmDestructiveActions
            || window.confirm(`Delete “${thread.title}”? This cannot be undone.`);
          if (confirmed) {
            void run("conversation.delete", {
              type: "conversation.delete",
              payload: { conversationId: thread.id },
            }).catch(() => undefined);
          }
        }}
        onAcknowledgeRun={acknowledgeActivity}
        onDismissRun={dismissActivity}
        onOpenProject={(item) => openProjectPath({ projectId: item.id, relativePath: ".", action: "open-externally" })}
        onRenameProject={(item, name) => { void run("project.update", { type: "project.update", payload: { projectId: item.id, name } }).catch(() => undefined); }}
        onSetProjectGrouping={(item, groupingMode) => {
          void run("project.update", {
            type: "project.update",
            payload: { projectId: item.id, groupingMode },
          }).catch(() => undefined);
        }}
        onSetProjectGitRepositoryLimit={(item, gitRepositoryLimit) => {
          void run("project.update", {
            type: "project.update",
            payload: { projectId: item.id, gitRepositoryLimit },
          }).catch(() => undefined);
        }}
        onSidebarModeChange={(sidebarMode) => updateSettings({ sidebarMode })}
        onRemoveProject={(item) => {
          const confirmed = !settings.confirmDestructiveActions
            || window.confirm(
              `Remove “${item.name}” from Inertia? Files on disk will not be deleted.`,
            );
          if (confirmed) {
            void run("project.remove", {
              type: "project.remove",
              payload: { projectId: item.id },
            }).catch(() => undefined);
          }
        }}
      />}

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
        inert={mobileNavigation && sidebarOpen ? true : undefined}
      >
        <div className="workspace-frame">
          <WorkspaceHeader
            project={project}
            conversation={conversation}
            view={view}
            activeTool={activeTool}
            sidebarCollapsed={sidebarCollapsed}
            theme={settings.theme}
            gitStatus={gitStatus}
            branches={branches}
            actions={projectActions}
            busy={Boolean(busyAction)}
            activityOpen={activityOpen}
            activeRunCount={runsSummary.activeCount}
            attentionRunCount={runsSummary.attentionCount}
            onOpenSidebar={() => {
              if (mobileNavigation) setSidebarOpen(true);
              else setSidebarCollapsed((collapsed) => !collapsed);
            }}
            onToggleTools={() => setActiveTool((tool) => tool ? null : "terminal")}
            onCycleTheme={cycleTheme}
            onOpenSettings={() => setView("settings")}
            onToggleActivity={() => setActivityOpen((open) => !open)}
            onOpenProject={() => { if (project) openProjectPath({ projectId: project.id, relativePath: ".", action: "open-externally" }); }} onRefreshBranches={loadBranches}
            onSwitchBranch={(name) => mutateBranch("git.branch.switch", name)}
            onCreateBranch={(name) => mutateBranch("git.branch.create", name)}
            onCommit={() => setCommitDialogOpen(true)}
            onRunAction={runProjectAction}
            onCreateConversationOnBranch={(branch) => createConversation(project, { kind: "branch", branch })}
            onCreateConversationInWorktree={() => {
              if (conversation?.worktreePath) {
                createConversation(project, { kind: "worktree", branch: gitStatus?.branch ?? conversation.branch, path: conversation.worktreePath });
              }
            }}
            onCreateConversationInIsolatedWorktree={() => createConversation(project, { kind: "isolated-worktree" })}
            onOpenPullRequest={() => {
              if (!project) return;
              void run("git.pr.open", {
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
              void run("git.pull", {
                type: "git.pull",
                payload: {
                  projectId: project.id,
                  conversationId: conversation?.id,
                },
              }).then(() => loadGit()).catch(() => undefined);
            }}
          />

          <div
            ref={workspaceBodyRef}
            id="workspace-content"
            className={toolsVisible ? "workspace-body has-tools" : "workspace-body"}
            style={workspaceBodyStyle}
          >
            <WorkspaceScene {...workspaceScene} />
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
          await commit(...args);
          setCommitDialogOpen(false);
        }}
      />
      <AppNavigationOverlays
        snapshot={connection.snapshot}
        activityOpen={activityOpen}
        paletteOpen={paletteOpen}
        now={activityNow}
        setActivityOpen={setActivityOpen}
        setPaletteOpen={setPaletteOpen}
        setWorkspaceView={() => setView("workspace")}
        selectProject={selectProject}
        selectConversation={selectConversation}
        createConversation={() => createConversation()}
        importProject={importProject}
        activateActivityContext={activateActivityContext}
        openActivityLocation={openActivityLocation}
        openActivityPreview={openActivityPreview}
        stopActivity={stopActivity}
        rerunActivity={rerunActivity}
        markActivitySeen={markActivitySeen}
        acknowledgeActivity={acknowledgeActivity}
        dismissActivity={dismissActivity}
        openSettings={() => setView("settings")}
      />
      <AppStatusOverlays
        providerAuth={{
          provider: authProvider,
          status: connection.status,
          theme: settings.theme,
          fontSize: settings.terminalFontSize,
          sendCommand,
          subscribe: connection.subscribe,
          onClose: closeProviderAuth,
        }}
        appUpdate={appUpdate}
        error={visibleError}
        onDismissError={() => {
          setActionError(null);
          connection.clearError();
        }}
      />
    </div>
  );
}
