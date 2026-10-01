import { layoutStorage } from "./utils/layoutStorage";
import { UsageLimitsProvider } from "./components/usage-limits-context";
import { WorkingIndicatorProvider } from "./components/working-indicator/WorkingIndicatorContext";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiagnosticSelection } from "./utils/diagnosticNavigation";
import type { SettingsSection } from "./components/settingsSections";
import { useDiagnosticNavigation } from "./hooks/useDiagnosticNavigation";
import {
  type AgentApprovalDecision,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AppSettings,
  type Conversation,
  type Project,
  type ProviderId,
  type ProviderMaintenanceProviderId,
  type SubagentTrace,
} from "@shared/contracts";
import type { MessageSearchHit } from "@shared/message-search";
import { detachedChatWindowTitle } from "@shared/desktop-window-title";
import { selectConversationWorkspaceRun } from "../../shared/attention";
import { useConversationNavigation } from "./hooks/useConversationNavigation";
import "./detached-chat-workbench.css";
import { AppLayout } from "./components/AppLayout";
import { DialogPresence } from "./components/DialogPresence";
import { LoadingMark } from "./components/ui";
import type { WorkspaceSceneProps } from "./components/WorkspaceScene";
import { useInertiaConnection } from "./hooks/useInertiaConnection";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useHelpGuideOpen } from "./hooks/useHelpGuideOpen";
import { useProviderMaintenance } from "./hooks/useProviderMaintenance";
import { useProviderQuotaNotices } from "./hooks/useProviderQuotaNotices";
import { useConversationProjection } from "./hooks/useConversationProjection";
import { usePlanSteps } from "./hooks/usePlanSteps";
import { useAsyncOperationQueue, useAuthoritativeConversationCreateQueue, useWorkspaceAuthorityCommandQueue } from "./hooks/useConversationSelectionQueue";
import { agentWorkflowRouteIdentity, agentWorkflowTargetConversation, useAgentWorkflows } from "./hooks/useAgentWorkflows";
import { useBackendProfiles } from "./hooks/useBackendProfiles";
import { useDesktopTools } from "./hooks/useDesktopTools";
import { useDetachedChatWindows } from "./hooks/useDetachedChatWindows";
import { useDraftConversation } from "./hooks/useDraftConversation";
import { useActivityActions, type PreviewWorkspaceRun } from "./hooks/useActivityActions";
import { useStableActions, useStableController } from "./hooks/useStableController";
import { useAppUpdate } from "./app-update";
import { useWorkspaceTools } from "./hooks/useWorkspaceTools";
import { useConversationPaneLayout } from "./hooks/useConversationPaneLayout";
import { useSplitPanes } from "./hooks/useSplitPanes";
import { useSplitPaneScenes } from "./hooks/useSplitPaneScenes";
import { useMultiSpawn } from "./hooks/useMultiSpawn";
import { useProjectChatNavigation } from "./hooks/useProjectChatNavigation";
import { useAppRuntimeActions } from "./hooks/useAppRuntimeActions";
import { useTheme } from "./hooks/useTheme";
import { transferDraftWorkspacePanel, useWorkspaceLayout } from "./hooks/useWorkspaceLayout";
import { useDocumentPresence } from "./hooks/useDocumentPresence";
import { shouldMarkWorkspaceRunSeen, workspaceAttentionObstructed } from "./utils/attentionVisibility";
import { type NewConversationLocation, type ReplacementChatRequest, replacementConversationPayload } from "./lib/newConversation";
import { focusWorkspacePreviewAddress } from "./utils/workspacePreviewFocus";
import { defaultConversationPayloadForProject } from "./utils/defaultConversationSelection";
import {
  cacheColorTheme,
  cacheThemePreference,
} from "./utils/theme";
import { cachedAppSettings } from "./utils/cachedSettings";
import { applyInterfaceScale } from "./utils/interfaceScale";
import { withRequestId, type CommandWithoutId } from "./lib/runtimeCommands";
import { draftWorkspaceToolsUnavailableReason } from "./utils/draftWorkspaceAvailability";
import { forgetWorkspaceBoundLastTool } from "./utils/workspaceStartup";
import type { SplitDropZone } from "./utils/splitConversation";
import { applySplitDrop, planSplitDrop, type SplitDropPlan, type SplitPaneOwner } from "./utils/splitLayout";
import { createWorkspaceSceneModel } from "./components/workspace-scene/createWorkspaceSceneModel";
import { createWorkspaceTurnActions } from "./components/workspace-scene/createWorkspaceTurnActions";
import { persistComposerDraft } from "./utils/composerDraftPersistence";
import { requestSubagentFollowUp } from "./utils/subagentFollowUp";
import { prepareComposerDetachment } from "./utils/composerOwnership";
import type { AppView } from "./appView";
const focusPrimaryPreview = (): void => focusWorkspacePreviewAddress("primary");

