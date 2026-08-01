import type { ComponentProps, Dispatch, SetStateAction } from "react";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentGoalSource,
  AgentGoalStatus,
  AgentSkillSummary,
  AgentWorkflowState,
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
import {
  canFollowUpSubagentTrace,
  canStopSubagentTrace,
  isLiveSubagentTrace,
} from "../../utils/subagentDisclosure";
import { requestTimelineFocus } from "../../utils/timelineFocus";
import type {
  TranscriptMessageSendAcceptance,
} from "../../utils/transcriptNavigation";

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

export function visibleWorkspaceConversation(
  persisted: Conversation | null,
  draft: Conversation | null,
): Conversation | null {
  return draft ?? persisted;
}

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
    skillIds?: readonly string[],
  ) => Promise<TranscriptMessageSendAcceptance | null>;
  listSkills: (forceReload?: boolean) => Promise<void>;
  toggleSkill: (skill: AgentSkillSummary) => void;
  clearSelectedSkills: () => void;
  setGoal: (input: {
    source: AgentGoalSource;
    objective?: string;
    status: AgentGoalStatus;
    tokenBudget?: number | null;
  }) => Promise<void>;
  clearGoal: (source: AgentGoalSource) => Promise<void>;
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
  ) => Promise<void>;
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
  followUpSubagent: (trace: SubagentTrace) => void;
  stopSubagent: (trace: SubagentTrace) => Promise<void>;
  stopAgent: () => Promise<void>;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
}

export interface WorkspaceSceneModelInput {
  view: "workspace" | "settings";
  settingsTarget: {
    section: "providers" | "backends" | "remote";
    profileId?: string;
  } | null;
  settings: AppSettings;
  busyAction: string | null;
  project: Project | null;
  draftConversation: Conversation | null;
  workspaceToolsUnavailable: boolean;
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
  workflow: {
    state: AgentWorkflowState | null;
    loading: boolean;
    error: string | null;
    selectedSkillIds: readonly string[];
    refresh: (providerRefresh?: boolean) => Promise<void>;
  };
  detailLoading: boolean;
  selectedMaintenanceStatus: WorkspaceSceneProps["chat"]["maintenanceStatus"];
  selectedMaintenanceOperation: WorkspaceSceneProps["chat"]["maintenanceOperation"];
  actions: WorkspaceSceneActions;
  setActionError: Dispatch<SetStateAction<string | null>>;
  setLatestContentVisible: Dispatch<SetStateAction<boolean>>;
}

export function runtimeConversationReference(
  conversation: Pick<Conversation, "id"> | null,
): { conversationId?: string } {
  return conversation ? { conversationId: conversation.id } : {};
}

