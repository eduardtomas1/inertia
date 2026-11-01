import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AppSettings,
  ChatAttachment,
  Project,
  ProviderId,
  SubagentTrace,
  TurnRequestContext,
} from "@shared/contracts";

import { createWorkspaceSceneModel } from "../workspace-scene/createWorkspaceSceneModel";
import { createWorkspaceTurnActions } from "../workspace-scene/createWorkspaceTurnActions";
import { useActivityActions, type PreviewWorkspaceRun } from "../../hooks/useActivityActions";
import { agentWorkflowRouteIdentity, useAgentWorkflows } from "../../hooks/useAgentWorkflows";
import { useAppRuntimeActions } from "../../hooks/useAppRuntimeActions";
import { useBackendProfiles } from "../../hooks/useBackendProfiles";
import { useConversationProjection } from "../../hooks/useConversationProjection";
import { useConversationWorkspaceOptions } from "../../hooks/useConversationWorkspaceOptions";
import { useDesktopTools } from "../../hooks/useDesktopTools";
import type { useInertiaConnection } from "../../hooks/useInertiaConnection";
import { usePlanSteps } from "../../hooks/usePlanSteps";
import { useStableActions, useStableController } from "../../hooks/useStableController";
import { useWorkspaceLayout } from "../../hooks/useWorkspaceLayout";
import { useWorkspaceTools } from "../../hooks/useWorkspaceTools";
import type { NewConversationLocation } from "../../lib/newConversation";
import { withRequestId, type CommandWithoutId } from "../../lib/runtimeCommands";
import { workspaceRunPreviewUrl } from "../../utils/environmentSummary";
import { requestSubagentFollowUp } from "../../utils/subagentFollowUp";
import type { WorkspaceSceneProps } from "../WorkspaceScene";
import { adoptTerminalHandoff, terminalStorageKey } from "../terminalTabStorage";
import {
  DETACHED_APP_UPDATE,
  DETACHED_HIDDEN_SURFACES,
  DETACHED_PROVIDER_MAINTENANCE,
} from "./detachedSceneServices";
import { newChatTarget } from "./detachedTargets";
import type { DetachedHandoff } from "./useDetachedHandoff";

type Connection = ReturnType<typeof useInertiaConnection>;

interface DetachedWorkspaceSceneOptions {
  conversationId: string;
  terminalHandoffIds: readonly string[];
  connection: Connection;
  settings: AppSettings;
  handoff: DetachedHandoff;
  busyAction: string | null;
  setBusyAction: Dispatch<SetStateAction<string | null>>;
  setActionError: Dispatch<SetStateAction<string | null>>;
}

