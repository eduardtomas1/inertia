import type { ComponentProps, Dispatch, SetStateAction } from "react";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AppSettings,
  ChatAttachment,
  CheckpointSummary,
  Conversation,
  ModelSelection,
  Project,
  ProviderId,
  ProviderMaintenanceProviderId,
  ServerEvent,
  SubagentTrace,
  TurnRequestContext,
} from "@shared/contracts";

import type { PlanPanel } from "../PlanPanel";
import type { WorkspaceSceneProps } from "../WorkspaceScene";
import type { useActivityActions } from "../../hooks/useActivityActions";
import type { useAppUpdate } from "../../hooks/useAppUpdate";
import type { useBackendProfiles } from "../../hooks/useBackendProfiles";
import type { useConversationProjection } from "../../hooks/useConversationProjection";
import type { useDesktopTools } from "../../hooks/useDesktopTools";
import type { useInertiaConnection } from "../../hooks/useInertiaConnection";
import type { useProviderMaintenance } from "../../hooks/useProviderMaintenance";
import {
  TOOLS_MIN_HEIGHT,
  TOOLS_MIN_WIDTH,
  type useWorkspaceLayout,
} from "../../hooks/useWorkspaceLayout";
import type { useWorkspaceTools } from "../../hooks/useWorkspaceTools";
import type { NewConversationLocation } from "../../lib/newConversation";
import type { CommandWithoutId } from "../../lib/runtimeCommands";

type Connection = ReturnType<typeof useInertiaConnection>;
type ProviderMaintenance = ReturnType<typeof useProviderMaintenance>;
type ConversationProjection = ReturnType<typeof useConversationProjection>;
type WorkspaceLayout = ReturnType<typeof useWorkspaceLayout>;
type WorkspaceSceneLayout = Pick<
  WorkspaceLayout,
  | "activeTool"
  | "setActiveTool"
  | "stackedTools"
  | "toolsVisible"
  | "workspaceBodyRef"
  | "tools"
>;
type WorkspaceTools = ReturnType<typeof useWorkspaceTools>;
type BackendProfileActions = ReturnType<typeof useBackendProfiles>;
type DesktopTools = ReturnType<typeof useDesktopTools>;
type ActivityActions = ReturnType<typeof useActivityActions>;
type AppUpdate = ReturnType<typeof useAppUpdate>;
type PlanSteps = ComponentProps<typeof PlanPanel>["steps"];

export interface WorkspaceSceneActions {
  importProject: () => Promise<void>;
  createConversation: (
    targetProject?: Project | null,
    location?: NewConversationLocation,
  ) => void;
  createConversationForSelection: (selection: ModelSelection) => Promise<void>;
  sendMessage: (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ) => Promise<void>;
  respondToApproval: (
    request: AgentApprovalRequest,
    decision: AgentApprovalDecision,
  ) => Promise<void>;
  respondToInput: (
    request: AgentInputRequest,
    answers: Record<string, string[]>,
  ) => Promise<void>;
  updateConversation: (
    update: Partial<Pick<
      Conversation,
      | "providerId"
      | "modelSelection"
      | "model"
      | "reasoningEffort"
      | "interactionMode"
      | "accessMode"
    >>,
  ) => void;
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
  chooseCodexBinary: () => Promise<void>;
  refreshProvider: (providerId?: ProviderId) => void;
  connectProvider: (providerId: ProviderId) => void;
  openProviderSetup: (providerId: ProviderId) => void;
  openBackendSetup: (profileId: string) => void;
  openProjectPath: (
    request: Parameters<typeof window.inertia.openProjectPath>[0],
  ) => void;
  revertCheckpoint: (checkpoint: CheckpointSummary) => void;
  openTurnDiff: (turnId: string, path?: string) => void;
  compareTurnArtifacts: (
    earlierTurnId: string,
    laterTurnId: string,
  ) => void;
  stopSubagent: (trace: SubagentTrace) => Promise<void>;
  stopAgent: () => Promise<void>;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
}

