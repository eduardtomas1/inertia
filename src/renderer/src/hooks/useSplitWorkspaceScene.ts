import {
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  AppSettings,
  ChatAttachment,
  Conversation,
  ModelSelection,
  MessageSendAcceptance,
  Project,
  ProviderMaintenanceProviderId,
  ServerEvent,
  SubagentTrace,
  TurnRequestContext,
} from "@shared/contracts";

import type { useAppUpdate } from "../app-update";
import type { WorkspaceSceneProps } from "../components/WorkspaceScene";
import {
  createWorkspaceSceneModel,
  type WorkspaceSceneActions,
} from "../components/workspace-scene/createWorkspaceSceneModel";
import { createWorkspaceTurnActions } from "../components/workspace-scene/createWorkspaceTurnActions";
import {
  buildNewConversationPayload,
  withNewConversationModelSelection,
} from "../lib/newConversation";
import {
  commandRefreshesConversationDetail,
  resultEvent,
  withRequestId,
  type CommandWithoutId,
} from "../lib/runtimeCommands";
import { planFromText } from "../utils/planFromText";
import { requestComposerPrefill } from "../utils/composerPrefill";
import { canFollowUpSubagentTrace } from "../utils/subagentDisclosure";
import { focusWorkspacePreviewAddress } from "../utils/workspacePreviewFocus";
import {
  useActivityActions,
  type PreviewWorkspaceRun,
} from "./useActivityActions";
import {
  agentWorkflowRouteIdentity,
  useAgentWorkflows,
} from "./useAgentWorkflows";
import type { useBackendProfiles } from "./useBackendProfiles";
import type {
  ConversationPaneLayout,
} from "./useConversationPaneLayout";
import { useConversationProjection } from "./useConversationProjection";
import { useDesktopTools } from "./useDesktopTools";
import type { useInertiaConnection } from "./useInertiaConnection";
import type { useProviderMaintenance } from "./useProviderMaintenance";
import {
  useStableActions,
  useStableController,
} from "./useStableController";
import { useWorkspaceTools } from "./useWorkspaceTools";

type Connection = ReturnType<typeof useInertiaConnection>;
type ProviderMaintenance = ReturnType<typeof useProviderMaintenance>;
type BackendProfileActions = ReturnType<typeof useBackendProfiles>;
type AppUpdate = ReturnType<typeof useAppUpdate>;

const ignoreLatestContentVisibility = (): void => undefined;
const focusSecondaryPreview = (): void => {
  focusWorkspacePreviewAddress("secondary");
};

export interface SplitWorkspaceSceneController {
  scene: WorkspaceSceneProps["splitScene"];
  openWorkspaceRunPreview: (run: PreviewWorkspaceRun) => void;
}

interface SplitWorkspaceActions
  extends Pick<
    WorkspaceSceneActions,
    | "importProject"
    | "createConversation"
    | "respondToApproval"
    | "respondToInput"
    | "updateSettings"
    | "chooseCodexBinary"
    | "refreshProvider"
    | "connectProvider"
    | "openProviderSetup"
    | "openBackendSetup"
    | "openProjectPath"
  > {
  sendMessageToConversation: (
    conversationId: string,
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    skillIds?: readonly string[],
    activate?: boolean,
  ) => Promise<MessageSendAcceptance | null>;
  compactConversation: (
    conversationId: string,
    instruction?: string,
  ) => Promise<{
    message: string;
    instructionForwarded: boolean;
  }>;
  updateConversationById: (
    conversationId: string,
    update: Parameters<WorkspaceSceneActions["updateConversation"]>[0],
  ) => Promise<void>;
}

interface UseSplitWorkspaceSceneOptions {
  conversation: Conversation | null;
  project: Project | null;
  splitConversation: Conversation | null;
  layout: ConversationPaneLayout;
  snapshotProjects: Project[];
  settings: AppSettings;
  connection: Connection;
  providerMaintenance: ProviderMaintenance;
  backendProfileActions: BackendProfileActions;
  appUpdate: AppUpdate;
  busyAction: string | null;
  setBusyAction: Dispatch<SetStateAction<string | null>>;
  setActionError: Dispatch<SetStateAction<string | null>>;
  gitRefreshVersion: number;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  actions: SplitWorkspaceActions;
  sendingConversationIds: ReadonlySet<string>;
  secondaryPaneFirst: boolean;
  primaryToolsOpen: boolean;
  onTogglePrimaryTools: () => void;
  onSwapPanes: () => void;
  onCloseSecondary: () => void;
  onSecondaryConversationCreated: (conversationId: string) => void;
  onTerminal: () => void;
}

/**
 * Owns every stateful controller behind the secondary pane. Nothing in this
 * hook resolves paths or tools through the primary project, which makes the
 * cross-project split boundary explicit and reviewable.
 */