export function createWorkspaceSceneModel({
  view,
  settingsTarget,
  settings,
  busyAction,
  project,
  draftConversation,
  workspaceToolsUnavailable,
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
  workflow,
  detailLoading,
  selectedMaintenanceStatus,
  selectedMaintenanceOperation,
  actions,
  setActionError,
  setLatestContentVisible,
}: WorkspaceSceneModelInput): WorkspaceSceneProps {
  const {
    conversation: persistedConversation,
    detail,
    detailState,
    refreshDetail,
  } = projection;
  const conversation = visibleWorkspaceConversation(
    persistedConversation,
    draftConversation,
  );
  const runtimeConversation = runtimeConversationReference(
    persistedConversation,
  );
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
  const latestPlan = projection.plans.at(-1) ?? null;
  const planSummary = latestPlan?.explanation
      ? latestPlan.explanation
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
  const canGuideParent = (trace: SubagentTrace): boolean =>
    canFollowUpSubagentTrace(trace, projection.turns);

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
      conversations: connection.snapshot?.conversations.filter(
        ({ archivedAt }) => archivedAt === null,
      ) ?? [],
      archived: connection.snapshot?.conversations.filter(
        ({ archivedAt }) => archivedAt !== null,
      ) ?? [],
      onUpdate: (updates) => {
        void actions.updateSettings(updates);
      },
      onConnectProvider: actions.connectProvider,
      onRefreshProvider: (providerId) => {
        actions.refreshProvider(providerId);
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
      conversation: detail?.conversation ?? conversation,
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
      skills: workflow.state?.skills ?? [],
      skillsCapability: workflow.state?.skillsCapability ?? null,
      selectedSkillIds: workflow.selectedSkillIds,
      skillsLoading: workflow.loading,
      skillsError: workflow.error,
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
      onListSkills: actions.listSkills,
      onToggleSkill: actions.toggleSkill,
      onClearSelectedSkills: actions.clearSelectedSkills,
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
      onFollowUpSubagent: actions.followUpSubagent,
      onStopSubagent: actions.stopSubagent,
      onStop: actions.stopAgent,
    },
    resizeHandle: project && !workspaceToolsUnavailable && toolsVisible ? {
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
    tools: project && !workspaceToolsUnavailable ? {
      activeTool,
      panel: {
        activeTab: activeTool ?? "terminal",
        visible: toolsVisible,
        onTabChange: setActiveTool,
        badges: {
          changes: workspaceTools.workspaceGitStatus?.files ?? 0,
          goal: (workflow.state?.goals.some(({ status }) =>
            status !== "complete") ? 1 : 0)
            + projection.subagents.filter(isLiveSubagentTrace).length,
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
          void workspaceTools.loadGit({ authoritative: true }).catch((error) => setActionError(
            error instanceof Error
              ? error.message
              : "Changes could not be refreshed.",
          ));
        },
        onLoadRepositoryDiff: workspaceTools.loadWorkspaceRepositoryDiff,
        onOpenWorkspaceFile: (relativePath) => actions.openProjectPath({
          projectId: project.id,
          ...runtimeConversation,
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
          ...runtimeConversation,
          relativePath: path,
          action: "open-externally",
        }),
        canSaveFile: workspaceTools.canSaveWorkspaceFile,
        onSaveFile: workspaceTools.saveWorkspaceFile,
      },
      filesKey: `files:${project.id}:${conversation?.id ?? "project"}`,
      terminal: {
        visible: toolsVisible && activeTool === "terminal",
        projectId: project.id,
        ...runtimeConversation,
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
      goal: {
        workflow: workflow.state,
        error: workflow.error,
        plan: latestPlan,
        subagents: projection.subagents,
        turns: projection.turns,
        selectedSkillIds: workflow.selectedSkillIds,
        busy: workflow.loading
          || busyAction?.startsWith("agent.goal") === true,
        onRetry: () => workflow.refresh(true),
        onSetGoal: async (input) => {
          try {
            await actions.setGoal(input);
          } catch (error) {
            setActionError(
              error instanceof Error
                ? error.message
                : "The goal could not be updated.",
            );
            throw error;
          }
        },
        onClearGoal: (goal) => {
          void actions.clearGoal(goal.source).catch((error) => setActionError(
            error instanceof Error
              ? error.message
              : "The goal could not be cleared.",
          ));
        },
        onToggleSkill: (skill) => actions.toggleSkill(skill),
        onRefreshSkills: () => {
          void actions.listSkills(true).catch((error) => setActionError(
            error instanceof Error
              ? error.message
              : "Skills could not be refreshed.",
          ));
        },
        canFollowUpSubagent: canGuideParent,
        onFollowUpSubagent: actions.followUpSubagent,
        onOpenSubagent: (trace) => {
          setActiveTool(null);
          requestTimelineFocus({
            conversationId: trace.conversationId,
            turnId: trace.turnId,
          });
        },
        canStopSubagent: (trace) =>
          canStopSubagentTrace(trace, projection.turns),
        onStopSubagent: async (trace) => {
          try {
            await actions.stopSubagent(trace);
          } catch (error) {
            setActionError(error instanceof Error
              ? error.message
              : "The delegated task could not be stopped.");
            throw error;
          }
        },
      },
      plan: {
        steps: planSteps,
        summary: planSummary,
        ...(canUpdatePlan ? {
          onRefine: () => {
            void actions.updateConversation({ interactionMode: "plan" })
              .then(() => actions.sendMessage(
                "Refine the implementation plan with clearer steps, risks, and validation.",
                [],
              ))
              .catch((error) => setActionError(
                error instanceof Error
                  ? error.message
                  : "Plan mode could not be selected.",
              ));
          },
        } : {}),
        ...(canUpdatePlan && planSteps.length > 0 ? {
          onImplement: () => {
            void actions.updateConversation({ interactionMode: "build" })
              .then(() => actions.sendMessage(
                "Implement the plan above and validate the result.",
                [],
              ))
              .catch((error) => setActionError(
                error instanceof Error
                  ? error.message
                  : "Build mode could not be selected.",
              ));
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