export interface WorkspaceSceneModelInput {
  view: "workspace" | "settings";
  settingsTarget: {
    section: "providers" | "backends";
    profileId?: string;
  } | null;
  settings: AppSettings;
  busyAction: string | null;
  project: Project | null;
  connection: Connection;
  providerMaintenance: ProviderMaintenance;
  projection: ConversationProjection;
  layout: WorkspaceSceneLayout;
  workspaceTools: WorkspaceTools;
  backendProfileActions: BackendProfileActions;
  desktopTools: DesktopTools;
  activityActions: ActivityActions;
  appUpdate: AppUpdate;
  planSteps: PlanSteps;
  detailLoading: boolean;
  selectedMaintenanceStatus: WorkspaceSceneProps["chat"]["maintenanceStatus"];
  selectedMaintenanceOperation: WorkspaceSceneProps["chat"]["maintenanceOperation"];
  actions: WorkspaceSceneActions;
  setActionError: Dispatch<SetStateAction<string | null>>;
  setLatestContentVisible: Dispatch<SetStateAction<boolean>>;
}

export function createWorkspaceSceneModel({
  view,
  settingsTarget,
  settings,
  busyAction,
  project,
  connection,
  providerMaintenance,
  projection,
  layout,
  workspaceTools,
  backendProfileActions,
  desktopTools,
  activityActions,
  appUpdate,
  planSteps,
  detailLoading,
  selectedMaintenanceStatus,
  selectedMaintenanceOperation,
  actions,
  setActionError,
  setLatestContentVisible,
}: WorkspaceSceneModelInput): WorkspaceSceneProps {
  const {
    conversation,
    detail,
    detailState,
    refreshDetail,
  } = projection;
  const {
    activeTool,
    setActiveTool,
    stackedTools,
    toolsVisible,
    workspaceBodyRef,
    tools: toolsLayout,
  } = layout;
  const canUpdatePlan = Boolean(
    conversation
    && conversation.status !== "running"
    && conversation.status !== "needs-input",
  );
  const planSummary = conversation
    && projection.nativePlans[conversation.id]?.explanation
      ? projection.nativePlans[conversation.id].explanation!
      : conversation?.interactionMode === "plan"
        ? "The latest agent response is reflected as a working plan."
        : "Switch the composer to Plan mode and ask the agent to propose an approach.";
  const visibleDetailState = detailState?.conversationId === conversation?.id
    ? detailState
    : null;
  const detailUnavailable = visibleDetailState
    && visibleDetailState.state !== "loading"
    && visibleDetailState.state !== "ready"
      ? visibleDetailState
      : null;

  return {
    view,
    settings: {
      target: settingsTarget,
      settings,
      disabled: connection.status !== "online",
      providers: connection.snapshot?.providers ?? [],
      maintenanceStatuses: providerMaintenance.statuses,
      maintenanceOperations: providerMaintenance.operations,
      backendProfiles: connection.snapshot?.backendProfiles ?? [],
      backendDefaults: connection.snapshot?.backendDefaults ?? [],
      projects: connection.snapshot?.projects ?? [],
      archived: connection.snapshot?.conversations.filter(
        ({ archivedAt }) => archivedAt !== null,
      ) ?? [],
      onUpdate: (updates) => {
        void actions.updateSettings(updates);
      },
      onConnectProvider: actions.connectProvider,
      onRefreshProvider: (providerId) => {
        actions.refreshProvider(providerId);
        void providerMaintenance.refresh(
          providerId as ProviderMaintenanceProviderId | undefined,
          true,
        ).catch(() => undefined);
      },
      onRefreshProviderMaintenance: (providerId) =>
        providerMaintenance.refresh(providerId, true),
      onUpdateProvider: providerMaintenance.update,
      onCancelProviderUpdate: providerMaintenance.cancel,
      onOpenProviderUpdateInstructions: (url) => {
        void window.inertia.openExternal(url).catch(() => undefined);
      },
      onChooseCodexBinary: () => {
        void actions.chooseCodexBinary().catch(() => undefined);
      },
      onRevealRuntimeLogs: () => window.inertia.revealRuntimeLogs(),
      onCopyRuntimeDiagnosticReport: () => window.inertia.copyRuntimeDiagnosticReport(),
      appUpdateStatus: appUpdate.status,
      checkingAppUpdate: appUpdate.checking,
      onCheckAppUpdate: () => appUpdate.check(true),
      onOpenAppRelease: appUpdate.openRelease,
      onUnarchive: (thread) => {
        void actions.run("conversation.unarchive", {
          type: "conversation.unarchive",
          payload: { conversationId: thread.id },
        }).catch(() => undefined);
      },
      onLoadBackendProfile: backendProfileActions.loadBackendProfile,
      onCreateBackendProfile: backendProfileActions.createBackendProfile,
      onUpdateBackendProfile: backendProfileActions.updateBackendProfile,
      onSetBackendCredential: backendProfileActions.setBackendCredential,
      onClearBackendCredential: backendProfileActions.clearBackendCredential,
      onProbeBackendProfile: backendProfileActions.probeBackendProfile,
      onDeleteBackendProfile: backendProfileActions.deleteBackendProfile,
      onSetBackendDefault: backendProfileActions.setBackendDefault,
      onClearBackendDefault: backendProfileActions.clearBackendDefault,
    },
    detailState: detailUnavailable ? {
      state: detailUnavailable.state,
      ...(detailUnavailable.state === "failed"
        ? { message: detailUnavailable.message }
        : {}),
      onRetry: refreshDetail,
    } : null,
    chat: {
      project,
      conversation: detail?.conversation ?? null,
      turns: projection.turns,
      messages: projection.messages,
      activities: projection.activities,
      subagents: projection.subagents,
      reasonings: projection.reasonings,
      plans: projection.plans,
      checkpoints: projection.checkpoints,
      turnGitArtifacts: projection.turnGitArtifacts,
      streamingText: projection.streamingText,
      streamingReasoning: projection.streamingReasoning,
      usage: projection.usage,
      approvals: projection.pendingApprovals,
      inputRequests: projection.pendingInputs,
      providers: connection.snapshot?.providers ?? [],
      backendProfiles: connection.snapshot?.backendProfiles ?? [],
      maintenanceStatus: selectedMaintenanceStatus,
      maintenanceOperation: selectedMaintenanceOperation,
      actions: workspaceTools.projectActions,
      mentionResults: workspaceTools.mentionResults,
      showTimestamps: settings.showTimestamps,
      showThinking: settings.showThinking,
      usageDisplayMode: settings.usageDisplayMode,
      responseDensity: settings.responseDensity,
      defaultCodeWrap: settings.defaultCodeWrap,
      autoCollapseWorkLog: settings.autoCollapseWorkLog,
      showChangedFileSummaries: settings.showChangedFileSummaries,
      promptContext: workspaceTools.pendingDiffContext,
      loading: (!connection.snapshot && connection.status !== "offline")
        || detailLoading,
      sending: busyAction === "message.send",
      onAddProject: () => void actions.importProject(),
      onCreateConversation: () => actions.createConversation(),
      onSendMessage: actions.sendMessage,
      onRespondToApproval: actions.respondToApproval,
      onRespondToInput: actions.respondToInput,
      onUpdateConversation: actions.updateConversation,
      onCreateConversationForSelection: actions.createConversationForSelection,
      onChooseAttachments: desktopTools.chooseComposerAttachments,
      onImportAttachments: desktopTools.importComposerAttachments,
      onReleaseAttachment: desktopTools.releaseComposerAttachment,
      onRunAction: activityActions.runProjectAction,
      onMentionQuery: workspaceTools.searchMentions,
      onConnectProvider: actions.connectProvider,
      onRefreshProvider: actions.refreshProvider,
      onOpenProviderSetup: actions.openProviderSetup,
      onOpenBackendSetup: actions.openBackendSetup,
      onProbeBackendProfile: async (profileId, modelId) => {
        await backendProfileActions.probeBackendProfile(profileId, modelId);
      },
      onRefreshProviderMaintenance: () => {
        const providerId = conversation?.providerId as
          | ProviderMaintenanceProviderId
          | undefined;
        return providerId
          ? providerMaintenance.refresh(providerId, true)
          : Promise.resolve();
      },
      onUpdateProvider: () => {
        const providerId = conversation?.providerId as
          | ProviderMaintenanceProviderId
          | undefined;
        return providerId
          ? providerMaintenance.update(providerId)
          : Promise.resolve();
      },
      onCancelProviderUpdate: providerMaintenance.cancel,
      onOpenProviderUpdateInstructions: (url) => {
        void window.inertia.openExternal(url).catch(() => undefined);
      },
      onUsageDisplayModeChange: (usageDisplayMode) => {
        void actions.updateSettings({ usageDisplayMode });
      },
      onClearPromptContext: () => workspaceTools.setPendingDiffContext(null),
      onLatestContentVisibilityChange: setLatestContentVisible,
      onOpenTurnDiff: actions.openTurnDiff,
      onCompareTurnArtifacts: actions.compareTurnArtifacts,
      onOpenTurnFile: workspaceTools.openTurnFile,
      onRevertCheckpoint: actions.revertCheckpoint,
      onStopSubagent: actions.stopSubagent,
      onStop: actions.stopAgent,
    },
    resizeHandle: toolsVisible ? {
      label: "Resize workspace tools",
      controls: "workspace-content",
      containerRef: workspaceBodyRef,
      orientation: stackedTools ? "horizontal" : "vertical",
      pane: "after",
      value: stackedTools ? toolsLayout.height : toolsLayout.width,
      min: stackedTools ? TOOLS_MIN_HEIGHT : TOOLS_MIN_WIDTH,
      max: stackedTools ? toolsLayout.maxHeight : toolsLayout.maxWidth,
      defaultValue: stackedTools ? 320 : 520,
      onChange: stackedTools
        ? toolsLayout.onHeightChange
        : toolsLayout.onWidthChange,
      onCommit: stackedTools
        ? toolsLayout.onHeightCommit
        : toolsLayout.onWidthCommit,
      valueText: (value) => `${value} pixels for workspace tools`,
      className: "workspace-tools-resize-handle",
    } : null,
    tools: project ? {
      activeTool,
      panel: {
        activeTab: activeTool ?? "terminal",
        visible: toolsVisible,
        onTabChange: setActiveTool,
        badges: {
          changes: workspaceTools.workspaceGitStatus?.files ?? 0,
          plan: planSteps.length,
        },
        onClose: () => setActiveTool(null),
      },
      historicalDiff: workspaceTools.historicalDiff ? {
        diff: workspaceTools.historicalDiff,
        selectedPath: workspaceTools.historicalSelectedPath,
        wrapLines: settings.wrapDiffs,
        onSelectFile: workspaceTools.setHistoricalSelectedPath,
        onOpenFile: workspaceTools.openTurnFile,
        onShowCurrentChanges: workspaceTools.showCurrentChanges,
      } : null,
      changes: {
        projectName: project.name,
        snapshot: workspaceTools.workspaceGitStatus,
        loading: workspaceTools.toolsLoading,
        summary: workspaceTools.reviewSummary,
        summaryFingerprint: workspaceTools.structuredDiff.fingerprint,
        selectionAnswer: workspaceTools.selectionReviewAnswer,
        reviewStates: workspaceTools.reviewStates,
        notes: workspaceTools.reviewNotes,
        summaryLoading: busyAction === "review.summary.generate",
        wrapLines: settings.wrapDiffs,
        lastReversal: workspaceTools.lastDiffReversal,
        onRefresh: () => {
          void workspaceTools.loadGit().catch((error) => setActionError(
            error instanceof Error
              ? error.message
              : "Changes could not be refreshed.",
          ));
        },
        onLoadRepositoryDiff: workspaceTools.loadWorkspaceRepositoryDiff,
        onOpenWorkspaceFile: (relativePath) => actions.openProjectPath({
          projectId: project.id,
          ...(conversation ? { conversationId: conversation.id } : {}),
          relativePath,
          action: "open-externally",
        }),
        onGenerateSummary: workspaceTools.generateReviewSummary,
        onCancelSummary: workspaceTools.cancelReviewSummary,
        onAsk: workspaceTools.askAboutDiff,
        onRequestRevision: workspaceTools.requestDiffRevision,
        onRevert: workspaceTools.revertDiffSelection,
        onUndoReversal: workspaceTools.undoDiffReversal,
        onDismissSelectionAnswer: () =>
          workspaceTools.setSelectionReviewAnswer(null),
        onSetReviewState: workspaceTools.setDiffReviewState,
        onCreateNote: workspaceTools.createDiffReviewNote,
        onUpdateNote: workspaceTools.updateDiffReviewNote,
        onDeleteNote: workspaceTools.deleteDiffReviewNote,
        onAddTextToPrompt: workspaceTools.setPendingDiffContext,
        onAddToPrompt: (selection) =>
          workspaceTools.setPendingDiffContext(selection.reference),
      },
      files: {
        entries: workspaceTools.workspaceEntries,
        preview: workspaceTools.filePreview,
        selectedPath: workspaceTools.selectedFile,
        loading: workspaceTools.filesLoading,
        previewLoading: workspaceTools.filePreviewLoading,
        error: workspaceTools.filesError,
        previewError: workspaceTools.filePreviewError,
        entriesTruncated: workspaceTools.entriesTruncated,
        onSelectFile: workspaceTools.selectWorkspaceFile,
        onLoadEntries: workspaceTools.requestWorkspaceEntries,
        onRefresh: () => {
          void workspaceTools.loadFiles().catch((error) => setActionError(
            error instanceof Error
              ? error.message
              : "Files could not be refreshed.",
          ));
        },
        onOpenFile: (path) => actions.openProjectPath({
          projectId: project.id,
          ...(conversation ? { conversationId: conversation.id } : {}),
          relativePath: path,
          action: "open-externally",
        }),
      },
      filesKey: `files:${project.id}:${conversation?.id ?? "project"}`,
      terminal: {
        visible: toolsVisible && activeTool === "terminal",
        projectId: project.id,
        ...(conversation ? { conversationId: conversation.id } : {}),
        projectName: project.name,
        status: connection.status,
        fontSize: settings.terminalFontSize,
        theme: settings.theme,
        sendCommand: connection.sendCommand,
        subscribe: connection.subscribe,
        actionId: activityActions.pendingActionId,
        onActionStarted: activityActions.clearPendingAction,
        onClose: () => setActiveTool(null),
      },
      terminalKey: `${project.id}:${conversation?.id ?? "project"}`,
      plan: {
        steps: planSteps,
        summary: planSummary,
        ...(canUpdatePlan ? {
          onRefine: () => {
            actions.updateConversation({ interactionMode: "plan" });
            void actions.sendMessage(
              "Refine the implementation plan with clearer steps, risks, and validation.",
              [],
            ).catch(() => undefined);
          },
        } : {}),
        ...(canUpdatePlan && planSteps.length > 0 ? {
          onImplement: () => {
            actions.updateConversation({ interactionMode: "build" });
            void actions.sendMessage(
              "Implement the plan above and validate the result.",
              [],
            ).catch(() => undefined);
            setActiveTool("changes");
          },
        } : {}),
      },
      preview: {
        url: desktopTools.previewUrl,
        loading: desktopTools.previewNavigation.loading,
        canGoBack: desktopTools.previewNavigation.canGoBack,
        canGoForward: desktopTools.previewNavigation.canGoForward,
        onNavigate: desktopTools.navigatePreview,
        onBack: () => desktopTools.previewCommand("back"),
        onForward: () => desktopTools.previewCommand("forward"),
        onReload: () => desktopTools.previewCommand("reload"),
        onBoundsChange: desktopTools.setPreviewBounds,
        onOpenExternal: (url) => {
          void window.inertia.openExternal(url).catch((error) => {
            setActionError(
              error instanceof Error
                ? error.message
                : "The URL could not be opened.",
            );
          });
        },
      },
    } : null,
  };
}