export function useSplitWorkspaceScene({
  conversation,
  project,
  splitConversation,
  layout,
  snapshotProjects,
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
  actions,
  sendingConversationIds,
  secondaryPaneFirst,
  primaryToolsOpen,
  onTogglePrimaryTools,
  onSwapPanes,
  onCloseSecondary,
  onSecondaryConversationCreated,
  onTerminal,
}: UseSplitWorkspaceSceneOptions): SplitWorkspaceSceneController {
  const splitProject = useMemo(
    () => splitConversation
      ? snapshotProjects.find(
          ({ id }) => id === splitConversation.projectId,
        ) ?? null
      : null,
    [snapshotProjects, splitConversation],
  );
  const projection = useStableController(useConversationProjection({
    snapshot: connection.snapshot,
    status: connection.status,
    request,
    subscribe: connection.subscribe,
    targetConversationId: splitConversation?.id ?? null,
    enabled: Boolean(splitConversation),
    autoOpenPlan: false,
    onOpenPlan: () => undefined,
    onTerminal,
  }));
  const workflow = useStableController(useAgentWorkflows({
    conversationId: splitConversation?.id ?? null,
    routeIdentity: agentWorkflowRouteIdentity(
      splitConversation,
      splitProject,
    ),
    status: connection.status,
    enabled: Boolean(splitConversation),
    request,
    subscribe: connection.subscribe,
  }));
  const run = useCallback(async (
    key: string,
    command: CommandWithoutId,
  ): Promise<ServerEvent> => {
    const busyKey = `split:${key}`;
    setBusyAction(busyKey);
    setActionError(null);
    try {
      const event = await connection.sendCommand(withRequestId(command));
      if (commandRefreshesConversationDetail(command, event)) {
        projection.refreshDetail();
      }
      return event;
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "That split-chat action could not be completed.",
      );
      throw error;
    } finally {
      setBusyAction((current) => current === busyKey ? null : current);
    }
  }, [
    connection,
    projection,
    setActionError,
    setBusyAction,
  ]);
  const tools = useStableController(useWorkspaceTools({
    enabled: Boolean(splitConversation && splitProject),
    project: splitProject,
    conversation: splitConversation,
    detail: projection.detail,
    online: connection.status === "online",
    ignoreWhitespace: settings.ignoreWhitespace,
    confirmDestructiveActions: settings.confirmDestructiveActions,
    refreshVersion: gitRefreshVersion,
    request,
    run,
    subscribe: connection.subscribe,
    setActionError,
    setActiveTool: layout.setActiveTool,
    loadGitStatusOnMount: Boolean(splitConversation && splitProject),
    loadGitOnMount: layout.activeTool === "changes",
    loadFilesOnMount: layout.activeTool === "files",
  }));
  const desktopTools = useStableController(useDesktopTools({
    setActionError,
    previewOwnerId: "secondary",
    previewContextId: splitConversation?.id ?? null,
  }));
  const activatePreviewContext = useCallback((run: PreviewWorkspaceRun) => {
    if (
      !splitProject
      || !splitConversation
      || run.projectId !== splitProject.id
      || run.conversationId !== splitConversation.id
    ) {
      return false;
    }
    layout.setActiveTool("preview");
    return true;
  }, [layout, splitConversation, splitProject]);
  const activityActions = useStableController(useActivityActions({
    project: splitProject,
    conversationId: splitConversation?.id ?? null,
    run,
    setActiveTool: layout.setActiveTool,
    setActionError,
    activateContext: activatePreviewContext,
    navigatePreview: desktopTools.navigatePreview,
    focusPreview: focusSecondaryPreview,
  }));
  const planSteps = useMemo(() => {
    if (!splitConversation) return [];
    const latestPlan = projection.plans.at(-1);
    if (latestPlan) {
      return latestPlan.steps.map((step, index) => ({
        id: `native-${index}`,
        title: step.step,
        status: step.status === "inProgress"
          ? "in-progress" as const
          : step.status,
      }));
    }
    const text = [...projection.messages]
      .reverse()
      .find((message) => message.role === "assistant")?.content
      ?? projection.streamingText;
    return planFromText(text, splitConversation.status);
  }, [
    projection.messages,
    projection.plans,
    projection.streamingText,
    splitConversation,
  ]);
  const turnActions = useMemo(() => createWorkspaceTurnActions({
    conversation: splitConversation,
    confirmDestructiveActions: settings.confirmDestructiveActions,
    run,
    loadGit: tools.loadGit,
    openTurnDiff: tools.openTurnDiff,
    compareTurnArtifacts: tools.compareTurnArtifacts,
  }), [
    run,
    settings.confirmDestructiveActions,
    splitConversation,
    tools,
  ]);
  const sceneActions = useStableActions({
    ...actions,
    createConversationForSelection: async (
      selection: ModelSelection,
      options?: { prefillText?: string },
    ) => {
      if (!splitProject) {
        throw new Error("The split project is no longer available.");
      }
      const event = resultEvent(await run("conversation.create", {
        type: "conversation.create",
        payload: {
          ...withNewConversationModelSelection(
            buildNewConversationPayload(splitProject.id, settings),
            selection,
          ),
          activate: false,
        },
      }));
      if (event.result.kind !== "conversation.created") {
        throw new Error("The new split chat could not be identified.");
      }
      onSecondaryConversationCreated(event.result.conversationId);
      if (options?.prefillText) {
        const conversationId = event.result.conversationId;
        window.requestAnimationFrame(() => requestComposerPrefill({
          conversationId,
          text: options.prefillText!,
        }));
      }
    },
    sendMessage: async (
      content: string,
      attachments: ChatAttachment[],
      context?: TurnRequestContext,
      skillIds?: readonly string[],
    ) => {
      if (!splitConversation) return null;
      return await actions.sendMessageToConversation(
        splitConversation.id,
        content,
        attachments,
        context,
        skillIds,
        false,
      );
    },
    compactConversation: async (instruction?: string) => {
      if (!splitConversation) {
        throw new Error("This chat is not ready to compact.");
      }
      return await actions.compactConversation(
        splitConversation.id,
        instruction,
      );
    },
    listSkills: workflow.listSkills,
    toggleSkill: workflow.toggleSkill,
    clearSelectedSkills: workflow.clearSelectedSkills,
    setGoal: workflow.setGoal,
    clearGoal: workflow.clearGoal,
    updateConversation: async (
      update: Parameters<WorkspaceSceneActions["updateConversation"]>[0],
    ): Promise<void> => {
      if (splitConversation) {
        await actions.updateConversationById(splitConversation.id, update);
      }
    },
    followUpSubagent: (trace: SubagentTrace) => {
      if (!splitConversation || !canFollowUpSubagentTrace(
        trace,
        projection.turns,
      )) return;
      const task = trace.description ?? trace.providerRole ?? "delegated task";
      requestComposerPrefill({
        conversationId: splitConversation.id,
        text: `Please follow up on the delegated task “${task}” and incorporate its latest result.`,
      });
    },
    ...turnActions,
    stopSubagent: async (trace: SubagentTrace) => {
      try {
        await turnActions.stopSubagent(trace);
      } catch (error) {
        setActionError(error instanceof Error
          ? error.message
          : "The delegated task could not be stopped.");
        throw error;
      }
    },
    run,
  });
  const model = useMemo(() => createWorkspaceSceneModel({
    view: "workspace",
    settingsTarget: null,
    settings,
    busyAction: busyAction?.startsWith("split:")
      ? busyAction.slice("split:".length)
      : null,
    project: splitProject,
    draftConversation: null,
    workspaceToolsUnavailable: false,
    connection,
    providerMaintenance,
    projection,
    layout,
    workspaceTools: tools,
    backendProfileActions,
    desktopTools,
    activityActions,
    appUpdate,
    planSteps,
    workflow,
    detailLoading: Boolean(
      splitConversation
      && (
        projection.detailState?.conversationId !== splitConversation.id
        || projection.detailState.state === "loading"
      )
    ),
    selectedMaintenanceStatus: splitConversation
      ? providerMaintenance.statuses.get(
          splitConversation.providerId as ProviderMaintenanceProviderId,
        ) ?? null
      : null,
    selectedMaintenanceOperation: splitConversation
      ? providerMaintenance.operations.get(
          splitConversation.providerId as ProviderMaintenanceProviderId,
        ) ?? null
      : null,
    actions: sceneActions,
    setActionError,
    setLatestContentVisible: ignoreLatestContentVisibility,
  }), [
    activityActions,
    appUpdate,
    backendProfileActions,
    busyAction,
    connection,
    desktopTools,
    layout,
    planSteps,
    projection,
    providerMaintenance,
    sceneActions,
    setActionError,
    settings,
    splitConversation,
    splitProject,
    tools,
    workflow,
  ]);

  const scene = useMemo(() => {
    if (!splitConversation || !splitProject) return null;
    return {
      secondary: {
        detailState: model.detailState,
        chat: {
          ...model.chat,
          sending: sendingConversationIds.has(splitConversation.id),
        },
        resizeHandle: model.resizeHandle,
        tools: model.tools,
      },
      primaryTitle: conversation?.title ?? "Primary chat",
      secondaryTitle: splitConversation.title,
      primaryProjectName: project?.name ?? "Project",
      secondaryProjectName: splitProject.name,
      primaryToolsOpen,
      secondaryToolsOpen: layout.activeTool !== null,
      secondaryFirst: secondaryPaneFirst,
      onTogglePrimaryTools,
      onToggleSecondaryTools: layout.toggleWorkspaceTools,
      onSwapPanes,
      onCloseSecondary,
    };
  }, [
    conversation?.title,
    layout.activeTool,
    layout.toggleWorkspaceTools,
    model,
    onCloseSecondary,
    onSwapPanes,
    onTogglePrimaryTools,
    primaryToolsOpen,
    project?.name,
    secondaryPaneFirst,
    sendingConversationIds,
    splitConversation,
    splitProject,
  ]);
  return useMemo(() => ({
    scene,
    openWorkspaceRunPreview: activityActions.openWorkspaceRunPreview,
  }), [activityActions.openWorkspaceRunPreview, scene]);
}