export function commandMayChangeWorkspaceAuthority(
  command: CommandWithoutId,
): boolean {
  switch (command.type) {
    case "project.create":
    case "project.select":
    case "project.remove":
    case "conversation.select":
    case "conversation.archive":
    case "conversation.delete":
      return true;
    case "conversation.create":
      return command.payload.activate !== false;
    default:
      return false;
  }
}
const AddProjectDialog = lazy(async () => ({ default: (await import("./components/AddProjectDialog")).AddProjectDialog }));
export default function App(): React.JSX.Element {
  const connection = useStableController(useInertiaConnection());
  const detachedChats = useDetachedChatWindows();
  const sendCommand = connection.sendCommand;
  const appUpdate = useStableController(useAppUpdate());
  const providerQuotaNotices = useStableController(
    useProviderQuotaNotices(connection.snapshot?.providers ?? []),
  );
  const documentPresence = useDocumentPresence();
  const documentActive = documentPresence > 1;
  const documentVisible = documentPresence > 0;
  const providerMaintenance = useStableController(
    useProviderMaintenance(
      connection.snapshot,
      sendCommand,
      connection.subscribe,
    ),
  );
  const [view, setView] = useState<AppView>("workspace");
  const [settingsTarget, setSettingsTarget] = useState<{
    section: SettingsSection;
    projectId?: string;
    profileId?: string;
    selection?: DiagnosticSelection;
  } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [dailyWorkOpen, setDailyWorkOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const helpOpen = useHelpGuideOpen();
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [authProviderId, setAuthProviderId] = useState<ProviderId | null>(null);
  const [latestContentVisible, setLatestContentVisible] = useState(false);
  const [attentionVisibilityVersion, setAttentionVisibilityVersion] = useState(0);
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const [suppressedMainConversationIds, setSuppressedMainConversationIds] =
    useState<Set<string>>(() => new Set());
  const split = useSplitPanes({
    snapshot: connection.snapshot,
    detachedConversationIds: detachedChats.conversationIds,
    detachedReady: detachedChats.ready,
  });
  const {
    splitConversationId,
    splitConversation,
    splitSelectionTransitionsRef,
    setSecondaryPaneFirst,
    updateSplitConversationId,
    ownerOf: splitOwnerOf,
    setPaneConversation: setSplitPaneConversation,
    commitLayout: commitSplitLayout,
    closePane: closeSplitPane,
  } = split;
  const splitActive = split.visibleOwners.length > 0;
  const conversationSelectionGenerationRef = useRef(0);
  const pendingSeenRunsRef = useRef(new Set<string>());
  const settings = useMemo(
    () => connection.snapshot?.settings ?? cachedAppSettings(),
    [connection.snapshot?.settings],
  );
  useTheme(settings);
  useEffect(() => {
    if (detachedChats.conversationIds.size === 0) return;
    setSuppressedMainConversationIds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const conversationId of detachedChats.conversationIds) {
        if (!next.has(conversationId)) {
          next.add(conversationId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [detachedChats.conversationIds]);
  useEffect(() => {
    const preference = connection.snapshot?.settings.theme;
    if (!preference) return;
    cacheThemePreference(layoutStorage, preference);
    void window.inertia.syncThemePreference(preference).catch(() => undefined);
  }, [connection.snapshot?.settings.theme]);
  useEffect(() => {
    const colorTheme = connection.snapshot?.settings.colorTheme;
    if (!colorTheme) return;
    cacheColorTheme(layoutStorage, colorTheme);
    cacheColorTheme(layoutStorage, connection.snapshot?.settings.lightColorTheme ?? colorTheme, "light");
    cacheColorTheme(layoutStorage, connection.snapshot?.settings.darkColorTheme ?? colorTheme, "dark");
  }, [connection.snapshot?.settings.colorTheme, connection.snapshot?.settings.lightColorTheme, connection.snapshot?.settings.darkColorTheme]);
  useEffect(() => {
    applyInterfaceScale(settings.interfaceScale);
  }, [settings.interfaceScale]);

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
  const conversationProjection = useStableController(
    useConversationProjection({
      snapshot: connection.snapshot,
      status: connection.status,
      request,
      subscribe: connection.subscribe,
      autoOpenPlan: settings.autoOpenPlan,
      onOpenPlan: (conversationId) => {
        if (conversationId === connection.snapshot?.activeConversationId) {
          sceneSetActiveTool("plan");
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
    plans,
  } = conversationProjection;
  const authProvider = useMemo(
    () => connection.snapshot?.providers.find(({ id }) => id === authProviderId) ?? null,
    [authProviderId, connection.snapshot?.providers],
  );
  const visibleConversationRun = useMemo(
    () => conversation
      ? selectConversationWorkspaceRun(conversation.id, connection.snapshot?.runs ?? [])
      : null,
    [connection.snapshot?.runs, conversation],
  );
  const planSteps = usePlanSteps(
    plans,
    messages,
    conversation?.status ?? "idle",
    conversationProjection.streaming,
  );

  const {
    run,
    openProjectPath,
    sendMessageToConversation,
    compactConversation: compactConversationById,
    runQueueCommand,
    runLimitResetCommand,
    updateConversationById,
    sendingConversationIds,
  } = useAppRuntimeActions({
    sendCommand,
    refreshDetail,
    setBusyAction,
    setActionError,
  });
  const enqueueWorkspaceAuthority = useAsyncOperationQueue();
  const selectionCommandQueue = useWorkspaceAuthorityCommandQueue(
    run,
    connection.snapshot,
    enqueueWorkspaceAuthority,
  );
  const conversationCreateQueue = useAuthoritativeConversationCreateQueue(run, connection.snapshot, enqueueWorkspaceAuthority);
  const runUserCommand = useCallback((
    key: string,
    command: CommandWithoutId,
    options?: { reportError?: boolean },
  ) => {
    if (!commandMayChangeWorkspaceAuthority(command)) {
      return run(key, command, options);
    }
    conversationSelectionGenerationRef.current += 1;
    return selectionCommandQueue(key, command);
  }, [run, selectionCommandQueue]);
  const sendMessageWithWorkspaceAuthority = useCallback((
    ...args: Parameters<typeof sendMessageToConversation>
  ): ReturnType<typeof sendMessageToConversation> => {
    const activate = args[4] !== false;
    if (!activate) return sendMessageToConversation(...args);
    conversationSelectionGenerationRef.current += 1;
    return enqueueWorkspaceAuthority(
      () => sendMessageToConversation(...args),
    );
  }, [enqueueWorkspaceAuthority, sendMessageToConversation]);
  const selectConversationCommand = useCallback((
    key: string,
    conversationId: string,
    isCurrent?: () => boolean,
  ) => selectionCommandQueue(key, {
    type: "conversation.select",
    payload: { conversationId },
  }, isCurrent), [selectionCommandQueue]);
  const draftConversation = useDraftConversation({
    snapshot: connection.snapshot,
    settings,
    run,
    runNavigationCommand: runUserCommand,
    sendMessage: sendMessageWithWorkspaceAuthority,
    persistedConversationId: conversation?.id ?? null,
    updatePersistedConversation: updateConversationById,
    onMaterialized: transferDraftWorkspacePanel,
  });
  const workspaceLayout = useWorkspaceLayout(view, Boolean(project), {
    startupReady: Boolean(connection.snapshot),
    workspaceId: project
      ? `${project.id}:${view === "workspace" && draftConversation.conversation?.projectId === project.id
        ? draftConversation.layoutConversationId
        : connection.snapshot?.activeConversationId ?? "draft"}`
      : null,
  });
  const {
    sidebarOpen,
    setSidebarOpen,
    setSidebarCollapsed,
    mobileNavigation,
  } = workspaceLayout;
  const primaryPaneLayout = useConversationPaneLayout(
    connection.snapshot?.activeConversationId ?? null,
  );
  const primarySceneLayout = splitActive
    ? primaryPaneLayout
    : workspaceLayout;
  const sceneActiveTool = primarySceneLayout.activeTool;
  const sceneSetActiveTool = primarySceneLayout.setActiveTool;
  const {
    globalChatActive,
    deactivateGlobalChat,
    exitGlobalChat,
    importProject: confirmProjectImport,
    navigateToView,
    openGlobalChat,
    openNoProjectChat,
    selectGlobalChatProject,
    selectProject,
    sendMessage,
  } = useProjectChatNavigation({
    project,
    projects: connection.snapshot?.projects ?? [],
    busyAction,
    draftConversation,
    selectionCommandQueue,
    conversationSelectionGenerationRef,
    updateSplitConversationId,
    setSidebarOpen,
    setView,
    setActionError,
  });
  const composerProject = connection.snapshot?.projects.find(
    ({ id }) => id === draftConversation.conversation?.projectId,
  ) ?? project;
  const importProject = async (): Promise<void> => { if (!busyAction) setAddProjectOpen(true); };
  const updateConversation = draftConversation.updateConversation;
  const discardDraftConversation = draftConversation.discard;
  const selectedMaintenanceProviderId = (
    draftConversation.conversation ?? conversation
  )?.providerId as ProviderMaintenanceProviderId | undefined;
  const selectedMaintenanceStatus = selectedMaintenanceProviderId
    ? providerMaintenance.statuses.get(selectedMaintenanceProviderId) ?? null
    : null;
  const selectedMaintenanceOperation = selectedMaintenanceProviderId
    ? providerMaintenance.operations.get(selectedMaintenanceProviderId) ?? null
    : null;
  const workflowConversation = agentWorkflowTargetConversation(
    conversation,
    draftConversation.conversation,
  );
  const agentWorkflows = useStableController(useAgentWorkflows({
    conversationId: workflowConversation?.id ?? null,
    routeIdentity: agentWorkflowRouteIdentity(workflowConversation, project),
    status: connection.status,
    request,
    subscribe: connection.subscribe,
  }));
  const multiSpawn = useMultiSpawn({
    snapshot: connection.snapshot,
    settings,
    run,
    request,
    selectConversationCommand,
    workspaceVisible: view === "workspace",
    splitConversationId,
    conversationSelectionGenerationRef,
    splitSelectionTransitionsRef,
    updateSplitConversationId,
    showWorkspace: () => setView("workspace"),
    closeSidebar: () => setSidebarOpen(false),
    focusWorkspace: () => window.requestAnimationFrame(() => document.getElementById("main-workspace")?.focus({ preventScroll: true })),
    discardDraftConversation,
    setActionError,
  });
  const workspaceToolsUnavailableReason = draftWorkspaceToolsUnavailableReason(draftConversation.requiresWorkspaceMaterialization);
  const workspaceToolsUnavailable = Boolean(workspaceToolsUnavailableReason);
  useEffect(() => {
    if (workspaceToolsUnavailable) forgetWorkspaceBoundLastTool(window.localStorage);
  }, [workspaceToolsUnavailable]);
  const workspaceTools = useStableController(
    useWorkspaceTools({
      enabled: !workspaceToolsUnavailable,
      project: composerProject,
      conversation: draftConversation.conversation ? draftConversation.workspaceConversation : conversation,
      detail: draftConversation.conversation ? null : conversationDetail,
      online: connection.status === "online",
      ignoreWhitespace: settings.ignoreWhitespace,
      confirmDestructiveActions: settings.confirmDestructiveActions,
      refreshVersion: gitRefreshVersion,
      request,
      run,
      subscribe: connection.subscribe,
      setActionError,
      setActiveTool: sceneSetActiveTool,
      loadGitStatusOnMount: !workspaceToolsUnavailable,
      loadGitOnMount:
        !workspaceToolsUnavailable
        && (
          sceneActiveTool === "changes"
          || sceneActiveTool === "files"
        ),
      gitStatusOnly: sceneActiveTool === "files",
      loadFilesOnMount:
        !workspaceToolsUnavailable && sceneActiveTool === "files",
    }),
  );
  const backendProfileActions = useStableController(
    useBackendProfiles({ request, run }),
  );
  const browserWorkspaceVisible = view === "workspace" && detachedChats.ready;
  const desktopTools = useStableController(
    useDesktopTools({
      setActionError,
      previewOwnerId: "primary",
      previewContextId: browserWorkspaceVisible && conversation
        && !suppressedMainConversationIds.has(conversation.id)
        && !detachedChats.conversationIds.has(conversation.id)
        ? conversation.id
        : null,
    }),
  );
  const {
    gitStatus,
    branches,
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
        obstructed: workspaceAttentionObstructed({
          paletteOpen, commitDialogOpen,
          dailyWorkOpen,
          authProviderOpen: authProviderId !== null,
          multiSpawnOpen: multiSpawn.open,
          mobileSidebarOpen: mobileNavigation && sidebarOpen,
          helpOpen,
        }),
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
    attentionVisibilityVersion,
    authProviderId,
    commitDialogOpen,
    dailyWorkOpen,
    conversation?.id,
    helpOpen,
    latestContentVisible,
    mobileNavigation, multiSpawn.open,
    paletteOpen,
    request,
    sidebarOpen,
    view,
    visibleConversationRun,
  ]);

  // Navigation actions retain their identity across overlay state changes,
  // while dispatching against the latest workspace and draft ownership.
  const { selectConversation, selectMessage } = useStableActions(useConversationNavigation({
    snapshot: connection.snapshot, conversation, splitConversation, detachedChats, exitGlobalChat,
    conversationSelectionGenerationRef, splitSelectionTransitionsRef,
    setSuppressedMainConversationIds, setSecondaryPaneFirst,
    selectConversationCommand, updateSplitConversationId, request, setActionError,
    extraSplitPanes: split.extraPanes,
  }));
  const openConversationInWindow = useCallback((
    nextConversation: Conversation,
  ): void => {
    setActionError(null);
    if (detachedChats.conversationIds.has(nextConversation.id)) {
      selectConversation(nextConversation);
      return;
    }
    const preparation = prepareComposerDetachment(nextConversation.id);
    if (preparation.status === "blocked") {
      setActionError(preparation.reason);
      return;
    }
    const wasSuppressed = suppressedMainConversationIds.has(
      nextConversation.id,
    );
    const splitOwner = splitOwnerOf(nextConversation.id);
    const pinnedOwner = splitOwner === "primary" ? null : splitOwner;
    setSuppressedMainConversationIds((current) => {
      if (current.has(nextConversation.id)) return current;
      const next = new Set(current);
      next.add(nextConversation.id);
      return next;
    });
    if (pinnedOwner) setSplitPaneConversation(pinnedOwner, null);

    // Let React unmount the current composer before the second renderer owns it.
    void new Promise<number>((resolve) => requestAnimationFrame(resolve)).then(() => detachedChats.open({
      conversationId: nextConversation.id,
      title: detachedChatWindowTitle(nextConversation.title),
      draft: preparation.draft,
    })).catch((error: unknown) => {
      if (!wasSuppressed) {
        setSuppressedMainConversationIds((current) => {
          const next = new Set(current);
          next.delete(nextConversation.id);
          return next;
        });
      }
      if (pinnedOwner) setSplitPaneConversation(pinnedOwner, nextConversation.id);
      setActionError(error instanceof Error
        ? error.message
        : "The chat window could not be opened.");
    });
  }, [
    detachedChats,
    selectConversation,
    setSplitPaneConversation,
    splitOwnerOf,
    suppressedMainConversationIds,
  ]);
  const showConversationInMain = (conversationId: string): void => {
    setSuppressedMainConversationIds((current) => {
      if (!current.has(conversationId)) return current;
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
  };
  const openConversationInSplit = (nextConversation: Conversation): void => {
    if (
      !conversation
      || nextConversation.id === conversation.id
      || nextConversation.archivedAt !== null
    ) {
      return;
    }
    if (detachedChats.conversationIds.has(nextConversation.id)) {
      selectConversation(nextConversation);
      return;
    }
    const owner = split.freeOwner;
    if (!owner || splitOwnerOf(nextConversation.id)) return;
    exitGlobalChat();
    showConversationInMain(nextConversation.id);
    if (owner === "secondary") updateSplitConversationId(nextConversation.id);
    else setSplitPaneConversation(owner, nextConversation.id);
    setView("workspace");
    setSidebarOpen(false);
  };
  const planConversationDrop = (conversationId: string, target: SplitPaneOwner, zones: readonly SplitDropZone[]): SplitDropPlan | null =>
    planSplitDrop(split.layout, splitOwnerOf(conversationId), target, zones, split.freeOwner);
  const dropConversationInSplit = (conversationId: string, plan: SplitDropPlan): void => {
    const dropped = connection.snapshot?.conversations.find(({ id }) => id === conversationId);
    if (!conversation || !dropped) return;
    if (plan.kind === "move" || plan.kind === "swap") {
      commitSplitLayout(applySplitDrop(split.layout, plan));
      return;
    }
    if (dropped.archivedAt !== null || detachedChats.conversationIds.has(dropped.id) || splitOwnerOf(dropped.id)) return;
    if (plan.kind === "replace" && plan.target === "primary") {
      selectConversation(dropped, { keepPaneOrder: true });
      return;
    }
    exitGlobalChat();
    showConversationInMain(dropped.id);
    const owner = plan.kind === "insert" ? plan.owner : plan.target;
    if (owner !== "primary") setSplitPaneConversation(owner, dropped.id);
    if (plan.kind === "insert") commitSplitLayout(applySplitDrop(split.layout, plan));
  };
  const primaryPreviewActions = useStableActions({
    activateContext: (
      activity: PreviewWorkspaceRun,
      tool: "preview",
    ): boolean => {
      const targetProject = connection.snapshot?.projects.find(
        ({ id }) => id === activity.projectId,
      );
      const targetConversation = activity.conversationId === null
        ? null
        : connection.snapshot?.conversations.find(
            ({ id, projectId: ownerProjectId }) =>
              id === activity.conversationId
              && ownerProjectId === activity.projectId,
          ) ?? null;
      if (!targetProject || (activity.conversationId && !targetConversation)) {
        return false;
      }
      if (targetConversation) selectConversation(targetConversation);
      else selectProject(targetProject);
      setView("workspace");
      setSidebarOpen(false);
      sceneSetActiveTool(tool);
      return true;
    },
  });
  const activityActions = useStableController(
    useActivityActions({
      project,
      conversationId: conversation?.id ?? null,
      run,
      openTerminal: primarySceneLayout.openTerminal,
      setActionError,
      activateContext: primaryPreviewActions.activateContext,
      navigatePreview: desktopTools.navigatePreview,
      focusPreview: focusPrimaryPreview,
    }),
  );
  const {
    runProjectAction,
    openWorkspaceRunPreview: openPrimaryWorkspaceRunPreview,
    acknowledgeActivity,
    dismissActivity,
  } = activityActions;
  const createConversation = (
    targetProject: Project | null = composerProject,
    location: NewConversationLocation = { kind: "defaults" },
  ) => {
    if (!targetProject) { openNoProjectChat(); return; }
    if (!connection.snapshot) return;
    deactivateGlobalChat();
    const payload = defaultConversationPayloadForProject(
      connection.snapshot,
      settings,
      targetProject.id,
      location,
    );
    const creationGeneration = ++conversationSelectionGenerationRef.current;
    void conversationCreateQueue("conversation.create", {
      type: "conversation.create",
      payload,
    })
      .then(() => {
        if (
          creationGeneration === conversationSelectionGenerationRef.current
        ) {
          discardDraftConversation();
          setView("workspace");
          setSidebarOpen(false);
        }
      })
      .catch((error: unknown) => {
        if (creationGeneration === conversationSelectionGenerationRef.current) {
          setActionError(error instanceof Error ? error.message : "The new chat could not be created.");
        }
      });
  };
  useGlobalShortcuts({
    keybindings: settings.keybindings,
    createConversation: () => createConversation(),
    mobileNavigation, suspended: multiSpawn.open || dailyWorkOpen,
    toggleTerminal: primarySceneLayout.toggleTerminal,
    setPaletteOpen,
    setSidebarCollapsed,
    setSidebarOpen,
  });
  const createConversationForSelection = async (request: ReplacementChatRequest): Promise<void> => {
    if (draftConversation.chooseModel(request.selection, request.configuration)) return;
    if (!project) throw new Error("Select a project before creating a chat.");
    const selectionGeneration =
      conversationSelectionGenerationRef.current + 1;
    conversationSelectionGenerationRef.current = selectionGeneration;
    const event = await run("conversation.create", {
      type: "conversation.create",
      payload: replacementConversationPayload(project, settings, request),
    });
    if (
      event.type !== "request.result"
      || event.result.kind !== "conversation.created"
    ) throw new Error("The new chat could not be identified.");
    if (request.prefillText) {
      persistComposerDraft(event.result.conversationId, request.prefillText);
    }
    request.onCreated?.(event.result.conversationId);
    if (
      selectionGeneration !== conversationSelectionGenerationRef.current
    ) return;
    await selectConversationCommand(
      "conversation.select",
      event.result.conversationId,
    );
    if (
      selectionGeneration !== conversationSelectionGenerationRef.current
    ) return;
    setView("workspace");
    setSidebarOpen(false);
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
  const updateSettings = async (updates: Partial<AppSettings>): Promise<void> => {
    await run("settings.update", {
      type: "settings.update",
      payload: updates,
    });
  };

  const chooseCodexBinary = async (): Promise<void> => {
    const path = await window.inertia.selectCodexExecutable();
    if (path) await updateSettings({ codexBinaryPath: path });
  };
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
    navigateToView("settings");
  }, [navigateToView]);
  const openBackendSetup = useCallback((profileId: string) => {
    setSettingsTarget({ section: "backends", profileId });
    navigateToView("settings");
  }, [navigateToView]);
  const openProjectSettings = useCallback((projectId: string) => {
    setSettingsTarget({ section: "projects", projectId });
    navigateToView("settings");
  }, [navigateToView]);
  const openSettingsSection = useCallback((section: SettingsSection) => {
    setSettingsTarget({ section });
    navigateToView("settings");
  }, [navigateToView]);

  useEffect(() => {
    if (view !== "settings" && settingsTarget) setSettingsTarget(null);
  }, [settingsTarget, view]);

  const visibleError = actionError ?? connection.error;
  useDiagnosticNavigation(
    connection.snapshot?.conversations,
    connection.status === "online",
    selectConversation,
    () => { setView("workspace"); setSidebarOpen(false); },
    (target) => { setSettingsTarget(target); navigateToView("settings"); },
    setActionError,
  );
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
      selectGlobalChatProject,
      createConversation,
      createConversationForSelection,
      sendMessage,
      compactConversation: async (instruction?: string) => {
        if (!conversation) {
          throw new Error("This chat is not ready to compact.");
        }
        return await compactConversationById(conversation.id, instruction);
      },
      listSkills: agentWorkflows.listSkills,
      setGoal: agentWorkflows.setGoal,
      clearGoal: agentWorkflows.clearGoal,
      respondToApproval,
      respondToInput,
      updateConversation,
      updateSettings,
      chooseCodexBinary,
      refreshProvider,
      connectProvider,
      openProviderSetup,
      openBackendSetup,
      openSettings: () => navigateToView("settings"),
      openUsageView: () => navigateToView("usage"),
      openProjectPath,
      followUpSubagent: (trace: SubagentTrace) => {
        if (conversation) {
          requestSubagentFollowUp(conversation.id, trace, conversationProjection.turns);
        }
      },
      ...turnSceneActions,
      stopSubagent: async (trace: SubagentTrace) => {
        try {
          await turnSceneActions.stopSubagent(trace);
        } catch (error) {
          setActionError(error instanceof Error
            ? error.message
            : "The delegated task could not be stopped.");
          throw error;
        }
      },
      run,
      runConversationContextCommand: draftConversation.runConversationContextCommand,
      runQueueCommand,
      runLimitResetCommand,
  });
  const workspaceScene = useMemo(() => createWorkspaceSceneModel({
    view: view === "settings" ? "settings" : "workspace",
    settingsTarget,
    settings,
    busyAction,
    project: composerProject,
    draftConversation: draftConversation.conversation,
    workspaceToolsUnavailable,
    globalChatActive,
    connection,
    providerMaintenance,
    projection: conversationProjection,
    layout: primarySceneLayout,
    workspaceTools,
    backendProfileActions,
    desktopTools,
    activityActions,
    appUpdate,
    planSteps,
    workflow: agentWorkflows,
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
    draftConversation.conversation,
    globalChatActive,
    planSteps,
    agentWorkflows,
    composerProject,
    providerMaintenance,
    selectedMaintenanceOperation,
    selectedMaintenanceStatus,
    settings,
    settingsTarget,
    view,
    primarySceneLayout,
    workspaceSceneActions,
    workspaceTools,
    workspaceToolsUnavailable,
  ]);
  const splitPanes = useSplitPaneScenes({
    split,
    shared: {
      snapshotProjects: connection.snapshot?.projects ?? [],
      settings,
      connection,
      providerMaintenance,
      backendProfileActions,
      appUpdate,
      busyAction,
      setBusyAction,
      setActionError,
      gitRefreshVersion,
      request,
      actions: {
        importProject,
        createConversation,
        respondToApproval,
        respondToInput,
        updateSettings,
        chooseCodexBinary,
        refreshProvider,
        connectProvider,
        openProviderSetup,
        openBackendSetup,
        openSettings: () => navigateToView("settings"),
        openUsageView: () => navigateToView("usage"),
        openProjectPath,
        sendMessageToConversation,
        compactConversation: compactConversationById,
        runQueueCommand,
        runLimitResetCommand,
        updateConversationById,
      },
      sendingConversationIds,
      onTerminal: () => setGitRefreshVersion((version) => version + 1),
    },
    visible: browserWorkspaceVisible,
    conversation,
    project,
    primaryLayout: primaryPaneLayout,
    openConversationInWindow,
    openPrimaryWorkspaceRunPreview,
  });
  const openWorkspaceRunPreview = splitPanes.openWorkspaceRunPreview;
  const primaryConversationSuppressed = Boolean(
    conversation && (
      suppressedMainConversationIds.has(conversation.id)
      || detachedChats.conversationIds.has(conversation.id)
    ),
  );
  const visibleWorkspaceScene = useMemo<WorkspaceSceneProps>(() => ({
    ...workspaceScene,
    chat: {
      ...workspaceScene.chat,
      sending: conversation
        ? sendingConversationIds.has(conversation.id)
        : false,
    },
    tools: workspaceScene.tools ? {
      ...workspaceScene.tools,
      runs: {
        ...workspaceScene.tools.runs,
        onOpenRunPreview: openWorkspaceRunPreview,
      },
    } : null,
    detachedChat: conversation && primaryConversationSuppressed ? {
      title: conversation.title,
      windowOpen: detachedChats.conversationIds.has(conversation.id),
      onActivate: () => selectConversation(conversation),
    } : null,
    splitScene: splitPanes.splitScene,
  }), [
    conversation,
    detachedChats.conversationIds,
    openWorkspaceRunPreview,
    primaryConversationSuppressed,
    selectConversation,
    sendingConversationIds,
    splitPanes.splitScene,
    workspaceScene,
  ]);
  const layoutUsage = useMemo(
    () => ({ status: connection.status, request }),
    [connection.status, request],
  );
  const layoutProviderAuth = useMemo(() => ({
    provider: authProvider,
    status: connection.status,
    theme: settings.theme,
    colorTheme: settings.colorTheme,
    fontSize: settings.terminalFontSize,
    sendCommand,
    subscribe: connection.subscribe,
    onClose: closeProviderAuth,
  }), [
    authProvider,
    closeProviderAuth,
    connection.status,
    connection.subscribe,
    sendCommand,
    settings.colorTheme,
    settings.terminalFontSize,
    settings.theme,
  ]);
  const layoutCallbacks = useStableActions({
    setView: navigateToView,
    run: runUserCommand,
    importProject,
    openGlobalChat,
    openNoProjectChat,
    selectProject,
    selectConversation,
    selectMessage: (hit: MessageSearchHit, signal?: AbortSignal) =>
      selectMessage(hit, () => setView("workspace"), signal),
    openConversationInSplit,
    openConversationInWindow,
    closeConversationSplit: (target: Conversation) => {
      const owner = splitOwnerOf(target.id);
      if (owner) closeSplitPane(owner);
    },
    planConversationDrop,
    dropConversationInSplit,
    openProviderSetup,
    openBackendSetup,
    openProjectSettings,
    openSettingsSection,
    createConversation,
    updateSettings,
    openProjectPath,
    loadBranches,
    mutateBranch,
    mutateRemote: workspaceTools.mutateRemote,
    loadGit: () => loadGit({ authoritative: true }),
    refreshGitStatus: () => {
      void loadGit({ scope: "status" }).catch(() => undefined);
    },
    commit,
    runProjectAction,
    acknowledgeActivity,
    dismissActivity,
  });
  const multiSpawnActions = useStableActions({
    openDialog: multiSpawn.openDialog,
    closeDialog: multiSpawn.closeDialog,
    submit: multiSpawn.submit,
    recheckRecovery: multiSpawn.recheckRecovery,
    acknowledgeRecovery: multiSpawn.acknowledgeRecovery,
    retryComparison: multiSpawn.retryComparison,
    cancelComparison: multiSpawn.cancelComparison,
  });
  const layoutMultiSpawn = useStableController({
    ...multiSpawn,
    ...multiSpawnActions,
  });
  const layoutActions = useMemo(() => ({
    ...layoutCallbacks,
    loadCommitReview: workspaceTools.loadCommitReview,
    discardCommitReview: workspaceTools.discardCommitReview,
    commitReviewRevision: workspaceTools.commitReviewRevision,
  }), [
    layoutCallbacks,
    workspaceTools.commitReviewRevision,
    workspaceTools.discardCommitReview,
    workspaceTools.loadCommitReview,
  ]);

  if (!detachedChats.ready) {
    return (
      <main className="app-startup-loading" aria-busy="true">
        <LoadingMark label="Restoring chat windows" />
      </main>
    );
  }

  return (
    <UsageLimitsProvider request={request} status={connection.status}>
    <WorkingIndicatorProvider settings={settings.workingIndicator}>
    <Suspense fallback={null}><DialogPresence open={addProjectOpen}><AddProjectDialog onClose={() => setAddProjectOpen(false)} onImport={confirmProjectImport} /></DialogPresence></Suspense>
    <AppLayout
      platform={platform}
      documentActive={documentActive}
      documentVisible={documentVisible}
      settings={settings}
      connection={connection}
      appUpdate={appUpdate}
      providerQuotaNotices={providerQuotaNotices}
      workspaceLayout={workspaceLayout}
      view={view}
      setView={layoutCallbacks.setView}
      busyAction={busyAction}
      visibleError={visibleError}
      setActionError={setActionError}
      commitDialogOpen={commitDialogOpen}
      setCommitDialogOpen={setCommitDialogOpen}
      dailyWorkOpen={dailyWorkOpen}
      setDailyWorkOpen={setDailyWorkOpen}
      paletteOpen={paletteOpen}
      setPaletteOpen={setPaletteOpen}
      project={composerProject}
      conversation={conversation}
      headerConversation={draftConversation.conversation ?? conversation}
      splitConversationIds={split.splitConversationIds}
      splitViewFull={!split.freeOwner}
      detachedConversationIds={detachedChats.conversationIds}
      detachedChatLimitReached={detachedChats.atLimit}
      conversationSuppressedInMain={primaryConversationSuppressed}
      scenePanel={primarySceneLayout}
      workspaceToolsUnavailableReason={workspaceToolsUnavailableReason}
      gitStatus={gitStatus}
      branches={branches} branchesLoading={workspaceTools.branchesLoading} branchesError={workspaceTools.branchesError}
      projectActions={projectActions}
      reviewStates={reviewStates}
      multiSpawn={layoutMultiSpawn}
      scene={visibleWorkspaceScene}
      usage={layoutUsage}
      providerAuth={layoutProviderAuth}
      actions={layoutActions}
    />
    </WorkingIndicatorProvider>
    </UsageLimitsProvider>
  );
}
