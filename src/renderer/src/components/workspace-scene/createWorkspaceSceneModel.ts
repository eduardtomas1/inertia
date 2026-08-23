import type { ComponentProps, Dispatch, SetStateAction } from "react";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentGoalSource,
  AgentGoalStatus,
  AgentWorkflowState,
  AgentInputRequest,
  AppSettings,
  ChatAttachment,
  CheckpointSummary,
  Conversation,
  ConversationLatestTurnSummary,
  ModelSelection,
  Project,
  ProviderId,
  ProviderMaintenanceProviderId,
  ServerEvent,
  SubagentTrace,
  TurnRequestContext,
} from "@shared/contracts";
import { providerTerminalResumeAvailability } from "@shared/provider-terminal-resume";

import type { PlanPanel } from "../PlanPanel";
import type { WorkspaceSceneProps } from "../WorkspaceScene";
import type { ConversationContextSourceOption } from "../conversation-context/types";
import type { ProviderTerminalResumeOption } from "../providerResumeOptions";
import type { useActivityActions } from "../../hooks/useActivityActions";
import type { useAppUpdate } from "../../hooks/useAppUpdate";
import type { useBackendProfiles } from "../../hooks/useBackendProfiles";
import type { useConversationProjection } from "../../hooks/useConversationProjection";
import type { useDesktopTools } from "../../hooks/useDesktopTools";
import type { useInertiaConnection } from "../../hooks/useInertiaConnection";
import type { useProviderMaintenance } from "../../hooks/useProviderMaintenance";
import {
  ENVIRONMENT_TOOLS_DEFAULT_WIDTH,
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
import { buildEnvironmentSummary } from "../../utils/environmentSummary";
import { resolveComposerRouteState } from "../../utils/composerRouteState";
import { requestTimelineFocus } from "../../utils/timelineFocus";
import { requestComposerPrefill } from "../../utils/composerPrefill";
import type {
  TranscriptMessageSendAcceptance,
} from "../../utils/transcriptNavigation";
import {
  goalControlsBusy,
  goalExecutionStatus,
} from "../../utils/goalExecution";
import { usageQuotaSourceForSelection } from "../../utils/usageDisplay";

type Connection = ReturnType<typeof useInertiaConnection>;

export function workspaceDirectoryIdentity(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[a-z]:\//iu.test(normalized) || normalized.startsWith("//")
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

export function terminalResumeDirectory(
  conversation: Pick<Conversation, "worktreePath"> | null,
  project: Pick<Project, "normalizedPath"> | null,
): string | null {
  if (!conversation || !project) return null;
  return workspaceDirectoryIdentity(
    conversation.worktreePath ?? project.normalizedPath,
  );
}

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

export function visibleConversationLatestTurnSummary(
  persisted: Pick<Conversation, "id"> | null,
  visible: Pick<Conversation, "id"> | null,
  latestTurnSummary: ConversationLatestTurnSummary | null,
): ConversationLatestTurnSummary | null {
  return persisted?.id === visible?.id ? latestTurnSummary : null;
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
  ) => Promise<TranscriptMessageSendAcceptance | null>;
  compactConversation: (instruction?: string) => Promise<{
    message: string;
    instructionForwarded: boolean;
  }>;
  listSkills: (forceReload?: boolean) => Promise<void>;
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
  openSettings: () => void;
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
    section: "providers" | "backends" | "connections";
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
    mutating: boolean;
    error: string | null;
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
  const currentWorkflow = workflow.state?.conversationId
    === persistedConversation?.id
    ? workflow.state
    : null;
  const goalMutationSafetyLocked = workflow.error
    ?.includes("recovery safety mode") === true;
  const conversationIsRunning = conversation?.status === "running"
    || conversation?.status === "needs-input";
  const currentGoalExecution = goalMutationSafetyLocked
    ? "idle"
    : conversationIsRunning
      ? goalExecutionStatus(projection.turns)
      : "idle";
  const currentGoalControlsBusy = goalControlsBusy({
    connectionStatus: connection.status,
    workflowLoading: workflow.loading,
    safetyLocked: goalMutationSafetyLocked,
    executionStatus: currentGoalExecution,
    busyAction,
  });
  const goalMutationControlsBusy = currentGoalControlsBusy || workflow.mutating;
  const runtimeConversation = runtimeConversationReference(
    persistedConversation,
  );
  const snapshotProjects = connection.snapshot?.projects ?? [];
  const snapshotConversations = connection.snapshot?.conversations ?? [];
  const projectById = new Map(snapshotProjects.map((entry) => [entry.id, entry]));
  const activeDirectory = terminalResumeDirectory(conversation, project);
  const contextSources: ConversationContextSourceOption[] = [];
  const terminalResumeOptions: ProviderTerminalResumeOption[] = [];
  if (activeDirectory) {
    const candidates = [...snapshotConversations].sort((left, right) => {
      if (left.id === persistedConversation?.id) return -1;
      if (right.id === persistedConversation?.id) return 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
    for (const candidate of candidates) {
      const candidateProject = projectById.get(candidate.projectId);
      if (!candidateProject) continue;
      const sameWorkspace = workspaceDirectoryIdentity(
        candidate.worktreePath ?? candidateProject.normalizedPath,
      ) === activeDirectory;
      if (persistedConversation && candidate.id !== persistedConversation.id) {
        contextSources.push({
          conversationId: candidate.id,
          conversationTitle: candidate.title,
          projectName: candidateProject.name,
          workspaceRelation: sameWorkspace
            ? "same-workspace"
            : "different-workspace",
          archived: candidate.archivedAt !== null,
        });
      }
      if (sameWorkspace) {
        terminalResumeOptions.push({
          projectId: candidateProject.id,
          projectName: candidateProject.name,
          conversationId: candidate.id,
          conversationTitle: candidate.title,
          availability: providerTerminalResumeAvailability(
            candidate,
            connection.snapshot?.providers.find(
              ({ id }) => id === candidate.providerId,
            ),
          ),
        });
      }
    }
  }
  const {
    activeTool,
    setActiveTool,
    stackedTools,
    toolsVisible,
    workspaceBodyRef,
    tools: toolsLayout,
  } = layout;
  const effectiveActiveTool = workspaceToolsUnavailable
    ? "environment" as const
    : activeTool;
  const usageRoute = conversation && connection.snapshot
    ? resolveComposerRouteState({
        conversationProviderId: conversation.providerId,
        selection: conversation.modelSelection,
        providers: connection.snapshot.providers,
        profiles: connection.snapshot.backendProfiles ?? [],
      })
    : null;
  const usageProvider = usageRoute?.exactIdentity
    ? usageRoute.provider ?? null
    : null;
  const usageQuotaSource = conversation && usageRoute?.exactIdentity
    ? usageQuotaSourceForSelection(
        conversation.modelSelection,
        usageRoute.profile,
      )
    : "isolated";
  const usageIdentity = conversation && usageRoute?.exactIdentity
    ? usageQuotaSource === "selected-route"
      ? {
          providerId: usageProvider?.id ?? null,
          label: usageProvider?.label
            ?? usageRoute.profile?.displayName
            ?? conversation.modelSelection.backendProfileDisplayName,
        }
      : {
          providerId: null,
          label: usageRoute.profile?.displayName
            ?? conversation.modelSelection.backendProfileDisplayName,
        }
    : null;
  const environmentSummary = buildEnvironmentSummary({
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    conversationId: conversation?.id ?? null,
    connectionStatus: connection.status,
    gitStatus: workspaceTools.gitStatus,
    workspaceGitStatus: workspaceTools.workspaceGitStatus,
    runs: connection.snapshot?.runs ?? [],
    subagents: projection.subagents,
    messages: projection.messages,
    projectPath: project?.normalizedPath ?? null,
    worktreePath: conversation?.worktreePath ?? null,
    gitLoading: workspaceTools.gitLoading,
    gitError: workspaceTools.gitError,
    gitBusy: Boolean(busyAction?.startsWith("git.")),
    projects: snapshotProjects,
    conversations: snapshotConversations,
    usage: projection.usage,
    latestTurnId: projection.latestTurnSummary?.id ?? null,
    usageProvider,
    usageIdentity,
    usageQuotaSource,
  });
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
    Boolean(conversationIsRunning
      && canFollowUpSubagentTrace(trace, projection.turns));
  const setGoal = async (input: {
    source: AgentGoalSource;
    objective?: string;
    status: AgentGoalStatus;
    tokenBudget?: number | null;
  }): Promise<void> => {
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
  };
  const clearGoal = async (source: AgentGoalSource): Promise<void> => {
    try {
      await actions.clearGoal(source);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The goal could not be cleared.",
      );
      throw error;
    }
  };

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
      databaseBackup: connection.snapshot?.databaseBackup,
      onUpdate: actions.updateSettings,
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
      onDownloadAppUpdate: appUpdate.download,
      onCancelAppUpdateDownload: appUpdate.cancelDownload,
      onInstallAppUpdate: appUpdate.install,
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
      checkoutBranch: workspaceTools.gitStatus?.branch ?? null,
      latestTurnSummary: visibleConversationLatestTurnSummary(
        persistedConversation,
        conversation,
        projection.latestTurnSummary,
      ),
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
      streamingChannel: projection.streamingChannel,
      terminalProjections: projection.terminalProjections,
      usage: projection.usage,
      skills: currentWorkflow?.skills ?? [],
      skillsCapability: currentWorkflow?.skillsCapability ?? null,
      skillsLoading: workflow.loading,
      skillsError: workflow.error,
      promptPresets: connection.snapshot?.promptPresets ?? [],
      goal: persistedConversation ? {
        workflow: currentWorkflow,
        executionStatus: currentGoalExecution,
        loading: workflow.loading,
        busy: goalMutationControlsBusy,
        error: workflow.error,
        onRetry: () => workflow.refresh(true),
        onSetGoal: setGoal,
        onClearGoal: clearGoal,
      } : null,
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
      autoScrollToFinalAnswer: settings.autoScrollToFinalAnswer,
      promptContext: workspaceTools.pendingDiffContext,
      contextSources,
      contextPackets: detail?.contextPackets ?? [],
      onConversationContextCommand: actions.run,
      previewContextUrl: desktopTools.previewUrl || null,
      providerIdentityLabels: settings.providerIdentityLabels,
      loading: (!connection.snapshot && connection.status !== "offline")
        || detailLoading,
      detailLoading,
      sending: busyAction === "message.send",
      onAddProject: () => void actions.importProject(),
      onCreateConversation: () => actions.createConversation(),
      onSendMessage: actions.sendMessage,
      onCompactConversation: actions.compactConversation,
      onListSkills: actions.listSkills,
      onPromptPresetCommand: actions.run,
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
      onOpenResume: () => setActiveTool("terminal"),
      resumeOptions: terminalResumeOptions,
      onResumeConversation: activityActions.requestProviderResume,
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
        void actions.updateSettings({ usageDisplayMode })
          .catch(() => undefined);
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
    resizeHandle: project && toolsVisible ? {
      label: "Resize workspace tools",
      controls: "workspace-content",
      containerRef: workspaceBodyRef,
      orientation: stackedTools ? "horizontal" : "vertical",
      pane: "after",
      value: stackedTools ? toolsLayout.height : toolsLayout.width,
      min: stackedTools ? TOOLS_MIN_HEIGHT : TOOLS_MIN_WIDTH,
      max: stackedTools ? toolsLayout.maxHeight : toolsLayout.maxWidth,
      defaultValue: stackedTools
        ? 320
        : effectiveActiveTool === "environment"
          ? ENVIRONMENT_TOOLS_DEFAULT_WIDTH
          : 520,
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
      activeTool: effectiveActiveTool,
      panel: {
        activeTab: effectiveActiveTool ?? "environment",
        visible: toolsVisible,
        onTabChange: setActiveTool,
        ...(workspaceToolsUnavailable
          ? { tabs: ["environment"] as const }
          : {}),
        badges: {
          changes: workspaceTools.workspaceGitStatus?.files ?? 0,
          goal: (currentWorkflow?.goals.some(({ status }) =>
            status !== "complete") ? 1 : 0)
            + projection.subagents.filter(isLiveSubagentTrace).length,
          plan: planSteps.length,
        },
        onClose: () => setActiveTool(null),
        onOpenSettings: actions.openSettings,
      },
      environment: {
        summary: environmentSummary,
        workspaceToolsAvailable: !workspaceToolsUnavailable,
        onOpenChanges: (repositoryPath, action = "review") => {
          if (repositoryPath) {
            workspaceTools.requestWorkspaceChanges(repositoryPath, action);
          }
          setActiveTool("changes");
        },
        onOpenFiles: () => setActiveTool("files"),
        onOpenProject: () => actions.openProjectPath({
          projectId: project.id,
          ...runtimeConversation,
          relativePath: ".",
          action: "open-externally",
        }),
        onRevealProject: () => actions.openProjectPath({
          projectId: project.id,
          ...runtimeConversation,
          relativePath: ".",
          action: "reveal",
        }),
        onRetryGit: () => {
          void workspaceTools.loadGit({ authoritative: true })
            .catch((error) => setActionError(
              error instanceof Error
                ? error.message
                : "Git changes could not be loaded.",
            ));
        },
        ...(usageProvider && usageQuotaSource === "selected-route"
          ? { onRefreshUsage: () => actions.refreshProvider(usageProvider.id) }
          : {}),
        onStopRun: activityActions.stopWorkspaceRun,
        onOpenRunPreview: activityActions.openWorkspaceRunPreview,
        onAcknowledgeRun: activityActions.acknowledgeActivity,
        onDismissRun: activityActions.dismissActivity,
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
        projectId: project.id,
        conversationId: persistedConversation?.id,
        busyAction,
        run: actions.run,
        onActionError: setActionError,
        changesRequest: workspaceTools.changesRequest,
        onChangesRequestHandled: workspaceTools.clearWorkspaceChangesRequest,
        snapshot: workspaceTools.workspaceGitStatus,
        loading: workspaceTools.toolsLoading,
        summary: workspaceTools.reviewSummary,
        summaryFingerprint: workspaceTools.structuredDiff.fingerprint,
        selectionAnswer: workspaceTools.selectionReviewAnswer,
        reviewStates: workspaceTools.reviewStates,
        notes: workspaceTools.reviewNotes,
        summaryLoading: busyAction === "review.summary.generate",
        questionRunning: workspaceTools.selectionQuestionRunning,
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
        onCancelAsk: workspaceTools.cancelDiffQuestion,
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
        selectedLocation: workspaceTools.selectedFileLocation,
        selectedMarkdownHeading: workspaceTools.selectedMarkdownHeading,
        projectRoot: conversation?.worktreePath ?? project.normalizedPath,
        projectId: project.id,
        conversationId: conversation?.id,
        loading: workspaceTools.filesLoading,
        previewLoading: workspaceTools.filePreviewLoading,
        error: workspaceTools.filesError,
        previewError: workspaceTools.filePreviewError,
        entriesTruncated: workspaceTools.entriesTruncated,
        onSelectFile: workspaceTools.selectWorkspaceFile,
        onOpenWorkspaceEntry: workspaceTools.openWorkspaceFile,
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
        visible: toolsVisible && effectiveActiveTool === "terminal",
        projectId: project.id,
        ...runtimeConversation,
        projectName: project.name,
        status: connection.status,
        fontSize: settings.terminalFontSize,
        theme: settings.theme,
        colorTheme: settings.colorTheme,
        sendCommand: connection.sendCommand,
        subscribe: connection.subscribe,
        providerResumes: terminalResumeOptions,
        actionId: activityActions.pendingActionId,
        onActionStarted: activityActions.clearPendingAction,
        resumeRequestConversationId: activityActions.pendingResumeConversationId,
        onResumeRequestHandled: activityActions.clearPendingResume,
        onClose: () => setActiveTool(null),
      },
      terminalKey: `${project.id}:${conversation?.id ?? "project"}`,
      goal: {
        workflow: currentWorkflow,
        executionStatus: currentGoalExecution,
        error: workflow.error,
        plan: latestPlan,
        subagents: projection.subagents,
        turns: projection.turns,
        busy: goalMutationControlsBusy,
        onRetry: () => workflow.refresh(true),
        onSetGoal: setGoal,
        onClearGoal: (goal) => clearGoal(goal.source),
        onInsertSkill: (skill) => {
          if (!persistedConversation) return;
          requestComposerPrefill({
            conversationId: persistedConversation.id,
            text: `$${skill.name} `,
          });
          setActiveTool(null);
        },
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
          Boolean(conversationIsRunning
            && canStopSubagentTrace(trace, projection.turns)),
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
        tabs: desktopTools.previewNavigation.tabs,
        activeTabId: desktopTools.previewNavigation.activeTabId,
        agentActivity: desktopTools.previewNavigation.agentActivity,
        onNavigate: desktopTools.navigatePreview,
        onBack: () => desktopTools.previewCommand("back"),
        onForward: () => desktopTools.previewCommand("forward"),
        onReload: () => desktopTools.previewCommand("reload"),
        onOpenTab: () => desktopTools.previewTab("open"),
        onActivateTab: (tabId) => desktopTools.previewTab("activate", tabId),
        onCloseTab: (tabId) => desktopTools.previewTab("close", tabId),
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
