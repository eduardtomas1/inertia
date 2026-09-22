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
import type { SplitPaneDetails } from "../components/WorkspaceScene";
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
import { requestComposerPrefill } from "../utils/composerPrefill";
import { canFollowUpSubagentTrace } from "../utils/subagentDisclosure";
import type { SplitPaneOwner } from "../utils/splitLayout";
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
import { usePlanSteps } from "./usePlanSteps";
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

export interface SplitWorkspaceSceneController {
  pane: SplitPaneDetails | null;
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
    | "openSettings"
    | "openUsageView"
    | "openProjectPath"
  > {
  sendMessageToConversation: (
    conversationId: string,
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
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
  owner: Exclude<SplitPaneOwner, "primary">;
  splitConversation: Conversation | null;
  visible: boolean;
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
  onConversationCreated: (conversationId: string) => void;
  onTerminal: () => void;
}

/**
 * Owns every stateful controller behind one split pane. Nothing in this
 * hook resolves paths or tools through the primary project, which makes the
 * cross-project split boundary explicit and reviewable.
 */
export function useSplitWorkspaceScene({
  owner,
  splitConversation,
  visible,
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
  onConversationCreated,
  onTerminal,
}: UseSplitWorkspaceSceneOptions): SplitWorkspaceSceneController {
  const busyPrefix = `split:${owner}:`;
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
    subscriptionOwner: owner,
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
    const busyKey = `${busyPrefix}${key}`;
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
    busyPrefix,
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
    loadGitOnMount:
      layout.activeTool === "changes"
      || layout.activeTool === "files",
    gitStatusOnly: layout.activeTool === "files",
    loadFilesOnMount: layout.activeTool === "files",
  }));
  const desktopTools = useStableController(useDesktopTools({
    setActionError,
    previewOwnerId: owner,
    previewContextId: visible ? splitConversation?.id ?? null : null,
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
  const focusPreview = useCallback(() => {
    focusWorkspacePreviewAddress(owner);
  }, [owner]);
  const activityActions = useStableController(useActivityActions({
    project: splitProject,
    conversationId: splitConversation?.id ?? null,
    run,
    openTerminal: layout.openTerminal,
    setActionError,
    activateContext: activatePreviewContext,
    navigatePreview: desktopTools.navigatePreview,
    focusPreview,
  }));
  const planSteps = usePlanSteps(
    projection.plans,
    projection.messages,
    splitConversation?.status ?? "idle",
    projection.streaming,
  );
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
      options?: { prefillText?: string; configuration?: Pick<Conversation, "accessMode" | "interactionMode"> },
    ) => {
      if (!splitProject) {
        throw new Error("The split project is no longer available.");
      }
      const event = resultEvent(await run("conversation.create", {
        type: "conversation.create",
        payload: {
          ...withNewConversationModelSelection(
            buildNewConversationPayload(splitProject, settings),
            selection,
          ),
          ...options?.configuration,
          activate: false,
        },
      }));
      if (event.result.kind !== "conversation.created") {
        throw new Error("The new split chat could not be identified.");
      }
      onConversationCreated(event.result.conversationId);
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
    ) => {
      if (!splitConversation) return null;
      return await actions.sendMessageToConversation(
        splitConversation.id,
        content,
        attachments,
        context,
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
    busyAction: busyAction?.startsWith(busyPrefix)
      ? busyAction.slice(busyPrefix.length)
      : null,
    project: splitProject,
    draftConversation: null,
    globalChatActive: false,
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
    busyPrefix,
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

  const pane = useMemo((): SplitPaneDetails | null => {
    if (!splitConversation || !splitProject) return null;
    return {
      owner,
      conversationId: splitConversation.id,
      title: splitConversation.title,
      projectName: splitProject.name,
      toolsOpen: layout.activeTool !== null,
      onToggleTools: layout.toggleWorkspaceTools,
      terminalOpen: layout.terminalOpen,
      onToggleTerminal: layout.toggleTerminal,
      scene: {
        detailState: model.detailState,
        chat: {
          ...model.chat,
          sending: sendingConversationIds.has(splitConversation.id),
        },
        resizeHandle: model.resizeHandle,
        tools: model.tools,
      },
    };
  }, [
    layout.activeTool,
    layout.terminalOpen,
    layout.toggleTerminal,
    layout.toggleWorkspaceTools,
    model,
    owner,
    sendingConversationIds,
    splitConversation,
    splitProject,
  ]);
  return useMemo(() => ({
    pane,
    openWorkspaceRunPreview: activityActions.openWorkspaceRunPreview,
  }), [activityActions.openWorkspaceRunPreview, pane]);
}