export function useDetachedWorkspaceScene({
  conversationId,
  terminalHandoffIds,
  connection,
  settings,
  handoff,
  busyAction,
  setBusyAction,
  setActionError,
}: DetachedWorkspaceSceneOptions) {
  const [latestContentVisible, setLatestContentVisible] = useState(false);
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const refreshGit = useCallback(() => setGitRefreshVersion((version) => version + 1), []);
  const snapshotConversation = connection.snapshot?.conversations.find(
    ({ id }) => id === conversationId,
  ) ?? null;
  const projectId = snapshotConversation?.projectId ?? null;
  const project = useMemo<Project | null>(
    () => connection.snapshot?.projects.find(({ id }) => id === projectId) ?? null,
    [connection.snapshot?.projects, projectId],
  );
  const layout = useWorkspaceLayout("workspace", Boolean(project), {
    startupReady: Boolean(connection.snapshot),
    workspaceId: project ? `${project.id}:${conversationId}` : null,
  });
  const setActiveTool = layout.setActiveTool;
  const handoffProjectId = project?.id ?? null;
  const openTerminal = layout.openTerminal;
  useLayoutEffect(() => {
    if (
      handoffProjectId
      && adoptTerminalHandoff(
        terminalStorageKey(handoffProjectId, conversationId),
        terminalHandoffIds,
      )
    ) openTerminal();
  }, [conversationId, handoffProjectId, openTerminal, terminalHandoffIds]);
  const sendCommand = connection.sendCommand;
  const request = useCallback(
    (command: CommandWithoutId) => sendCommand(withRequestId(command)),
    [sendCommand],
  );
  const projection = useStableController(useConversationProjection({
    snapshot: connection.snapshot,
    status: connection.status,
    request,
    subscribe: connection.subscribe,
    targetConversationId: conversationId,
    enabled: true,
    autoOpenPlan: settings.autoOpenPlan,
    onOpenPlan: (planConversationId) => {
      if (planConversationId === conversationId) setActiveTool("plan");
    },
    onTerminal: refreshGit,
  }));
  const conversation = projection.conversation;
  const workflow = useStableController(useAgentWorkflows({
    conversationId: conversation?.id ?? null,
    routeIdentity: agentWorkflowRouteIdentity(conversation, project),
    status: connection.status,
    enabled: Boolean(conversation),
    request,
    subscribe: connection.subscribe,
  }));
  const runtimeActions = useStableController(useAppRuntimeActions({
    sendCommand: connection.sendCommand,
    refreshDetail: projection.refreshDetail,
    setBusyAction,
    setActionError,
  }));
  const run = runtimeActions.run;
  const backendProfiles = useStableController(useBackendProfiles({ request, run }));
  const desktopTools = useStableController(useDesktopTools({
    setActionError,
    previewContextId: null,
  }));
  const toolsReady = Boolean(conversation && project);
  const tools = useStableController(useWorkspaceTools({
    enabled: toolsReady,
    project,
    conversation,
    detail: projection.detail,
    online: connection.status === "online",
    ignoreWhitespace: settings.ignoreWhitespace,
    confirmDestructiveActions: settings.confirmDestructiveActions,
    refreshVersion: gitRefreshVersion,
    request,
    run,
    subscribe: connection.subscribe,
    setActionError,
    setActiveTool,
    onBranchChanged: refreshGit,
    loadGitStatusOnMount: toolsReady,
    loadGitOnMount: layout.activeTool === "changes" || layout.activeTool === "files",
    gitStatusOnly: layout.activeTool === "files",
    loadFilesOnMount: layout.activeTool === "files",
  }));
  const activityActions = useStableController(useActivityActions({
    project,
    conversationId: conversation?.id ?? null,
    run,
    openTerminal: layout.openTerminal,
    setActionError,
  }));
  const planSteps = usePlanSteps(
    projection.plans,
    projection.messages,
    conversation?.status ?? "idle",
    projection.streaming,
  );
  const turnActions = useMemo(() => createWorkspaceTurnActions({
    conversation,
    confirmDestructiveActions: settings.confirmDestructiveActions,
    run,
    loadGit: tools.loadGit,
    openTurnDiff: tools.openTurnDiff,
    compareTurnArtifacts: tools.compareTurnArtifacts,
  }), [conversation, run, settings.confirmDestructiveActions, tools]);
  const sceneActions = useStableActions({
    importProject: async () => handoff.dockInMain(),
    createConversation: (
      targetProject?: Project | null,
      location?: NewConversationLocation,
    ) => {
      const target = targetProject ?? project;
      if (target) handoff.openInMain(newChatTarget(target.id, location));
    },
    sendMessage: (
      content: string,
      attachments: ChatAttachment[],
      context?: TurnRequestContext,
    ) => runtimeActions.sendMessageToConversation(
      conversationId,
      content,
      attachments,
      context,
      false,
    ),
    compactConversation: (instruction?: string) =>
      runtimeActions.compactConversation(conversationId, instruction),
    compactAndSendMessage: (
      content: string,
      attachments: ChatAttachment[],
      context?: TurnRequestContext,
    ) => runtimeActions.compactAndSendToConversation(
      conversationId,
      content,
      attachments,
      context,
      false,
    ),
    listSkills: workflow.listSkills,
    setGoal: workflow.setGoal,
    clearGoal: workflow.clearGoal,
    respondToApproval: async (
      approval: AgentApprovalRequest,
      decision: AgentApprovalDecision,
    ): Promise<void> => {
      await run("agent.approval.respond", {
        type: "agent.approval.respond",
        payload: {
          conversationId: approval.conversationId,
          requestId: approval.id,
          decision,
        },
      });
    },
    respondToInput: async (
      input: AgentInputRequest,
      answers: Record<string, string[]>,
    ): Promise<void> => {
      await run("agent.input.respond", {
        type: "agent.input.respond",
        payload: {
          conversationId: input.conversationId,
          requestId: input.id,
          answers,
        },
      });
    },
    updateConversation: (
      update: Parameters<typeof runtimeActions.updateConversationById>[1],
    ) => runtimeActions.updateConversationById(conversationId, update),
    updateSettings: async (update: Partial<AppSettings>): Promise<void> => {
      await run("settings.update", { type: "settings.update", payload: update });
    },
    setUsageDisplayMode: (usageDisplayMode: AppSettings["usageDisplayMode"]) => {
      void run("settings.update", {
        type: "settings.update",
        payload: { usageDisplayMode },
      }).catch(() => undefined);
    },
    clearPromptContext: () => tools.setPendingDiffContext(null),
    chooseCodexBinary: async () => undefined,
    refreshProvider: (providerId?: ProviderId) => {
      if (!providerId) return;
      void run("provider.refresh", {
        type: "provider.refresh",
        payload: { providerId },
      }).catch(() => undefined);
    },
    refreshUsage: runtimeActions.refreshUsage,
    connectProvider: (providerId: ProviderId) =>
      handoff.openInMain({ kind: "provider-setup", providerId }),
    openProviderSetup: () => handoff.openInMain({ kind: "settings", page: "agents" }),
    openBackendSetup: (profileId: string) =>
      handoff.openInMain({ kind: "backend-setup", profileId }),
    openSettings: () => handoff.openInMain({ kind: "settings", page: "appearance" }),
    openProjectPath: runtimeActions.openProjectPath,
    followUpSubagent: (trace: SubagentTrace) => {
      requestSubagentFollowUp(conversationId, trace, projection.turns);
    },
    ...turnActions,
    run,
    runConversationContextCommand: run,
    runQueueCommand: runtimeActions.runQueueCommand,
    runLimitResetCommand: runtimeActions.runLimitResetCommand,
    loadBackgroundTasks: runtimeActions.loadBackgroundTasks,
  });
  const workspaceOptions = useConversationWorkspaceOptions({
    connection,
    projection,
    draftConversation: null,
    project,
    workspaceToolsUnavailable: false,
  });
  const detailState = projection.detailState?.conversationId === conversationId
    ? projection.detailState
    : null;
  const detailLoading = Boolean(
    conversation && (!detailState || detailState.state === "loading"),
  );
  const openRunPreview = useCallback((activity: PreviewWorkspaceRun) => {
    const url = workspaceRunPreviewUrl(activity);
    if (!url) {
      setActionError(`Could not open ${activity.label}: its preview is no longer available.`);
      return;
    }
    void window.inertia.openExternal(url).catch(() => {
      setActionError(`Could not open ${activity.label}.`);
    });
  }, [setActionError]);
  const scene = useMemo((): WorkspaceSceneProps => {
    const model = createWorkspaceSceneModel({
      view: "workspace",
      settingsTarget: null,
      settings,
      busyAction,
      project,
      draftConversation: null,
      globalChatActive: false,
      workspaceToolsUnavailable: false,
      connection,
      providerMaintenance: DETACHED_PROVIDER_MAINTENANCE,
      projection,
      layout,
      workspaceTools: tools,
      backendProfileActions: backendProfiles,
      desktopTools,
      activityActions,
      appUpdate: DETACHED_APP_UPDATE,
      planSteps,
      workflow,
      detailLoading,
      selectedMaintenanceStatus: null,
      selectedMaintenanceOperation: null,
      workspaceOptions,
      actions: sceneActions,
      setActionError,
      setLatestContentVisible,
    });
    return {
      ...model,
      chat: {
        ...model.chat,
        loading: false,
        previewContextUrl: null,
        onForkCommand: undefined,
        sending: runtimeActions.sendingConversationIds.has(conversationId),
      },
      tools: model.tools ? {
        ...model.tools,
        panel: { ...model.tools.panel, hiddenSurfaces: DETACHED_HIDDEN_SURFACES },
        runs: { ...model.tools.runs, onOpenRunPreview: openRunPreview },
      } : null,
    };
  }, [
    activityActions,
    backendProfiles,
    busyAction,
    connection,
    conversationId,
    desktopTools,
    detailLoading,
    layout,
    openRunPreview,
    planSteps,
    project,
    projection,
    runtimeActions.sendingConversationIds,
    sceneActions,
    setActionError,
    settings,
    tools,
    workflow,
    workspaceOptions,
  ]);
  return {
    project,
    projection,
    workflow,
    runtimeActions,
    layout,
    tools,
    activityActions,
    scene,
    request,
    latestContentVisible,
    refreshGit,
  };
}
