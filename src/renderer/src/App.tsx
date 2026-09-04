import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentApprovalDecision,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AppSettings,
  type Conversation,
  type ModelSelection,
  type Project,
  type ProviderId,
  type ProviderMaintenanceProviderId,
  type SubagentTrace,
} from "@shared/contracts";
import { defaultSettings } from "@shared/contracts/app";
import { selectConversationWorkspaceRun } from "../../shared/attention";
import "./detached-chat-workbench.css";
import type { ProjectImportInput } from "../../shared/project-import";
import { AppLayout } from "./components/AppLayout";
import { LoadingMark } from "./components/ui";
import type { WorkspaceSceneProps } from "./components/WorkspaceScene";
import { useInertiaConnection } from "./hooks/useInertiaConnection";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useProviderMaintenance } from "./hooks/useProviderMaintenance";
import { useProviderQuotaNotices } from "./hooks/useProviderQuotaNotices";
import { useConversationProjection } from "./hooks/useConversationProjection";
import { useAsyncOperationQueue, useAuthoritativeConversationCreateQueue, useWorkspaceAuthorityCommandQueue } from "./hooks/useConversationSelectionQueue";
import {
  agentWorkflowRouteIdentity,
  agentWorkflowTargetConversation,
  useAgentWorkflows,
} from "./hooks/useAgentWorkflows";
import { useBackendProfiles } from "./hooks/useBackendProfiles";
import { useDesktopTools } from "./hooks/useDesktopTools";
import { useDetachedChatWindows } from "./hooks/useDetachedChatWindows";
import { useDraftConversation } from "./hooks/useDraftConversation";
import {
  useActivityActions,
  type PreviewWorkspaceRun,
} from "./hooks/useActivityActions";
import { useStableActions, useStableController } from "./hooks/useStableController";
import { useAppUpdate } from "./app-update";
import { useWorkspaceTools } from "./hooks/useWorkspaceTools";
import { useConversationPaneLayout } from "./hooks/useConversationPaneLayout";
import { useSplitWorkspaceScene } from "./hooks/useSplitWorkspaceScene";
import { useMultiSpawn } from "./hooks/useMultiSpawn";
import { useAppRuntimeActions } from "./hooks/useAppRuntimeActions";
import { useTheme } from "./hooks/useTheme";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";
import { useDocumentPresence } from "./hooks/useDocumentPresence";
import { shouldMarkWorkspaceRunSeen, workspaceAttentionObstructed } from "./utils/attentionVisibility";
import { buildNewConversationPayload, type NewConversationLocation, withNewConversationModelSelection } from "./lib/newConversation";
import {
  focusWorkspacePreviewAddress,
  routeWorkspaceRunPreview,
} from "./utils/workspacePreviewFocus";
import { defaultConversationPayloadForProject } from "./utils/defaultConversationSelection";
import {
  cacheColorTheme,
  cacheThemePreference,
  cachedColorTheme,
  cachedThemePreference,
  nextQuickTheme,
} from "./utils/theme";
import { applyInterfaceScale } from "./utils/interfaceScale";
import { withRequestId, type CommandWithoutId } from "./lib/runtimeCommands";
import { planFromText } from "./utils/planFromText";
import { draftWorkspaceToolsUnavailableReason } from "./utils/draftWorkspaceAvailability";
import { finishLegacyWorkspaceStartupMigration, readLegacyWorkspaceStartup } from "./utils/workspaceStartup";
import {
  persistSplitConversationId,
  readSplitConversationId,
  resolvedSplitConversation,
  splitConversationAfterPrimaryChange,
} from "./utils/splitConversation";
import { createWorkspaceSceneModel } from "./components/workspace-scene/createWorkspaceSceneModel";
import { createWorkspaceTurnActions } from "./components/workspace-scene/createWorkspaceTurnActions";
import { requestComposerPrefill } from "./utils/composerPrefill";
import { canFollowUpSubagentTrace } from "./utils/subagentDisclosure";
import { prepareComposerDetachment } from "./utils/composerOwnership";
import type { AppView } from "./appView";
const focusPrimaryPreview = (): void => {
  focusWorkspacePreviewAddress("primary");
};
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
    section: "providers" | "backends" | "connections";
    profileId?: string;
  } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [dailyWorkOpen, setDailyWorkOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [authProviderId, setAuthProviderId] = useState<ProviderId | null>(null);
  const [latestContentVisible, setLatestContentVisible] = useState(false);
  const [attentionVisibilityVersion, setAttentionVisibilityVersion] = useState(0);
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const [splitConversationId, setSplitConversationId] = useState<string | null>(
    () => readSplitConversationId(window.localStorage),
  );
  const [suppressedMainConversationIds, setSuppressedMainConversationIds] =
    useState<Set<string>>(() => new Set());
  const [secondaryPaneFirst, setSecondaryPaneFirst] = useState(false);
  const splitSelectionTransitionsRef = useRef(0);
  const conversationSelectionGenerationRef = useRef(0);
  const pendingSeenRunsRef = useRef(new Set<string>());
  const legacyWorkspaceStartupMigrationRef = useRef(false);
  const [legacyWorkspaceStartup] = useState(() =>
    readLegacyWorkspaceStartup(window.localStorage));
  const settings = useMemo(
    () => connection.snapshot?.settings ?? {
      ...defaultSettings,
      theme: cachedThemePreference(window.localStorage) ?? defaultSettings.theme,
      colorTheme: cachedColorTheme(window.localStorage)
        ?? defaultSettings.colorTheme,
    },
    [connection.snapshot?.settings],
  );
  useTheme(settings.theme, settings.colorTheme);
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
    cacheThemePreference(window.localStorage, preference);
    void window.inertia.syncThemePreference(preference).catch(() => undefined);
  }, [connection.snapshot?.settings.theme]);
  useEffect(() => {
    const colorTheme = connection.snapshot?.settings.colorTheme;
    if (!colorTheme) return;
    cacheColorTheme(window.localStorage, colorTheme);
  }, [connection.snapshot?.settings.colorTheme]);
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
  const splitConversation = useMemo(
    () => resolvedSplitConversation(
      connection.snapshot,
      splitConversationId,
    ),
    [connection.snapshot, splitConversationId],
  );
  const updateSplitConversationId = useCallback(
    (conversationId: string | null) => {
      setSplitConversationId(conversationId);
      setSecondaryPaneFirst(false);
      persistSplitConversationId(window.localStorage, conversationId);
    },
    [],
  );
  useEffect(() => {
    if (
      splitSelectionTransitionsRef.current > 0
      || !connection.snapshot
      || !splitConversationId
      || splitConversation
    ) {
      return;
    }
    updateSplitConversationId(null);
  }, [
    connection.snapshot,
    splitConversation,
    splitConversationId,
    updateSplitConversationId,
  ]);
  const splitConversationDetached = Boolean(
    splitConversation
    && detachedChats.conversationIds.has(splitConversation.id),
  );
  useEffect(() => {
    if (detachedChats.ready && splitConversationDetached) {
      updateSplitConversationId(null);
    }
  }, [
    detachedChats.ready,
    splitConversationDetached,
    updateSplitConversationId,
  ]);
  const effectiveWorkspaceStartupSurface = legacyWorkspaceStartup?.surface
    ?? settings.workspaceStartupSurface;
  const workspaceLayout = useWorkspaceLayout(view, Boolean(project), {
    startupSurface: effectiveWorkspaceStartupSurface,
    startupReady: Boolean(connection.snapshot),
    workspaceId: project
      ? `${project.id}:${connection.snapshot?.activeConversationId ?? "draft"}`
      : null,
    initialTool: legacyWorkspaceStartup?.tool,
  });
  const {
    sidebarOpen,
    setSidebarOpen,
    setSidebarCollapsed,
    toggleWorkspaceTools,
    showStartupSurface,
    mobileNavigation,
  } = workspaceLayout;
  const primaryPaneLayout = useConversationPaneLayout(
    connection.snapshot?.activeConversationId ?? null,
  );
  const secondaryPaneLayout = useConversationPaneLayout(
    splitConversation?.id ?? null,
  );
  const primarySceneLayout = splitConversation
    ? primaryPaneLayout
    : workspaceLayout;
  const sceneActiveTool = primarySceneLayout.activeTool;
  const sceneSetActiveTool = primarySceneLayout.setActiveTool;
  const sceneToggleWorkspaceTools = splitConversation
    ? primaryPaneLayout.toggleWorkspaceTools
    : toggleWorkspaceTools;
  const sceneOpenEnvironment = () => sceneSetActiveTool("environment");
  const sceneOpenBrowser = () => sceneSetActiveTool("preview");
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
    streamingText,
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
  const visibleConversationRun = useMemo(
    () => conversation
      ? selectConversationWorkspaceRun(conversation.id, connection.snapshot?.runs ?? [])
      : null,
    [connection.snapshot?.runs, conversation],
  );
  const latestAssistantContent = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "assistant") return message.content;
    }
    return "";
  }, [messages]);
  const planSteps = useMemo(() => {
    const latestPlan = plans.at(-1);
    if (latestPlan) {
      return latestPlan.steps.map((step, index) => ({
        id: `native-${index}`,
        title: step.step,
        status: step.status === "inProgress" ? "in-progress" as const : step.status,
      }));
    }
    const text = latestAssistantContent || streamingText;
    return planFromText(text, conversation?.status ?? "idle");
  }, [
    conversation?.status,
    latestAssistantContent,
    plans,
    streamingText,
  ]);

  const {
    run,
    openProjectPath,
    sendMessageToConversation,
    compactConversation: compactConversationById,
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
  ) => {
    if (!commandMayChangeWorkspaceAuthority(command)) {
      return run(key, command);
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
  ) => selectionCommandQueue(key, {
    type: "conversation.select",
    payload: { conversationId },
  }), [selectionCommandQueue]);
  const navigateToView = useCallback((nextView: AppView) => {
    if (nextView !== "workspace") {
      conversationSelectionGenerationRef.current += 1;
    }
    setView(nextView);
  }, []);
  const draftConversation = useDraftConversation({
    snapshot: connection.snapshot,
    settings,
    run,
    runNavigationCommand: runUserCommand,
    sendMessage: sendMessageWithWorkspaceAuthority,
    persistedConversationId: conversation?.id ?? null,
    updatePersistedConversation: updateConversationById,
  });
  const sendMessage = draftConversation.sendFromComposer;
  const updateConversation = draftConversation.updateConversation;
  const discardDraftConversation = draftConversation.discard;
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
  const sceneHeaderActiveTool = workspaceToolsUnavailable && sceneActiveTool
    ? "environment"
    : sceneActiveTool;
  useEffect(() => {
    if (
      workspaceToolsUnavailable
      && sceneActiveTool
      && sceneActiveTool !== "environment"
    ) {
      sceneSetActiveTool("environment");
    }
  }, [sceneActiveTool, sceneSetActiveTool, workspaceToolsUnavailable]);
  const workspaceTools = useStableController(
    useWorkspaceTools({
      enabled: !workspaceToolsUnavailable,
      project,
      conversation,
      detail: conversationDetail,
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
          || sceneActiveTool === "environment"
        ),
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
    latestContentVisible,
    mobileNavigation, multiSpawn.open,
    paletteOpen,
    request,
    sidebarOpen,
    view,
    visibleConversationRun,
  ]);

  const importProject = async () => {
    if (!busyAction) setAddProjectOpen(true);
  };
  const confirmProjectImport = async (input: ProjectImportInput): Promise<void> => {
    if (!await draftConversation.importProject(input)) return;
    setView("workspace");
    setSidebarOpen(false);
    showStartupSurface(effectiveWorkspaceStartupSurface);
  };
  const selectProject = (nextProject: Project) => {
    if (nextProject.id === project?.id) return;
    conversationSelectionGenerationRef.current += 1;
    void selectionCommandQueue("project.select", {
      type: "project.select",
      payload: { projectId: nextProject.id },
    }).then(() => updateSplitConversationId(null)).catch(() => undefined);
  };
  const selectConversationInMain = useCallback((
    nextConversation: Conversation,
  ) => {
    setSuppressedMainConversationIds((current) => {
      if (!current.has(nextConversation.id)) return current;
      const next = new Set(current);
      next.delete(nextConversation.id);
      return next;
    });
    if (nextConversation.id === conversation?.id) return;
    if (nextConversation.id === splitConversation?.id) {
      // A split-pane promotion is visual only. Retargeting the primary and
      // secondary controllers would tear down conversation-owned terminals,
      // previews, attachments, and tool state.
      setSecondaryPaneFirst(true);
      window.setTimeout(() => {
        document.querySelector<HTMLElement>(
          "#secondary-conversation-pane textarea",
        )?.focus({ preventScroll: true });
      }, 0);
      return;
    }
    const nextSplitConversationId = splitConversationAfterPrimaryChange(
      conversation,
      nextConversation,
      splitConversation,
    );
    setSecondaryPaneFirst(false);
    const selectionGeneration =
      conversationSelectionGenerationRef.current + 1;
    conversationSelectionGenerationRef.current = selectionGeneration;
    splitSelectionTransitionsRef.current += 1;
    void selectConversationCommand(
      "conversation.select",
      nextConversation.id,
    ).then(() => {
      if (
        selectionGeneration === conversationSelectionGenerationRef.current
      ) {
        updateSplitConversationId(nextSplitConversationId);
      }
    }).catch(() => undefined).finally(() => {
      splitSelectionTransitionsRef.current = Math.max(
        0,
        splitSelectionTransitionsRef.current - 1,
      );
    });
  }, [
    conversation,
    selectConversationCommand,
    splitConversation,
    updateSplitConversationId,
  ]);
  const selectConversation = useCallback((nextConversation: Conversation) => {
    if (!detachedChats.conversationIds.has(nextConversation.id)) {
      selectConversationInMain(nextConversation);
      return;
    }
    void detachedChats.focus(nextConversation.id).then((focused) => {
      // A dock event can overtake React's projection of the native registry.
      // Falling back here makes the explicit return-to-main action race-safe.
      if (!focused) selectConversationInMain(nextConversation);
    }).catch(() => selectConversationInMain(nextConversation));
  }, [detachedChats, selectConversationInMain]);
  const openConversationInWindow = useCallback((
    nextConversation: Conversation,
  ): void => {
    setActionError(null);
    if (detachedChats.conversationIds.has(nextConversation.id)) {
      void detachedChats.focus(nextConversation.id).catch((error: unknown) => {
        setActionError(error instanceof Error
          ? error.message
          : "The chat window could not be focused.");
      });
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
    const wasSplit = splitConversationId === nextConversation.id;
    setSuppressedMainConversationIds((current) => {
      if (current.has(nextConversation.id)) return current;
      const next = new Set(current);
      next.add(nextConversation.id);
      return next;
    });
    if (wasSplit) updateSplitConversationId(null);

    // Let React unmount the current composer before the second renderer owns it.
    void new Promise<void>((resolve) => window.requestAnimationFrame(() => {
      resolve();
    })).then(() => detachedChats.open({
      conversationId: nextConversation.id,
      title: nextConversation.title.trim() || "Untitled chat",
      draft: preparation.draft,
    })).catch((error: unknown) => {
      if (!wasSuppressed) {
        setSuppressedMainConversationIds((current) => {
          const next = new Set(current);
          next.delete(nextConversation.id);
          return next;
        });
      }
      if (wasSplit) updateSplitConversationId(nextConversation.id);
      setActionError(error instanceof Error
        ? error.message
        : "The chat window could not be opened.");
    });
  }, [
    detachedChats,
    splitConversationId,
    suppressedMainConversationIds,
    updateSplitConversationId,
  ]);
  const openConversationInSplit = (nextConversation: Conversation): void => {
    if (
      !conversation
      || nextConversation.id === conversation.id
      || nextConversation.archivedAt !== null
    ) {
      return;
    }
    if (detachedChats.conversationIds.has(nextConversation.id)) {
      void detachedChats.focus(nextConversation.id).catch(() => undefined);
      return;
    }
    setSuppressedMainConversationIds((current) => {
      if (!current.has(nextConversation.id)) return current;
      const next = new Set(current);
      next.delete(nextConversation.id);
      return next;
    });
    updateSplitConversationId(nextConversation.id);
    setView("workspace");
    setSidebarOpen(false);
  };
  const activatePrimaryRunContext = (
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
  };
  const activityActions = useStableController(
    useActivityActions({
      project,
      conversationId: conversation?.id ?? null,
      run,
      setActiveTool: sceneSetActiveTool,
      setActionError,
      activateContext: activatePrimaryRunContext,
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
    targetProject: Project | null = project,
    location: NewConversationLocation = { kind: "defaults" },
  ) => {
    if (!targetProject) return;
    if (!connection.snapshot) return;
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
        discardDraftConversation();
        if (
          creationGeneration === conversationSelectionGenerationRef.current
        ) {
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
    setActiveTool: sceneSetActiveTool,
    setPaletteOpen,
    setSidebarCollapsed,
    setSidebarOpen,
  });
  const createConversationForSelection = async (
    selection: ModelSelection,
    options?: { prefillText?: string },
  ): Promise<void> => {
    if (draftConversation.chooseModel(selection)) return;
    if (!project) throw new Error("Select a project before creating a chat.");
    const selectionGeneration =
      conversationSelectionGenerationRef.current + 1;
    conversationSelectionGenerationRef.current = selectionGeneration;
    const event = await run("conversation.create", {
      type: "conversation.create",
      payload: {
        ...withNewConversationModelSelection(
          buildNewConversationPayload(project.id, settings),
          selection,
        ),
        activate: false,
      },
    });
    if (
      event.type !== "request.result"
      || event.result.kind !== "conversation.created"
    ) throw new Error("The new chat could not be identified.");
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
    if (options?.prefillText) {
      const conversationId = event.result.conversationId;
      window.requestAnimationFrame(() => requestComposerPrefill({
        conversationId,
        text: options.prefillText!,
      }));
    }
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
    if (updates.workspaceStartupSurface) {
      showStartupSurface(updates.workspaceStartupSurface);
    }
  };
  useEffect(() => {
    if (
      !connection.snapshot
      || !legacyWorkspaceStartup
      || legacyWorkspaceStartupMigrationRef.current
    ) return;
    legacyWorkspaceStartupMigrationRef.current = true;
    void request({
      type: "settings.update",
      payload: {
        workspaceStartupSurface: legacyWorkspaceStartup.surface,
      },
    }).then(() => {
      finishLegacyWorkspaceStartupMigration(
        window.localStorage,
        legacyWorkspaceStartup,
      );
    }).catch(() => {
      legacyWorkspaceStartupMigrationRef.current = false;
    });
  }, [connection.snapshot, legacyWorkspaceStartup, request]);
  const chooseCodexBinary = async (): Promise<void> => {
    const path = await window.inertia.selectCodexExecutable();
    if (path) await updateSettings({ codexBinaryPath: path });
  };
  const cycleTheme = () => {
    void updateSettings({
      theme: nextQuickTheme(settings.theme, window.matchMedia("(prefers-color-scheme: dark)").matches),
    }).catch(() => undefined);
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
  const openConnectionsSettings = useCallback(() => {
    setSettingsTarget({ section: "connections" });
    navigateToView("settings");
  }, [navigateToView]);

  useEffect(() => {
    if (view !== "settings" && settingsTarget) setSettingsTarget(null);
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
      openProjectPath,
      followUpSubagent: (trace: SubagentTrace) => {
        if (!conversation || !canFollowUpSubagentTrace(
          trace,
          conversationProjection.turns,
        )) return;
        const task = trace.description ?? trace.providerRole ?? "delegated task";
        requestComposerPrefill({
          conversationId: conversation.id,
          text: `Please follow up on the delegated task “${task}” and incorporate its latest result.`,
        });
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
  });
  const workspaceScene = useMemo(() => createWorkspaceSceneModel({
    view: view === "settings" ? "settings" : "workspace",
    settingsTarget,
    settings,
    busyAction,
    project,
    draftConversation: draftConversation.conversation,
    workspaceToolsUnavailable,
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
    planSteps,
    agentWorkflows,
    project,
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
  const splitWorkspace = useSplitWorkspaceScene({
    conversation,
    project,
    splitConversation,
    visible: browserWorkspaceVisible && !splitConversationDetached,
    layout: secondaryPaneLayout,
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
      openProjectPath,
      sendMessageToConversation,
      compactConversation: compactConversationById,
      updateConversationById,
    },
    sendingConversationIds,
    secondaryPaneFirst,
    primaryToolsOpen: primaryPaneLayout.activeTool !== null,
    onTogglePrimaryTools: primaryPaneLayout.toggleWorkspaceTools,
    onSwapPanes: () => setSecondaryPaneFirst((current) => !current),
    onCloseSecondary: () => updateSplitConversationId(null),
    onSecondaryConversationCreated: updateSplitConversationId,
    onTerminal: () => setGitRefreshVersion((version) => version + 1),
  });
  const openWorkspaceRunPreview = useCallback((run: PreviewWorkspaceRun) => {
    routeWorkspaceRunPreview(
      run,
      splitConversation?.id ?? null,
      openPrimaryWorkspaceRunPreview,
      splitWorkspace.openWorkspaceRunPreview,
    );
  }, [
    openPrimaryWorkspaceRunPreview,
    splitConversation?.id,
    splitWorkspace,
  ]);
  const visibleSplitScene = useMemo(() => {
    if (splitConversationDetached) return null;
    const splitScene = splitWorkspace.scene;
    if (!splitScene) return null;
    const secondaryTools = splitScene?.secondary.tools;
    const detachedActions = {
      onOpenPrimaryInWindow: conversation
        ? () => openConversationInWindow(conversation)
        : undefined,
      onOpenSecondaryInWindow: splitConversation
        ? () => openConversationInWindow(splitConversation)
        : undefined,
    };
    if (!secondaryTools) return { ...splitScene, ...detachedActions };
    return {
      ...splitScene,
      ...detachedActions,
      secondary: {
        ...splitScene.secondary,
        tools: {
          ...secondaryTools,
          environment: {
            ...secondaryTools.environment,
            onOpenRunPreview: openWorkspaceRunPreview,
          },
        },
      },
    };
  }, [
    conversation,
    openConversationInWindow,
    openWorkspaceRunPreview,
    splitConversation,
    splitConversationDetached,
    splitWorkspace.scene,
  ]);
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
      environment: {
        ...workspaceScene.tools.environment,
        onOpenRunPreview: openWorkspaceRunPreview,
      },
    } : null,
    detachedChat: conversation && primaryConversationSuppressed ? {
      title: conversation.title,
      windowOpen: detachedChats.conversationIds.has(conversation.id),
      onActivate: () => selectConversation(conversation),
    } : null,
    splitScene: visibleSplitScene,
  }), [
    conversation,
    detachedChats.conversationIds,
    openWorkspaceRunPreview,
    primaryConversationSuppressed,
    selectConversation,
    sendingConversationIds,
    visibleSplitScene,
    workspaceScene,
  ]);

  if (!detachedChats.ready) {
    return (
      <main className="app-startup-loading" aria-busy="true">
        <LoadingMark label="Restoring chat windows" />
      </main>
    );
  }

  return (
    <>
    {addProjectOpen && <Suspense fallback={null}><AddProjectDialog onClose={() => setAddProjectOpen(false)} onImport={confirmProjectImport} /></Suspense>}
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
      setView={navigateToView}
      busyAction={busyAction}
      visibleError={visibleError}
      setActionError={setActionError}
      commitDialogOpen={commitDialogOpen}
      setCommitDialogOpen={setCommitDialogOpen}
      dailyWorkOpen={dailyWorkOpen}
      setDailyWorkOpen={setDailyWorkOpen}
      paletteOpen={paletteOpen}
      setPaletteOpen={setPaletteOpen}
      project={project}
      conversation={conversation}
      splitConversationId={splitConversation?.id ?? null}
      detachedConversationIds={detachedChats.conversationIds}
      detachedChatLimitReached={detachedChats.atLimit}
      conversationSuppressedInMain={primaryConversationSuppressed}
      sceneActiveTool={sceneHeaderActiveTool}
      sceneToggleWorkspaceTools={sceneToggleWorkspaceTools}
      sceneOpenEnvironment={sceneOpenEnvironment}
      sceneOpenBrowser={sceneOpenBrowser}
      workspaceToolsUnavailableReason={workspaceToolsUnavailableReason}
      gitStatus={gitStatus}
      branches={branches}
      projectActions={projectActions}
      reviewStates={reviewStates}
      multiSpawn={multiSpawn}
      scene={visibleWorkspaceScene}
      usage={{ status: connection.status, request }}
      providerAuth={{
        provider: authProvider,
        status: connection.status,
        theme: settings.theme,
        colorTheme: settings.colorTheme,
        fontSize: settings.terminalFontSize,
        sendCommand,
        subscribe: connection.subscribe,
        onClose: closeProviderAuth,
      }}
      actions={{
        run: runUserCommand,
        importProject,
        selectProject,
        selectConversation,
        openConversationInSplit,
        openConversationInWindow,
        closeConversationSplit: () => updateSplitConversationId(null),
        openProviderSetup,
        openBackendSetup,
        openConnectionsSettings,
        createConversation,
        updateSettings,
        openProjectPath,
        cycleTheme,
        loadBranches,
        mutateBranch,
        loadGit: () => loadGit({ authoritative: true }),
        loadCommitReview: workspaceTools.loadCommitReview,
        discardCommitReview: workspaceTools.discardCommitReview,
        commitReviewRevision: workspaceTools.commitReviewRevision,
        commit,
        runProjectAction,
        acknowledgeActivity,
        dismissActivity,
      }}
    />
    </>
  );
}
