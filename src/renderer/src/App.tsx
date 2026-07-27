import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
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
import { ActivityCenter } from "./components/ActivityCenter";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { CommandPalette } from "./components/CommandPalette";
import { CommitDialog } from "./components/CommitDialog";
import { ConversationDetailState } from "./components/ConversationDetailState";
import { FilesPanel } from "./components/FilesPanel";
import { HistoricalDiffPanel } from "./components/HistoricalDiffPanel";
import { PaneResizeHandle } from "./components/PaneResizeHandle";
import { PlanPanel } from "./components/PlanPanel";
import { PreviewPanel } from "./components/PreviewPanel";
import { ProviderAuthDialog } from "./components/ProviderAuthDialog";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { WorkspaceChangesPanel } from "./components/WorkspaceChangesPanel";
import { WorkspacePanel, type WorkspacePanelTab } from "./components/WorkspacePanel";
import { IconButton } from "./components/ui";
import { useInertiaConnection } from "./hooks/useInertiaConnection";
import { useProviderMaintenance } from "./hooks/useProviderMaintenance";
import { useConversationProjection } from "./hooks/useConversationProjection";
import { useBackendProfiles } from "./hooks/useBackendProfiles";
import { useDesktopTools } from "./hooks/useDesktopTools";
import { useActivityActions } from "./hooks/useActivityActions";
import { useWorkspaceTools } from "./hooks/useWorkspaceTools";
import { useTheme } from "./hooks/useTheme";
import {
  SIDEBAR_MIN_WIDTH,
  TOOLS_MIN_HEIGHT,
  TOOLS_MIN_WIDTH,
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

type ConversationCreatePayload = Extract<
  ClientCommand,
  { type: "conversation.create" }
>["payload"];


export default function App(): React.JSX.Element {
  const connection = useInertiaConnection();
  const providerMaintenance = useProviderMaintenance(
    connection.snapshot?.providers ?? [],
    connection.sendCommand,
    connection.subscribe,
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
  const settings = connection.snapshot?.settings ?? {
    ...defaultSettings,
    theme: cachedThemePreference(window.localStorage) ?? defaultSettings.theme,
  };
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
      connection.sendCommand(withRequestId(command)),
    [connection.sendCommand],
  );
  const project = useMemo(
    () => connection.snapshot?.projects.find((item) => item.id === connection.snapshot?.activeProjectId) ?? null,
    [connection.snapshot],
  );
  const {
    sidebarOpen,
    setSidebarOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    activeTool,
    setActiveTool,
    stackedTools,
    mobileNavigation,
    toolsVisible,
    appShellRef,
    workspaceBodyRef,
    appShellStyle,
    workspaceBodyStyle,
    sidebar: sidebarLayout,
    tools: toolsLayout,
  } = useWorkspaceLayout(view, Boolean(project));
  const {
    conversation,
    detail: conversationDetail,
    detailState: conversationDetailState,
    refreshDetail,
    turns,
    messages,
    activities,
    subagents,
    reasonings,
    plans,
    checkpoints,
    turnGitArtifacts,
    usage,
    streamingText,
    streamingReasoning,
    pendingApprovals,
    pendingInputs,
    nativePlans,
  } = useConversationProjection({
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
  });
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
      const event = await connection.sendCommand(withRequestId(command));
      if (commandRefreshesConversationDetail(command)) {
        refreshDetail();
      }
      return event;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That action could not be completed.");
      throw error;
    } finally {
      setBusyAction((current) => current === key ? null : current);
    }
  }, [connection.sendCommand, refreshDetail]);
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
  const workspaceTools = useWorkspaceTools({
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
  });
  const {
    loadBackendProfile,
    createBackendProfile,
    updateBackendProfile,
    setBackendCredential,
    clearBackendCredential,
    probeBackendProfile,
    deleteBackendProfile,
    setBackendDefault,
    clearBackendDefault,
  } = useBackendProfiles({ request, run });
  const {
    previewUrl,
    previewNavigation,
    chooseComposerAttachments,
    importComposerAttachments,
    releaseComposerAttachment,
    navigatePreview,
    previewCommand,
    setPreviewBounds,
  } = useDesktopTools({ setActionError });
  const {
    gitStatus,
    workspaceGitStatus,
    historicalDiff,
    historicalSelectedPath,
    setHistoricalSelectedPath,
    branches,
    workspaceEntries,
    mentionResults,
    entriesTruncated,
    filePreview,
    selectedFile,
    filesLoading,
    filesError,
    filePreviewLoading,
    filePreviewError,
    projectActions,
    toolsLoading,
    pendingDiffContext,
    setPendingDiffContext,
    lastDiffReversal,
    selectionReviewAnswer,
    setSelectionReviewAnswer,
    structuredDiff,
    reviewSummary,
    reviewStates,
    reviewNotes,
    loadGit,
    loadWorkspaceRepositoryDiff,
    requestWorkspaceEntries,
    loadFiles,
    loadBranches,
    mutateBranch,
    commit,
    askAboutDiff,
    requestDiffRevision,
    setDiffReviewState,
    createDiffReviewNote,
    updateDiffReviewNote,
    deleteDiffReviewNote,
    revertDiffSelection,
    undoDiffReversal,
    generateReviewSummary,
    cancelReviewSummary,
    selectWorkspaceFile,
    searchMentions,
    openTurnDiff,
    compareTurnArtifacts,
    openTurnFile,
    showCurrentChanges,
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

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); createConversation(); }
      if (event.key.toLowerCase() === "j") { event.preventDefault(); setActiveTool((tool) => tool === "terminal" ? null : "terminal"); }
      if (event.key.toLowerCase() === "b") { event.preventDefault(); if (mobileNavigation) setSidebarOpen(true); else setSidebarCollapsed((collapsed) => !collapsed); }
    };
    // Capture app-wide shortcuts before focused widgets such as xterm can
    // consume platform combinations like Ctrl+K.
    window.addEventListener("keydown", shortcuts, true);
    return () => window.removeEventListener("keydown", shortcuts, true);
  });

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
  const {
    pendingActionId,
    clearPendingAction,
    runProjectAction,
    openActivityLocation,
    openActivityPreview,
    stopActivity,
    rerunActivity,
    markActivitySeen,
    acknowledgeActivity,
    dismissActivity,
  } = useActivityActions({
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
  });
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
  const detailUnavailable = visibleConversationDetailState
    && visibleConversationDetailState.state !== "loading"
    && visibleConversationDetailState.state !== "ready"
      ? visibleConversationDetailState
      : null;
  const detailLoading = Boolean(
    conversation
    && (!visibleConversationDetailState || visibleConversationDetailState.state === "loading"),
  );
  const platform = window.inertia?.getPlatform() ?? "unknown";

  return (
    <div ref={appShellRef} className={`app-shell platform-${platform}${sidebarCollapsed && !mobileNavigation ? " is-sidebar-collapsed" : ""}`} data-interface-scale={settings.interfaceScale} data-runtime-generation={connection.runtimeGeneration ?? undefined} data-connection-status={connection.status} style={appShellStyle}>
      {(mobileNavigation || !sidebarCollapsed) && <Sidebar
        snapshot={connection.snapshot} connectionStatus={connection.status} view={view} open={sidebarOpen} busy={busyAction === "project.create"}
        onClose={() => setSidebarOpen(false)} onViewChange={setView} onImportProject={() => void importProject()} onSelectProject={selectProject} onSelectConversation={selectConversation} onCreateConversation={createConversation}
        onRenameConversation={(thread, title) => { void run("conversation.update", { type: "conversation.update", payload: { conversationId: thread.id, title } }).catch(() => undefined); }}
        onArchiveConversation={(thread) => { void run("conversation.archive", { type: "conversation.archive", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onSettleConversation={(thread) => { void run("conversation.settle", { type: "conversation.settle", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onRestoreConversation={(thread) => { void run("conversation.unsettle", { type: "conversation.unsettle", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onDeleteConversation={(thread) => { if (!settings.confirmDestructiveActions || window.confirm(`Delete “${thread.title}”? This cannot be undone.`)) void run("conversation.delete", { type: "conversation.delete", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onAcknowledgeRun={acknowledgeActivity}
        onDismissRun={dismissActivity}
        onOpenProject={(item) => openProjectPath({ projectId: item.id, relativePath: ".", action: "open-externally" })}
        onRenameProject={(item, name) => { void run("project.update", { type: "project.update", payload: { projectId: item.id, name } }).catch(() => undefined); }}
        onSetProjectGrouping={(item, groupingMode) => { void run("project.update", { type: "project.update", payload: { projectId: item.id, groupingMode } }).catch(() => undefined); }}
        onSidebarModeChange={(sidebarMode) => updateSettings({ sidebarMode })}
        onRemoveProject={(item) => { if (!settings.confirmDestructiveActions || window.confirm(`Remove “${item.name}” from Inertia? Files on disk will not be deleted.`)) void run("project.remove", { type: "project.remove", payload: { projectId: item.id } }).catch(() => undefined); }}
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
            project={project} conversation={conversation} view={view} activeTool={activeTool} sidebarCollapsed={sidebarCollapsed} theme={settings.theme} gitStatus={gitStatus} branches={branches} actions={projectActions} busy={Boolean(busyAction)}
            activityOpen={activityOpen} activeRunCount={runsSummary.activeCount} attentionRunCount={runsSummary.attentionCount}
            onOpenSidebar={() => { if (mobileNavigation) setSidebarOpen(true); else setSidebarCollapsed((collapsed) => !collapsed); }} onToggleTools={() => setActiveTool((tool) => tool ? null : "terminal")} onCycleTheme={cycleTheme} onOpenSettings={() => setView("settings")}
            onToggleActivity={() => setActivityOpen((open) => !open)}
            onOpenProject={() => { if (project) openProjectPath({ projectId: project.id, relativePath: ".", action: "open-externally" }); }} onRefreshBranches={loadBranches}
            onSwitchBranch={(name) => mutateBranch("git.branch.switch", name)} onCreateBranch={(name) => mutateBranch("git.branch.create", name)} onCommit={() => setCommitDialogOpen(true)} onRunAction={runProjectAction}
            onCreateConversationOnBranch={(branch) => createConversation(project, { kind: "branch", branch })}
            onCreateConversationInWorktree={() => {
              if (conversation?.worktreePath) {
                createConversation(project, { kind: "worktree", branch: gitStatus?.branch ?? conversation.branch, path: conversation.worktreePath });
              }
            }}
            onCreateConversationInIsolatedWorktree={() => createConversation(project, { kind: "isolated-worktree" })}
            onOpenPullRequest={() => { if (project) void run("git.pr.open", { type: "git.pr.open", payload: { projectId: project.id, conversationId: conversation?.id } }).then(resultEvent).then((event) => { if (event.result.kind === "external.url") return window.inertia.openExternal(event.result.url); }).catch(() => undefined); }}
            onPull={() => { if (project) void run("git.pull", { type: "git.pull", payload: { projectId: project.id, conversationId: conversation?.id } }).then(() => loadGit()).catch(() => undefined); }}
          />

          <div
            ref={workspaceBodyRef}
            id="workspace-content"
            className={toolsVisible ? "workspace-body has-tools" : "workspace-body"}
            style={workspaceBodyStyle}
          >
            {view === "settings" ? (
              <SettingsView
                target={settingsTarget}
                settings={settings}
                disabled={connection.status !== "online"}
                providers={connection.snapshot?.providers ?? []}
                maintenanceStatuses={providerMaintenance.statuses}
                maintenanceOperations={providerMaintenance.operations}
                backendProfiles={connection.snapshot?.backendProfiles ?? []}
                backendDefaults={connection.snapshot?.backendDefaults ?? []}
                projects={connection.snapshot?.projects ?? []}
                archived={connection.snapshot?.conversations.filter(({ archivedAt }) => archivedAt !== null) ?? []}
                onUpdate={updateSettings}
                onConnectProvider={connectProvider}
                onRefreshProvider={(providerId) => {
                  refreshProvider(providerId);
                  void providerMaintenance.refresh(
                    providerId as ProviderMaintenanceProviderId | undefined,
                    true,
                  ).catch(() => undefined);
                }}
                onRefreshProviderMaintenance={(providerId) =>
                  providerMaintenance.refresh(providerId, true)}
                onUpdateProvider={providerMaintenance.update}
                onCancelProviderUpdate={providerMaintenance.cancel}
                onOpenProviderUpdateInstructions={(url) => {
                  void window.inertia.openExternal(url).catch(() => undefined);
                }}
                onChooseCodexBinary={() => { void chooseCodexBinary().catch(() => undefined); }}
                onRevealRuntimeLogs={() => window.inertia.revealRuntimeLogs()}
                onUnarchive={(thread) => { void run("conversation.unarchive", { type: "conversation.unarchive", payload: { conversationId: thread.id } }).catch(() => undefined); }}
                onLoadBackendProfile={loadBackendProfile}
                onCreateBackendProfile={createBackendProfile}
                onUpdateBackendProfile={updateBackendProfile}
                onSetBackendCredential={setBackendCredential}
                onClearBackendCredential={clearBackendCredential}
                onProbeBackendProfile={probeBackendProfile}
                onDeleteBackendProfile={deleteBackendProfile}
                onSetBackendDefault={setBackendDefault}
                onClearBackendDefault={clearBackendDefault}
              />
            ) : detailUnavailable ? (
              <ConversationDetailState
                state={detailUnavailable.state}
                message={detailUnavailable.state === "failed" ? detailUnavailable.message : undefined}
                onRetry={refreshDetail}
              />
            ) : (
              <ChatWorkspace project={project} conversation={conversationDetail?.conversation ?? null} turns={turns} messages={messages} activities={activities} subagents={subagents} reasonings={reasonings} plans={plans} checkpoints={checkpoints} turnGitArtifacts={turnGitArtifacts} streamingText={streamingText} streamingReasoning={streamingReasoning} usage={usage} approvals={pendingApprovals.filter((request) => request.conversationId === conversation?.id)} inputRequests={pendingInputs.filter((request) => request.conversationId === conversation?.id)} providers={connection.snapshot?.providers ?? []} backendProfiles={connection.snapshot?.backendProfiles ?? []} maintenanceStatus={selectedMaintenanceStatus} maintenanceOperation={selectedMaintenanceOperation} actions={projectActions} mentionResults={mentionResults} showTimestamps={settings.showTimestamps} showThinking={settings.showThinking} usageDisplayMode={settings.usageDisplayMode} responseDensity={settings.responseDensity} defaultCodeWrap={settings.defaultCodeWrap} autoCollapseWorkLog={settings.autoCollapseWorkLog} showChangedFileSummaries={settings.showChangedFileSummaries} promptContext={pendingDiffContext} loading={(!connection.snapshot && connection.status !== "offline") || detailLoading} sending={busyAction === "message.send"} onAddProject={() => void importProject()} onCreateConversation={() => createConversation()} onSendMessage={sendMessage} onRespondToApproval={respondToApproval} onRespondToInput={respondToInput} onUpdateConversation={updateConversation} onCreateConversationForSelection={createConversationForSelection} onChooseAttachments={chooseComposerAttachments} onImportAttachments={importComposerAttachments} onReleaseAttachment={releaseComposerAttachment} onRunAction={runProjectAction} onMentionQuery={searchMentions} onConnectProvider={connectProvider} onRefreshProvider={refreshProvider} onOpenProviderSetup={openProviderSetup} onOpenBackendSetup={openBackendSetup} onProbeBackendProfile={async (profileId, modelId) => { await probeBackendProfile(profileId, modelId); }} onRefreshProviderMaintenance={() => selectedMaintenanceProviderId ? providerMaintenance.refresh(selectedMaintenanceProviderId, true) : Promise.resolve()} onUpdateProvider={() => selectedMaintenanceProviderId ? providerMaintenance.update(selectedMaintenanceProviderId) : Promise.resolve()} onCancelProviderUpdate={providerMaintenance.cancel} onOpenProviderUpdateInstructions={(url) => { void window.inertia.openExternal(url).catch(() => undefined); }} onUsageDisplayModeChange={(usageDisplayMode) => void updateSettings({ usageDisplayMode })} onClearPromptContext={() => setPendingDiffContext(null)} onLatestContentVisibilityChange={setLatestContentVisible} onOpenTurnDiff={(turnId, path) => { void openTurnDiff(turnId, path); }} onCompareTurnArtifacts={(earlierTurnId, laterTurnId) => { void compareTurnArtifacts(earlierTurnId, laterTurnId); }} onOpenTurnFile={openTurnFile} onRevertCheckpoint={(checkpoint) => { if (conversation && (!settings.confirmDestructiveActions || window.confirm("Restore the project to before this turn? Untracked files created later will be left in place."))) void run("checkpoint.revert", { type: "checkpoint.revert", payload: { conversationId: conversation.id, checkpointId: checkpoint.id } }).then(() => loadGit()).catch(() => undefined); }} onStopSubagent={(trace) => run(`agent.subagent.stop:${trace.id}`, { type: "agent.subagent.stop", payload: { conversationId: trace.conversationId, traceId: trace.id } }).then(() => undefined)} onStop={() => conversation ? run("agent.stop", { type: "agent.stop", payload: { conversationId: conversation.id } }).then(() => undefined) : Promise.resolve()} />
            )}

            {toolsVisible && (
              <PaneResizeHandle
                label="Resize workspace tools"
                controls="workspace-content"
                containerRef={workspaceBodyRef}
                orientation={stackedTools ? "horizontal" : "vertical"}
                pane="after"
                value={stackedTools ? toolsLayout.height : toolsLayout.width}
                min={stackedTools ? TOOLS_MIN_HEIGHT : TOOLS_MIN_WIDTH}
                max={stackedTools ? toolsLayout.maxHeight : toolsLayout.maxWidth}
                defaultValue={stackedTools ? 320 : 520}
                onChange={stackedTools ? toolsLayout.onHeightChange : toolsLayout.onWidthChange}
                onCommit={stackedTools ? toolsLayout.onHeightCommit : toolsLayout.onWidthCommit}
                valueText={(value) => `${value} pixels for workspace tools`}
                className="workspace-tools-resize-handle"
              />
            )}
            {project && (
              <WorkspacePanel activeTab={activeTool ?? "terminal"} visible={toolsVisible} onTabChange={setActiveTool} badges={{ changes: workspaceGitStatus?.files ?? 0, plan: planSteps.length }} onClose={() => setActiveTool(null)}>
                {activeTool === "changes" && (historicalDiff
                  ? <HistoricalDiffPanel diff={historicalDiff} selectedPath={historicalSelectedPath} wrapLines={settings.wrapDiffs} onSelectFile={setHistoricalSelectedPath} onOpenFile={openTurnFile} onShowCurrentChanges={showCurrentChanges} />
                  : <WorkspaceChangesPanel projectName={project.name} snapshot={workspaceGitStatus} loading={toolsLoading} summary={reviewSummary} selectionAnswer={selectionReviewAnswer} reviewStates={reviewStates} notes={reviewNotes} summaryLoading={busyAction === "review.summary.generate"} wrapLines={settings.wrapDiffs} lastReversal={lastDiffReversal} onRefresh={() => void loadGit().catch((error) => setActionError(error instanceof Error ? error.message : "Changes could not be refreshed."))} onLoadRepositoryDiff={loadWorkspaceRepositoryDiff} onOpenWorkspaceFile={(relativePath) => openProjectPath({ projectId: project.id, ...(conversation ? { conversationId: conversation.id } : {}), relativePath, action: "open-externally" })} onGenerateSummary={generateReviewSummary} onCancelSummary={cancelReviewSummary} onAsk={askAboutDiff} onRequestRevision={requestDiffRevision} onRevert={revertDiffSelection} onUndoReversal={undoDiffReversal} onDismissSelectionAnswer={() => setSelectionReviewAnswer(null)} onSetReviewState={setDiffReviewState} onCreateNote={createDiffReviewNote} onUpdateNote={updateDiffReviewNote} onDeleteNote={deleteDiffReviewNote} onAddTextToPrompt={setPendingDiffContext} onAddToPrompt={(selection) => setPendingDiffContext(selection.reference)} />)}
                {activeTool === "files" && <FilesPanel key={`files:${project.id}:${conversation?.id ?? "project"}`} entries={workspaceEntries} preview={filePreview} selectedPath={selectedFile} loading={filesLoading} previewLoading={filePreviewLoading} error={filesError} previewError={filePreviewError} entriesTruncated={entriesTruncated} onSelectFile={selectWorkspaceFile} onLoadEntries={requestWorkspaceEntries} onRefresh={() => void loadFiles().catch((error) => setActionError(error instanceof Error ? error.message : "Files could not be refreshed."))} onOpenFile={(path) => openProjectPath({ projectId: project.id, ...(conversation ? { conversationId: conversation.id } : {}), relativePath: path, action: "open-externally" })} />}
                <TerminalPanel key={`${project.id}:${conversation?.id ?? "project"}`} visible={toolsVisible && activeTool === "terminal"} projectId={project.id} conversationId={conversation?.id} projectName={project.name} status={connection.status} fontSize={settings.terminalFontSize} theme={settings.theme} sendCommand={connection.sendCommand} subscribe={connection.subscribe} actionId={pendingActionId} onActionStarted={clearPendingAction} onClose={() => setActiveTool(null)} />
                {activeTool === "plan" && <PlanPanel steps={planSteps} summary={conversation && nativePlans[conversation.id]?.explanation ? nativePlans[conversation.id].explanation! : conversation?.interactionMode === "plan" ? "The latest agent response is reflected as a working plan." : "Switch the composer to Plan mode and ask the agent to propose an approach."} onRefine={conversation && conversation.status !== "running" && conversation.status !== "needs-input" ? () => { updateConversation({ interactionMode: "plan" }); void sendMessage("Refine the implementation plan with clearer steps, risks, and validation.", []).catch(() => undefined); } : undefined} onImplement={conversation && planSteps.length > 0 && conversation.status !== "running" && conversation.status !== "needs-input" ? () => { updateConversation({ interactionMode: "build" }); void sendMessage("Implement the plan above and validate the result.", []).catch(() => undefined); setActiveTool("changes"); } : undefined} />}
                {activeTool === "preview" && <PreviewPanel url={previewUrl} loading={previewNavigation.loading} canGoBack={previewNavigation.canGoBack} canGoForward={previewNavigation.canGoForward} onNavigate={navigatePreview} onBack={() => previewCommand("back")} onForward={() => previewCommand("forward")} onReload={() => previewCommand("reload")} onBoundsChange={setPreviewBounds} onOpenExternal={(url) => { void window.inertia.openExternal(url).catch((error) => setActionError(error instanceof Error ? error.message : "The URL could not be opened.")); }} />}
              </WorkspacePanel>
            )}
          </div>
        </div>
      </section>

      <CommitDialog open={commitDialogOpen} status={gitStatus} reviewStates={reviewStates} diff={structuredDiff} busy={busyAction === "git.commit" || busyAction === "git.push"} onClose={() => setCommitDialogOpen(false)} onCommit={async (...args) => { await commit(...args); setCommitDialogOpen(false); }} />
      <ActivityCenter
        open={activityOpen}
        now={activityNow}
        runs={connection.snapshot?.runs ?? []}
        projects={connection.snapshot?.projects ?? []}
        conversations={connection.snapshot?.conversations ?? []}
        onClose={() => setActivityOpen(false)}
        onOpenThread={(thread) => { selectConversation(thread); setView("workspace"); setActivityOpen(false); }}
        onOpenLocation={openActivityLocation}
        onOpenTerminal={(activity) => { activateActivityContext(activity, "terminal"); setActivityOpen(false); }}
        onOpenPreview={openActivityPreview}
        onStop={stopActivity}
        onRerun={rerunActivity}
        onMarkSeen={markActivitySeen}
        onAcknowledge={acknowledgeActivity}
        onDismiss={dismissActivity}
      />
      <CommandPalette
        open={paletteOpen}
        projects={connection.snapshot?.projects ?? []}
        conversations={connection.snapshot?.conversations ?? []}
        onClose={() => setPaletteOpen(false)}
        onSelectProject={(item) => { selectProject(item); setView("workspace"); }}
        onSelectConversation={(item) => { selectConversation(item); setView("workspace"); }}
        onNewThread={() => createConversation()}
        onAddProject={() => void importProject()}
        onOpenSettings={() => setView("settings")}
      />
      <ProviderAuthDialog
        provider={authProvider}
        status={connection.status}
        theme={settings.theme}
        fontSize={settings.terminalFontSize}
        sendCommand={connection.sendCommand}
        subscribe={connection.subscribe}
        onClose={closeProviderAuth}
      />
      {visibleError && <div className="error-toast" role="alert"><AlertCircle size={17} /><span>{visibleError}</span><IconButton label="Dismiss error" onClick={() => { setActionError(null); connection.clearError(); }}><X size={15} /></IconButton></div>}
    </div>
  );
}
