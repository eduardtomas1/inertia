import type { LimitResetCommandRunner } from "./composer/limitResetClient";
import { readTranscriptPosition, forgetTranscriptPosition } from "../utils/transcriptPosition";
import { useOlderHistoryNearTop } from "../hooks/useOlderHistoryNearTop";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  FolderPlus,
  MessageCircleQuestion,
  SquarePen,
} from "lucide-react";
import clsx from "clsx";
import type {
  AgentActivity,
  AgentSkillSummary,
  AgentWorkflowSkillsCapability,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  ChatAttachment,
  ConversationCompactAndSendResult,
  ChatMessage,
  CheckpointSummary,
  ConversationLatestTurnSummary,
  Conversation,
  ConversationContextPacketSummary,
  ModelBackendProfileView,
  Project,
  ProjectAction,
  ProviderId,
  ProviderInfo,
  PromptPreset,
  ProviderMaintenanceOperation,
  ProviderMaintenanceStatus,
  ResponseDensity,
  SubagentTrace,
  ThreadUsageSnapshot,
  TurnGitArtifact,
  TurnRequestContext,
  UsageDisplayMode,
  WorkspaceEntry,
} from "@shared/contracts";
import type { CompactOnReturnSetting, ConversationCompactionState } from "@shared/compact-on-return";
import type { ContextCompactionTrigger } from "@shared/context-compaction";
import type { WorkspaceFileLocation } from "../utils/workspaceFileReference";
import { isAgentTurnTerminalStatus } from "@shared/turn-lifecycle";
import type { ComposerAttachmentImportLease } from "../utils/composerAttachments";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { useReaderScrollIntent } from "../hooks/useReaderScrollIntent";
import { readerScrollReachesLatest, shouldFollowTimeline } from "../utils/responseTimeline";
import {
  EMPTY_STREAMING_AGENT_SOURCE,
  type StreamingAgentSource,
} from "../hooks/useStreamingAgentState";
import {
  turnEventOwner,
  type TerminalTurnProjections,
} from "../utils/terminalTurnProjection";
import { revealAgentInputRequest } from "../utils/agentInputNavigation";
import { DuoJudgeNoticeSlot } from "./DuoJudgeNoticeContext";
import {
  initialTranscriptNavigation,
  isTranscriptReaderNavigationKey,
  type TranscriptMessageSendAcceptance,
  type TranscriptNavigationAction,
  transcriptNavigationFollowsContent,
  transcriptNavigationReducer,
} from "../utils/transcriptNavigation";
import { Composer } from "./Composer";
import type { QueueCommandRunner } from "./composer/runtimeQueueClient";
import type { ChatGoalControlProps } from "./ChatGoalControl";
import type { WorkspacePanelTab } from "./workspacePanelTypes";
import type {
  NewChatProjectPicker,
  PromptPresetCommandRunner,
} from "./composer/types";
import type { ProviderTerminalResumeOption } from "./providerResumeOptions";
import type {
  ConversationContextCommandRunner,
  ConversationContextSourceOption,
} from "./conversation-context/types";
import type {
  FinalAnswerAutoScrollEvent,
} from "./response-timeline/types";
import { LoadingMark } from "./ui";
import { TimelineJumpToLatest } from "./TimelineJumpToLatest";
import { afterSmoothScroll } from "../utils/smoothScrollSettle";
import { markComposerSent, noteRequestSent } from "../utils/requestLiftOff";
import type { WatcherWakeSummary } from "@shared/watcher";
import { loadResponseTimeline } from "./chatSurfaceLoaders";
import { notifyComposerStopRestore } from "../utils/composerStopRestore";
import { composerFocusRestorer } from "../utils/composerFocusRestore";
import { StreamingResponseTimeline } from "./response-timeline/streaming-timeline";
import { ForkSurfaceProvider, ForkHistoryPanel, type ForkCommandRunner } from "./orchestration/fork-surface";
import "./ChatWorkspace.css";

const ProviderMaintenanceNotice = lazy(async () => ({
  default: (await import("./ProviderMaintenanceNotice")).ProviderMaintenanceNotice,
}));
const READER_INTENT_GUARD_MS = 750;
const EMPTY_PROMPT_PRESETS: readonly PromptPreset[] = [];
const EMPTY_CONTEXT_SOURCES: readonly ConversationContextSourceOption[] = [];
const EMPTY_CONTEXT_PACKETS: readonly ConversationContextPacketSummary[] = [];

function recordsOwnedByConversation<T extends { conversationId: string }>(
  records: T[],
  conversationId: string | null,
): T[] {
  if (!conversationId) return [];
  return records.every((record) => record.conversationId === conversationId)
    ? records
    : records.filter((record) => record.conversationId === conversationId);
}

type ChatWorkspaceProps = {
  embedded?: boolean;
  project: Project | null;
  conversation: Conversation | null;
  newChatProjectPicker?: NewChatProjectPicker;
  checkoutBranch?: string | null;
  showCheckoutContext?: boolean;
  latestTurnSummary: ConversationLatestTurnSummary | null;
  turns: AgentTurn[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  subagents: SubagentTrace[];
  reasonings: AgentReasoning[];
  plans: AgentPlan[];
  checkpoints: CheckpointSummary[];
  turnGitArtifacts: TurnGitArtifact[];
  streaming?: StreamingAgentSource;
  terminalProjections?: TerminalTurnProjections;
  usage: ThreadUsageSnapshot | null;
  skills: AgentSkillSummary[];
  skillsCapability: AgentWorkflowSkillsCapability | null;
  skillsLoading: boolean;
  skillsError: string | null;
  promptPresets?: readonly PromptPreset[];
  promptPresetsEnabled?: boolean;
  promptStashEnabled?: boolean;
  conversationContextHandoffEnabled?: boolean;
  agentContextRequestEnabled?: boolean;
  goal?: ChatGoalControlProps | null;
  approvals: AgentApprovalRequest[];
  inputRequests: AgentInputRequest[];
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  maintenanceStatus: ProviderMaintenanceStatus | null;
  maintenanceOperation: ProviderMaintenanceOperation | null;
  actions: ProjectAction[];
  mentionResults: WorkspaceEntry[];
  showTimestamps: boolean;
  showThinking: boolean;
  usageDisplayMode: UsageDisplayMode;
  responseDensity: ResponseDensity;
  defaultCodeWrap: boolean;
  autoCollapseWorkLog: boolean;
  showChangedFileSummaries: boolean;
  autoScrollToFinalAnswer: boolean;
  promptContext?: string | null;
  contextSources?: readonly ConversationContextSourceOption[];
  contextPackets?: readonly ConversationContextPacketSummary[];
  rolledBackTurnIds?: readonly string[];
  watcherWakes?: readonly WatcherWakeSummary[];
  onConversationContextCommand?: ConversationContextCommandRunner;
  onQueueCommand?: QueueCommandRunner;
  onForkCommand?: ForkCommandRunner;
  onLimitResetCommand?: LimitResetCommandRunner;
  previewContextUrl?: string | null;
  providerIdentityLabels?: ProviderIdentityLabels;
  loading: boolean;
  detailLoading?: boolean;
  history?: { hasOlder: boolean; loading: boolean; error: string | null; loadOlder: () => void;
    online: boolean; omittedTurnIds?: readonly string[] };
  sending: boolean;
  onAddProject: () => void;
  onCreateConversation: () => void;
  onSendMessage: (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ) => Promise<TranscriptMessageSendAcceptance | null>;
  onCompactConversation?: (instruction?: string) => Promise<{
    message: string;
    instructionForwarded: boolean;
  }>;
  compaction?: ConversationCompactionState | null;
  compactOnReturnSetting?: CompactOnReturnSetting;
  onCompactAndSendMessage?: (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ) => Promise<ConversationCompactAndSendResult>;
  onListSkills: (forceReload?: boolean) => Promise<void>;
  onPromptPresetCommand?: PromptPresetCommandRunner;
  onRespondToApproval: (request: AgentApprovalRequest, decision: AgentApprovalDecision) => Promise<void>;
  onRespondToInput: (request: AgentInputRequest, answers: Record<string, string[]>) => Promise<void>;
  onUpdateConversation: (update: Partial<Pick<Conversation, "providerId" | "modelSelection" | "model" | "reasoningEffort" | "interactionMode" | "accessMode">>) => Promise<void>;
  onChooseAttachments: (
    mode?: import("@shared/desktop").AttachmentPickerMode,
  ) => Promise<ComposerAttachmentImportLease | null>;
  onImportAttachments: (
    files: File[],
  ) => Promise<ComposerAttachmentImportLease | null>;
  onReleaseAttachment: (id: string) => Promise<void>;
  onRunAction: (action: ProjectAction) => void;
  onMentionQuery: (query: string) => void;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId: ProviderId) => void;
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onOpenBackendSetup: (profileId: string, panel?: "key" | "models") => void;
  onProbeBackendProfile: (profileId: string, modelIds?: readonly string[]) => Promise<unknown>;
  onRefreshProviderMaintenance: () => Promise<void>;
  onUpdateProvider: () => Promise<void>;
  onCancelProviderUpdate: (operationId: string) => Promise<void>;
  onOpenProviderUpdateInstructions: (url: string) => void;
  onOpenResume: () => void;
  resumeOptions?: readonly ProviderTerminalResumeOption[];
  onResumeConversation?: (conversationId: string) => void;
  onUsageDisplayModeChange: (mode: UsageDisplayMode) => void;
  onStop: () => Promise<void>;
  onOpenSurface?: (surface: WorkspacePanelTab) => void;
  onRevertCheckpoint: (checkpoint: CheckpointSummary) => void;
  onOpenTurnDiff: (turnId: string, path?: string) => void;
  onCompareTurnArtifacts: (earlierTurnId: string, laterTurnId: string) => void;
  onOpenTurnFile: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
  onClearPromptContext?: () => void;
  onLatestContentVisibilityChange?: (visible: boolean) => void;
};

export function ChatWorkspace({
  embedded = false,
  project,
  conversation,
  newChatProjectPicker,
  checkoutBranch = null,
  showCheckoutContext = true,
  latestTurnSummary,
  turns,
  messages,
  activities,
  subagents,
  reasonings,
  plans,
  checkpoints,
  turnGitArtifacts,
  streaming = EMPTY_STREAMING_AGENT_SOURCE,
  terminalProjections,
  usage,
  skills,
  skillsCapability,
  skillsLoading,
  skillsError,
  promptPresets = EMPTY_PROMPT_PRESETS,
  promptPresetsEnabled = true,
  promptStashEnabled = true,
  conversationContextHandoffEnabled = true,
  agentContextRequestEnabled = conversationContextHandoffEnabled,
  goal,
  approvals,
  inputRequests,
  providers,
  backendProfiles,
  maintenanceStatus,
  maintenanceOperation,
  actions,
  mentionResults,
  showTimestamps,
  showThinking,
  usageDisplayMode,
  responseDensity,
  defaultCodeWrap,
  autoCollapseWorkLog,
  showChangedFileSummaries,
  autoScrollToFinalAnswer,
  promptContext,
  contextSources = EMPTY_CONTEXT_SOURCES,
  contextPackets = EMPTY_CONTEXT_PACKETS,
  rolledBackTurnIds,
  watcherWakes,
  onConversationContextCommand,
  onQueueCommand,
  onForkCommand,
  onLimitResetCommand,
  previewContextUrl,
  providerIdentityLabels,
  loading,
  detailLoading = false,
  history,
  sending,
  onAddProject,
  onCreateConversation,
  onSendMessage,
  onCompactConversation,
  compaction = null,
  compactOnReturnSetting,
  onCompactAndSendMessage,
  onListSkills,
  onPromptPresetCommand,
  onRespondToApproval,
  onRespondToInput,
  onUpdateConversation,
  onChooseAttachments,
  onImportAttachments,
  onReleaseAttachment,
  onRunAction,
  onMentionQuery,
  onConnectProvider,
  onRefreshProvider,
  onOpenProviderSetup,
  onOpenBackendSetup,
  onProbeBackendProfile,
  onRefreshProviderMaintenance,
  onUpdateProvider,
  onCancelProviderUpdate,
  onOpenProviderUpdateInstructions,
  onOpenResume,
  resumeOptions,
  onResumeConversation,
  onUsageDisplayModeChange,
  onStop,
  onOpenSurface,
  onRevertCheckpoint,
  onOpenTurnDiff,
  onCompareTurnArtifacts,
  onOpenTurnFile,
  onClearPromptContext,
  onLatestContentVisibilityChange,
}: ChatWorkspaceProps): React.JSX.Element {
  useNativePreviewSuspension(
    approvals.length > 0 || inputRequests.length > 0,
  );
  const ResponseTimeline = useLoadedSurface(loadResponseTimeline, Boolean(project && conversation));
  const Root = embedded ? "section" : "main";
  const selectedReasoningEffort = conversation?.modelSelection.reasoningEffort
    ?.trim().toLowerCase() ?? "";
  const keyboardHelpId = useId();
  const historyOfflineId = useId();
  const stopRestoreSequenceRef = useRef(0);
  const stopsInFlightRef = useRef(new Map<string, Promise<void>>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const keepHistoryFocus = useCallback((button: HTMLButtonElement | null) => () => {
    if (button && document.activeElement === button) queueMicrotask(() => {
      if (!button.isConnected && document.activeElement === document.body) scrollRef.current?.focus({ preventScroll: true });
    });
  }, []);
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRegionRef = useRef<HTMLDivElement>(null);
  const followCorrectionFrameRef = useRef<number | null>(null);
  const smoothSettleRef = useRef<(() => void) | null>(null);
  const readerIntentReleaseTimerRef = useRef<number | null>(null);
  const lastReaderScrollTopRef = useRef<number | null>(null);
  const liveTurnRef = useRef(false);
  const goalRef = useRef(goal);
  goalRef.current = goal;
  const retryGoal = useCallback<ChatGoalControlProps["onRetry"]>(
    () => goalRef.current?.onRetry() ?? Promise.resolve(),
    [],
  );
  const setChatGoal = useCallback<ChatGoalControlProps["onSetGoal"]>(
    (input) => goalRef.current?.onSetGoal(input) ?? Promise.resolve(),
    [],
  );
  const clearChatGoal = useCallback<ChatGoalControlProps["onClearGoal"]>(
    (source) => goalRef.current?.onClearGoal(source) ?? Promise.resolve(),
    [],
  );
  const hasGoalControl = Boolean(goal);
  const goalWorkflow = goal?.workflow ?? null;
  const goalExecutionStatus = goal?.executionStatus ?? "idle";
  const goalLoading = goal?.loading ?? false;
  const goalBusy = goal?.busy ?? false;
  const goalError = goal?.error ?? null;
  const goalControl = useMemo<ChatGoalControlProps | null>(() => hasGoalControl ? ({
    workflow: goalWorkflow,
    executionStatus: goalExecutionStatus,
    loading: goalLoading,
    busy: goalBusy,
    error: goalError,
    onRetry: retryGoal,
    onSetGoal: setChatGoal,
    onClearGoal: clearChatGoal,
  }) : null, [
    clearChatGoal,
    goalBusy,
    goalError,
    goalExecutionStatus,
    goalLoading,
    goalWorkflow,
    hasGoalControl,
    retryGoal,
    setChatGoal,
  ]);
  const conversationId = conversation?.id ?? null;
  const [compacting, setCompacting] = useState<ReadonlyMap<string | null, { since: string; trigger: ContextCompactionTrigger }>>(() => new Map());
  const trackCompaction = useCallback(async <Result,>(
    trigger: ContextCompactionTrigger,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const entry = { since: new Date().toISOString(), trigger };
    setCompacting((current) => new Map(current).set(conversationId, entry));
    try {
      return await operation();
    } finally {
      setCompacting((current) => {
        if (current.get(conversationId) !== entry) return current;
        const next = new Map(current);
        next.delete(conversationId);
        return next;
      });
    }
  }, [conversationId]);
  const compactConversation = useCallback((instruction?: string) =>
    trackCompaction("manual", () => onCompactConversation!(instruction)), [onCompactConversation, trackCompaction]);
  const localCompacting = compacting.get(conversationId) ?? null;
  const shellCompacting = compaction?.state === "compacting" && compaction.startedAt ? compaction : null;
  const compactingSince = localCompacting?.since ?? shellCompacting?.startedAt ?? null;
  const compactingTrigger = localCompacting?.trigger ?? shellCompacting?.trigger ?? null;
  const [navigation, dispatchNavigation] = useReducer(
    transcriptNavigationReducer,
    conversationId,
    (id) => initialTranscriptNavigation(id, readTranscriptPosition(id)?.wasFollowing === false),
  );
  const activeNavigation = navigation.conversationId === conversationId
    ? navigation
    : initialTranscriptNavigation(conversationId, readTranscriptPosition(conversationId)?.wasFollowing === false);
  const navigationRef = useRef(activeNavigation);
  navigationRef.current = activeNavigation;
  const navigate = useCallback((action: TranscriptNavigationAction): void => {
    navigationRef.current = transcriptNavigationReducer(navigationRef.current, action);
    dispatchNavigation(action);
  }, []);
  const readerIntentRef = useRef(false);
  const finalAnswerAutoScrollOwnerRef = useRef<string | null>(null);
  const pendingFinalAnswerNavigationRef = useRef<{
    conversationId: string;
    followsLatest: boolean;
  } | null>(null);
  const showJump = activeNavigation.mode === "reading-history";
  const projectRoot = conversation?.worktreePath ?? project?.path ?? "";
  const ownedTurns = recordsOwnedByConversation(turns, conversationId);
  const queueTurnOwner = latestTurnSummary ?? ownedTurns.at(-1) ?? null;
  const queuedTurnAuthoritative = !queueTurnOwner
    || !terminalProjections?.[turnEventOwner({
      runId: queueTurnOwner.runId,
      turnId: queueTurnOwner.id,
    })];
  const ownedMessages = recordsOwnedByConversation(messages, conversationId);
  const hasVisibleHistory = ownedMessages.some(({ role }) =>
    role === "user" || role === "assistant");
  const stopTurn = latestTurnSummary
    ? ownedTurns.find(({ id }) => id === latestTurnSummary.id) ?? null
    : ownedTurns.at(-1) ?? null;
  const stopTurnStatus = latestTurnSummary
    && latestTurnSummary.id === stopTurn?.id
    ? latestTurnSummary.status
    : stopTurn?.status ?? null;
  const stopOwner = `${conversationId ?? "none"}:${stopTurn?.id ?? "unknown"}`;
  liveTurnRef.current = Boolean(stopTurnStatus && !isAgentTurnTerminalStatus(stopTurnStatus));
  useEffect(() => {
    if (!stopTurnStatus || isAgentTurnTerminalStatus(stopTurnStatus)) {
      stopsInFlightRef.current.clear();
      return;
    }
    for (const owner of stopsInFlightRef.current.keys()) {
      if (owner !== stopOwner) stopsInFlightRef.current.delete(owner);
    }
  }, [stopOwner, stopTurnStatus]);
  const promptHistory = useMemo(() => ownedMessages
    .filter(({ role, content }) => role === "user" && Boolean(content.trim()))
    .map(({ id, content }) => ({ id, content })), [ownedMessages]);
  const stopWithPromptRestore = useCallback(async (): Promise<void> => {
    const stoppedConversationId = conversation?.id ?? null;
    const activeTurn = stopTurn;
    const activePrompt = activeTurn
      ? ownedMessages.find(({ id }) => id === activeTurn.userMessageId) ?? null
      : null;
    const inFlight = stopsInFlightRef.current.get(stopOwner);
    if (inFlight) {
      await onStop();
      return;
    }
    const detail = stoppedConversationId
      && activeTurn
      && activePrompt?.content.trim()
      ? {
          requestId: `${stoppedConversationId}:${++stopRestoreSequenceRef.current}`,
          conversationId: stoppedConversationId,
          turnId: activeTurn.id,
          messageId: activePrompt.id,
          text: activePrompt.content,
        }
      : null;
    const operation = (async (): Promise<void> => {
      if (detail) notifyComposerStopRestore({ ...detail, phase: "start" });
      try {
        await onStop();
      } catch (error) {
        if (detail) notifyComposerStopRestore({ ...detail, phase: "failed" });
        throw error;
      }
    })();
    stopsInFlightRef.current.set(stopOwner, operation);
    try {
      await operation;
    } catch (error) {
      if (stopsInFlightRef.current.get(stopOwner) === operation) {
        stopsInFlightRef.current.delete(stopOwner);
      }
      throw error;
    }
  }, [conversation?.id, onStop, ownedMessages, stopOwner, stopTurn]);
  const stopTimeline = useCallback(() => {
    const restoreFocus = composerFocusRestorer(document.activeElement);
    void stopWithPromptRestore().then(restoreFocus, () => undefined);
  }, [stopWithPromptRestore]);
  const ownedActivities = recordsOwnedByConversation(activities, conversationId);
  const ownedSubagents = recordsOwnedByConversation(subagents, conversationId);
  const ownedReasonings = recordsOwnedByConversation(reasonings, conversationId);
  const ownedPlans = recordsOwnedByConversation(plans, conversationId);
  const ownedCheckpoints = recordsOwnedByConversation(checkpoints, conversationId);
  const ownedTurnGitArtifacts = recordsOwnedByConversation(
    turnGitArtifacts,
    conversationId,
  );
  const ownedApprovals = recordsOwnedByConversation(approvals, conversationId);
  const ownedInputRequests = recordsOwnedByConversation(
    inputRequests,
    conversationId,
  );
  const agentContextRequest = [...ownedInputRequests].reverse().find(
    (request) => request.conversationContextRequest !== undefined,
  )?.conversationContextRequest ?? null;
  const visibleInputRequests = useMemo(() => ownedInputRequests.filter(
    (request) => request.conversationContextRequest === undefined,
  ), [ownedInputRequests]);
  const timelineLatestTurnSummary = useMemo(() => latestTurnSummary && conversationId
    ? { conversationId, turn: latestTurnSummary }
    : null, [conversationId, latestTurnSummary]);
  const pendingInputRequest = visibleInputRequests.at(-1) ?? null;
  const contentSignal = `${ownedTurns.length}:${ownedTurns.at(-1)?.updatedAt ?? ""}:${ownedMessages.length}:${ownedMessages.at(-1)?.content.length ?? 0}:${ownedActivities.length}:${ownedSubagents.length}:${ownedSubagents.at(-1)?.updatedAt ?? ""}:${ownedPlans.length}:${ownedCheckpoints.length}:${ownedTurnGitArtifacts.length}:${ownedTurnGitArtifacts.at(-1)?.status ?? ""}:${ownedTurnGitArtifacts.at(-1)?.capturedAt ?? ""}:${ownedApprovals.length}:${ownedInputRequests.length}`;

  const clearReaderIntent = useCallback((): void => {
    readerIntentRef.current = false;
    if (readerIntentReleaseTimerRef.current !== null) {
      window.clearTimeout(readerIntentReleaseTimerRef.current);
      readerIntentReleaseTimerRef.current = null;
    }
  }, []);

  const clearPendingFinalAnswerNavigation = useCallback((): void => {
    pendingFinalAnswerNavigationRef.current = null;
  }, []);

  const performScrollToLatest = useCallback((
    behavior: ScrollBehavior = "smooth",
  ): void => {
    if (
      readerIntentRef.current
      || pendingFinalAnswerNavigationRef.current !== null
      || finalAnswerAutoScrollOwnerRef.current !== null
    ) return;
    const element = scrollRef.current;
    if (!element || (behavior !== "smooth" && smoothSettleRef.current)) return;
    smoothSettleRef.current?.();
    smoothSettleRef.current = null;
    element.scrollTo({ top: element.scrollHeight, behavior });
    onLatestContentVisibilityChange?.(true);
    if (followCorrectionFrameRef.current !== null) {
      window.cancelAnimationFrame(followCorrectionFrameRef.current);
    }
    const correctMeasuredBottom = (remainingFrames: number): void => {
      followCorrectionFrameRef.current = window.requestAnimationFrame(() => {
        followCorrectionFrameRef.current = null;
        const current = scrollRef.current;
        if (
          !current
          || readerIntentRef.current
          || pendingFinalAnswerNavigationRef.current !== null
          || finalAnswerAutoScrollOwnerRef.current !== null
        ) return;
        if (!transcriptNavigationFollowsContent(navigationRef.current)) {
          if (remainingFrames > 1) {
            correctMeasuredBottom(remainingFrames - 1);
          }
          return;
        }
        current.scrollTo({ top: current.scrollHeight, behavior: "auto" });
        // A clamped scroll reports a zero gap before the virtualizer publishes
        // its next measurement. Keep the bounded correction window alive even
        // when this frame appears settled; reader intent still stops it above.
        if (remainingFrames > 1) {
          correctMeasuredBottom(remainingFrames - 1);
        }
      });
    };
    // Virtual-row measurement can refine the total height after the first
    // scroll. Converge for a few frames, but immediately yield to fresh reader
    // intent instead of pinning someone who moved back into history.
    if (behavior !== "smooth") return correctMeasuredBottom(8);
    smoothSettleRef.current = afterSmoothScroll(element, () => {
      smoothSettleRef.current = null;
      correctMeasuredBottom(8);
    });
  }, [onLatestContentVisibilityChange]);

  const scrollToLatest = useCallback((
    behavior: ScrollBehavior = "smooth",
  ): void => {
    if (!conversationId) return;
    clearReaderIntent();
    clearPendingFinalAnswerNavigation();
    forgetTranscriptPosition(conversationId);
    navigate({
      type: "latest.requested",
      conversationId,
    });
    performScrollToLatest(behavior);
  }, [
    clearPendingFinalAnswerNavigation,
    clearReaderIntent,
    conversationId,
    navigate,
    performScrollToLatest,
  ]);

  const onFinalAnswerAutoScroll = useCallback((
    event: FinalAnswerAutoScrollEvent,
  ): void => {
    const owner = `${event.conversationId}\u0000${event.answerId}`;
    if (event.status === "started") {
      if (navigationRef.current.conversationId !== event.conversationId) return;
      clearPendingFinalAnswerNavigation();
      finalAnswerAutoScrollOwnerRef.current = owner;
      smoothSettleRef.current?.();
      smoothSettleRef.current = null;
      if (followCorrectionFrameRef.current !== null) {
        window.cancelAnimationFrame(followCorrectionFrameRef.current);
        followCorrectionFrameRef.current = null;
      }
      return;
    }
    if (finalAnswerAutoScrollOwnerRef.current !== owner) return;
    finalAnswerAutoScrollOwnerRef.current = null;
    if (
      event.status === "cancelled"
      || navigationRef.current.conversationId !== event.conversationId
    ) return;

    if (navigationRef.current.mode !== (event.followsLatest ? "follow-latest" : "reading-history")) {
      pendingFinalAnswerNavigationRef.current = {
        conversationId: event.conversationId,
        followsLatest: event.followsLatest,
      };
    }
    navigate({
      type: "reader.scrolled",
      conversationId: event.conversationId,
      followsLatest: event.followsLatest,
      intentional: true,
    });
    onLatestContentVisibilityChange?.(event.followsLatest);
  }, [clearPendingFinalAnswerNavigation, navigate, onLatestContentVisibilityChange]);

  const revealPendingInput = useCallback((): void => {
    if (!pendingInputRequest) return;
    let remainingFrames = 4;
    const reveal = (): boolean => {
      if (revealAgentInputRequest(pendingInputRequest.id)) return true;
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        window.requestAnimationFrame(() => reveal());
      }
      return false;
    };
    reveal();
    scrollToLatest("auto");
    window.requestAnimationFrame(() => reveal());
  }, [pendingInputRequest, scrollToLatest]);

  useLayoutEffect(() => {
    smoothSettleRef.current?.();
    smoothSettleRef.current = null;
    finalAnswerAutoScrollOwnerRef.current = null;
    clearPendingFinalAnswerNavigation();
    clearReaderIntent();
    lastReaderScrollTopRef.current = null;
    navigate({
      type: "conversation.changed",
      conversationId,
      readingHistory: readTranscriptPosition(conversationId)?.wasFollowing === false,
    });
    if (readTranscriptPosition(conversationId)?.wasFollowing !== false) {
      performScrollToLatest("auto");
    }
  }, [
    clearPendingFinalAnswerNavigation,
    clearReaderIntent,
    conversationId,
    navigate,
    performScrollToLatest,
  ]);

  useLayoutEffect(() => {
    const pending = pendingFinalAnswerNavigationRef.current;
    if (!pending || activeNavigation.conversationId !== pending.conversationId) {
      return;
    }
    const targetCommitted = pending.followsLatest
      ? activeNavigation.mode === "follow-latest"
      : activeNavigation.mode === "reading-history";
    if (targetCommitted) clearPendingFinalAnswerNavigation();
  }, [activeNavigation, clearPendingFinalAnswerNavigation]);

  useEffect(
    () => () => {
      if (followCorrectionFrameRef.current !== null) {
        window.cancelAnimationFrame(followCorrectionFrameRef.current);
      }
      smoothSettleRef.current?.();
      smoothSettleRef.current = null;
      onLatestContentVisibilityChange?.(false);
    },
    [onLatestContentVisibilityChange],
  );

  useEffect(
    () => () => {
      clearPendingFinalAnswerNavigation();
      clearReaderIntent();
    },
    [clearPendingFinalAnswerNavigation, clearReaderIntent],
  );

  const followLatestContent = useCallback((): (() => void) | undefined => {
    if (!transcriptNavigationFollowsContent(navigationRef.current)) return;
    const frame = window.requestAnimationFrame(() => {
      if (!transcriptNavigationFollowsContent(navigationRef.current)) return;
      performScrollToLatest("auto");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [performScrollToLatest]);

  useEffect(
    followLatestContent,
    [contentSignal, followLatestContent],
  );

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (transcriptNavigationFollowsContent(navigationRef.current)) {
        performScrollToLatest("auto");
      }
    });
    for (const element of [timelineRef.current, composerRegionRef.current]) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [conversationId, performScrollToLatest]);

  const noteReaderIntent = useCallback((): void => {
    clearPendingFinalAnswerNavigation();
    clearReaderIntent();
    readerIntentRef.current = true;
    if (followCorrectionFrameRef.current !== null) {
      window.cancelAnimationFrame(followCorrectionFrameRef.current);
      followCorrectionFrameRef.current = null;
    }
    const intentConversationId = navigationRef.current.conversationId;
    readerIntentReleaseTimerRef.current = window.setTimeout(() => {
      clearReaderIntent();
      // Content may have finished growing while the gesture guard blocked
      // following. Retry only if this conversation still owns following.
      if (
        navigationRef.current.conversationId === intentConversationId
        && transcriptNavigationFollowsContent(navigationRef.current)
      ) performScrollToLatest("auto");
    }, READER_INTENT_GUARD_MS);
  }, [clearPendingFinalAnswerNavigation, clearReaderIntent, performScrollToLatest]);

  const noteResponseTimelineNavigationIntent = useCallback((): void => {
    noteReaderIntent();
    if (!conversationId) return;
    navigate({
      type: "reader.scrolled",
      conversationId,
      followsLatest: false,
      intentional: true,
    });
    onLatestContentVisibilityChange?.(false);
  }, [
    conversationId,
    navigate,
    noteReaderIntent,
    onLatestContentVisibilityChange,
  ]);
  const loadOlderNearTop = useCallback((): void => {
    if (!readerIntentRef.current) return;
    noteResponseTimelineNavigationIntent();
    history?.loadOlder();
  }, [history, noteResponseTimelineNavigationIntent]);
  useOlderHistoryNearTop(scrollRef, history && { ...history, loadOlder: loadOlderNearTop });

  const { noteWheelIntent, noteTouchIntent, noteKeyIntent, continueTouchIntent, aimsAtLatest } =
    useReaderScrollIntent(noteReaderIntent);

  const noteReaderKeyboardIntent = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (!isTranscriptReaderNavigationKey(event.key)) return;
    noteReaderIntent();
    noteKeyIntent(event.altKey ? null : event.key);
  };

  const onTranscriptScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const previousScrollTop = lastReaderScrollTopRef.current;
    lastReaderScrollTopRef.current = element.scrollTop;
    continueTouchIntent();
    const intentional = readerIntentRef.current;
    const follows = intentional
      ? readerScrollReachesLatest({ scrollTop: element.scrollTop, clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight, previousScrollTop, live: liveTurnRef.current, aimedAtLatest: aimsAtLatest() })
      : shouldFollowTimeline(element.scrollTop, element.clientHeight, element.scrollHeight);
    if (finalAnswerAutoScrollOwnerRef.current !== null) {
      onLatestContentVisibilityChange?.(follows);
      return;
    }
    if (pendingFinalAnswerNavigationRef.current !== null) {
      onLatestContentVisibilityChange?.(follows);
      return;
    }
    // A queued programmatic scroll can still report the bottom after fresh
    // wheel intent. Keep the bounded gesture guard until it expires: that
    // event does not prove that the reader has finished navigating.
    const scrolled = {
      type: "reader.scrolled",
      conversationId: conversationId ?? "",
      followsLatest: follows,
      intentional,
    } as const;
    if (transcriptNavigationReducer(navigationRef.current, scrolled) !== navigationRef.current) {
      navigate(scrolled);
    }
    onLatestContentVisibilityChange?.(follows);
  };

  const followAcceptedMessage = useCallback((
    acceptance: TranscriptMessageSendAcceptance,
    sourceConversationId: string | null,
  ): void => {
    if (acceptance.disposition === "new-turn") forgetTranscriptPosition(acceptance.conversationId);
    clearPendingFinalAnswerNavigation();
    clearReaderIntent();
    navigate({
      type: "message.accepted",
      acceptance,
      sourceConversationId,
    });
  }, [clearPendingFinalAnswerNavigation, clearReaderIntent, navigate]);

  const sendMessage = useCallback(async (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ): Promise<TranscriptMessageSendAcceptance | null> => {
    const sourceConversationId = conversationId;
    noteRequestSent(sourceConversationId, content);
    markComposerSent(composerRegionRef.current);
    const acceptance = await onSendMessage(
      content,
      attachments,
      context,
    );
    if (!acceptance) return null;
    followAcceptedMessage(acceptance, sourceConversationId);
    return acceptance;
  }, [conversationId, followAcceptedMessage, onSendMessage]);

  const compactAndSendMessage = useCallback(async (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ): Promise<ConversationCompactAndSendResult> => {
    const sourceConversationId = conversationId;
    noteRequestSent(sourceConversationId, content);
    markComposerSent(composerRegionRef.current);
    const result = await trackCompaction("on-return", () => onCompactAndSendMessage!(content, attachments, context));
    if (result.outcome === "sent") {
      followAcceptedMessage({
        kind: "message.accepted",
        conversationId: result.conversationId,
        turnId: result.turnId,
        userMessageId: result.userMessageId,
        disposition: result.disposition,
      }, sourceConversationId);
    }
    return result;
  }, [conversationId, followAcceptedMessage, onCompactAndSendMessage, trackCompaction]);

  const turnAnchorId = activeNavigation.mode === "await-turn"
    ? activeNavigation.turnId
    : null;
  const onTurnAnchorSettled = useCallback((turnId: string): void => {
    if (!conversationId) return;
    navigate({
      type: "turn.anchored",
      conversationId,
      turnId,
    });
    onLatestContentVisibilityChange?.(true);
  }, [conversationId, navigate, onLatestContentVisibilityChange]);
  const onTurnAnchorCancelled = useCallback((turnId: string): void => {
    if (!conversationId) return;
    navigate({
      type: "turn.anchor-cancelled",
      conversationId,
      turnId,
    });
    onLatestContentVisibilityChange?.(false);
  }, [conversationId, navigate, onLatestContentVisibilityChange]);

  if (loading && !detailLoading) {
    return (
      <Root className="chat-workspace centered-state" aria-busy="true">
        <LoadingMark label="Loading workspace" />
      </Root>
    );
  }

  if (!project) {
    return (
      <Root className="chat-workspace welcome-workspace">
        <section className="welcome-card" aria-labelledby="welcome-title">
          <h2 id="welcome-title">Bring a project into focus.</h2>
          <button type="button" className="primary-button" onClick={onAddProject}><FolderPlus size={16} /><span>Add your first project</span></button>
          <button type="button" className="subtle-button" onClick={onCreateConversation}><span>Start without a project</span></button>
        </section>
      </Root>
    );
  }

  if (!conversation) {
    return (
      <Root className="chat-workspace welcome-workspace">
        <section className="project-welcome" aria-labelledby="project-welcome-title">
          <h2 id="project-welcome-title">Start with a clear chat.</h2>
          <button type="button" className="primary-button" onClick={onCreateConversation}><SquarePen size={16} /><span>New chat</span></button>
        </section>
      </Root>
    );
  }

  const projectPromptName = project.name.trim();
  const emptyThreadProject = projectPromptName || "this project";
  const emptyThreadTitle = `What should we build in ${emptyThreadProject}?`;
  const isEmptyThread = !detailLoading
    && ownedMessages.length === 0
    && ownedTurns.length === 0;
  const canRollBackToStart = (!stopTurnStatus || isAgentTurnTerminalStatus(stopTurnStatus))
    && ownedTurns.some(({ id, status }) => isAgentTurnTerminalStatus(status) && !rolledBackTurnIds?.includes(id));

  return (
    <ForkSurfaceProvider projectId={project.id} conversationId={conversation.id} run={onForkCommand}
      rolledBackTurnIds={rolledBackTurnIds} canRollBackToStart={canRollBackToStart}>
    <Root
      className={clsx(
        "chat-workspace",
        `response-density-${responseDensity}`,
        isEmptyThread && "is-empty-thread",
      )}
      data-reasoning-effort={selectedReasoningEffort}
      aria-busy={detailLoading || undefined}
    >
      <div
        ref={scrollRef}
        className="message-scroll"
        aria-label="Thread transcript"
        aria-describedby={keyboardHelpId}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End Alt+G"
        tabIndex={0}
        onScroll={onTranscriptScroll}
        onWheelCapture={noteWheelIntent}
        onTouchStartCapture={noteTouchIntent}
        onTouchMoveCapture={noteTouchIntent}
        onPointerDownCapture={(event) => {
          if (event.target === event.currentTarget) noteReaderIntent();
        }}
        onKeyDownCapture={noteReaderKeyboardIntent}
      >
        <span id={keyboardHelpId} className="visually-hidden">
          Use Alt plus Up or Down to move between turns, Alt plus Home for the request,
          Alt plus End for the final answer, and Alt plus G for the turn artifact.
        </span>
        <div ref={timelineRef} className="response-timeline">
          <ForkHistoryPanel />
          {history && (history.hasOlder || history.error) && (
            <div className="conversation-history-controls">
              {history.hasOlder && <button ref={keepHistoryFocus} type="button" className="subtle-button"
                aria-disabled={history.loading || !history.online || undefined}
                aria-describedby={history.online ? undefined : historyOfflineId}
                onClick={() => {
                  if (history.loading || !history.online) return;
                  noteResponseTimelineNavigationIntent();
                  history.loadOlder();
                }}>
                {history.loading ? "Loading earlier messages…" : "Load earlier messages"}
              </button>}
              {history.hasOlder && !history.online && <p id={historyOfflineId}>
                Earlier messages are unavailable while the local service is offline.
              </p>}
              {history.error && <p role="alert">{history.error}</p>}
            </div>
          )}
          {detailLoading && <LoadingMark label="Loading conversation" />}
          {isEmptyThread && (
            <div className="empty-thread">
              {newChatProjectPicker || project.workspaceKind === "scratch" ? (
                <h3>{project.workspaceKind === "scratch" ? "What should we work on?" : "What should we build today?"}</h3>
              ) : (
                <h3 aria-label={emptyThreadTitle}>
                  What should we build in{" "}
                  <span className="empty-thread-project">{emptyThreadProject}</span>?
                </h3>
              )}
            </div>
          )}
          <Suspense fallback={<LoadingMark label="Loading conversation" />}>
            {ResponseTimeline ? <StreamingResponseTimeline
              ResponseTimeline={ResponseTimeline}
              turns={ownedTurns}
              messages={ownedMessages}
              contextPackets={contextPackets}
              watcherWakes={watcherWakes}
              onConversationContextCommand={conversationContextHandoffEnabled
                ? onConversationContextCommand
                : undefined}
              activities={ownedActivities}
              subagents={ownedSubagents}
              reasonings={ownedReasonings}
              plans={ownedPlans}
              checkpoints={ownedCheckpoints}
              omittedTurnIds={history?.omittedTurnIds}
              gitArtifacts={ownedTurnGitArtifacts}
              projectRoot={projectRoot}
              projectId={project.id}
              conversationId={conversation.id}
              latestTurnSummary={timelineLatestTurnSummary}
              streaming={detailLoading
                ? EMPTY_STREAMING_AGENT_SOURCE
                : streaming}
              onStreamingContent={followLatestContent}
              terminalProjections={detailLoading
                ? undefined
                : terminalProjections}
              approvals={ownedApprovals}
              inputRequests={visibleInputRequests}
              providerIdentityLabels={providerIdentityLabels}
              showTimestamps={showTimestamps}
              showThinking={showThinking}
              defaultCodeWrap={defaultCodeWrap}
              autoCollapseWorkLog={autoCollapseWorkLog}
              showChangedFileSummaries={showChangedFileSummaries}
              autoScrollToFinalAnswer={autoScrollToFinalAnswer
                && transcriptNavigationFollowsContent(activeNavigation)}
              detailLoading={detailLoading}
              compactingSince={compactingSince}
              compactingTrigger={compactingTrigger}
              turnAnchorId={turnAnchorId}
              followsLatest={transcriptNavigationFollowsContent(activeNavigation)}
              onTurnAnchorSettled={onTurnAnchorSettled}
              onTurnAnchorCancelled={onTurnAnchorCancelled}
              onFinalAnswerAutoScroll={onFinalAnswerAutoScroll}
              onReaderNavigationIntent={noteResponseTimelineNavigationIntent}
              scrollElementRef={scrollRef}
              timelineElementRef={timelineRef}
              checkpointRestoreDisabled={conversation.status === "running"
                || conversation.status === "needs-input"}
              onRespondToApproval={onRespondToApproval}
              onRespondToInput={onRespondToInput}
              onRevertCheckpoint={onRevertCheckpoint}
              onOpenTurnDiff={onOpenTurnDiff}
              onCompareTurnArtifacts={onCompareTurnArtifacts}
              onOpenTurnFile={onOpenTurnFile}
              onStop={stopTimeline}
              onOpenSurface={onOpenSurface}
            /> : <LoadingMark label="Loading conversation" />}
          </Suspense>
        </div>
      </div>

      <div ref={composerRegionRef} className="composer-region">
        <TimelineJumpToLatest visible={showJump} scrollElementRef={scrollRef} onJump={scrollToLatest} />
        {pendingInputRequest && (
          <div
            className="pending-input-notice"
            role="status"
            aria-live="polite"
          >
            <MessageCircleQuestion size={14} aria-hidden="true" />
            <span>
              <strong>Agent needs your answer</strong>
              <small>{pendingInputRequest.questions.length === 1
                ? "1 question is waiting"
                : `${pendingInputRequest.questions.length} questions are waiting`}</small>
            </span>
            <button
              type="button"
              aria-controls={`agent-input-request-${pendingInputRequest.id}`}
              onClick={revealPendingInput}
            >
              Answer
            </button>
          </div>
        )}
        <DuoJudgeNoticeSlot
          conversationId={conversation.id}
          conversationStatus={conversation.status}
        />
        {maintenanceStatus && (maintenanceOperation
          || maintenanceStatus.versionStatus === "update-available") && (
          <Suspense fallback={null}>
            <ProviderMaintenanceNotice
              providerLabel={providerIdentityLabels?.[conversation.providerId]
                ?? providers.find(({ id }) =>
                  id === conversation.providerId)?.label
                ?? conversation.providerId}
              status={maintenanceStatus}
              operation={maintenanceOperation}
              onRefresh={onRefreshProviderMaintenance}
              onUpdate={onUpdateProvider}
              onCancel={onCancelProviderUpdate}
              onOpenInstructions={onOpenProviderUpdateInstructions}
            />
          </Suspense>
        )}
        <Composer
          conversation={conversation}
          checkoutBranch={checkoutBranch}
          showCheckoutContext={showCheckoutContext}
          scratchWorkspace={project.workspaceKind === "scratch"}
          newChatProjectPicker={newChatProjectPicker}
          providers={providers}
          actions={actions}
          mentionResults={mentionResults}
          usage={usage}
          usageDisplayMode={usageDisplayMode}
          skills={skills}
          skillsCapability={skillsCapability}
          skillsLoading={skillsLoading}
          skillsError={skillsError}
          goal={goalControl}
          conversationContextHandoffEnabled={conversationContextHandoffEnabled}
          agentContextRequestEnabled={agentContextRequestEnabled}
          promptContext={promptContext}
          contextSources={contextSources}
          contextPackets={contextPackets}
          hasVisibleHistory={hasVisibleHistory}
          agentContextRequest={agentContextRequest}
          onConversationContextCommand={onConversationContextCommand}
          onQueueCommand={onQueueCommand}
          onLimitResetCommand={onLimitResetCommand}
          previewContextUrl={previewContextUrl}
          providerIdentityLabels={providerIdentityLabels}
          disabled={!conversation}
          sending={sending}
          running={conversation.status === "running" || conversation.status === "needs-input"}
          backendProfiles={backendProfiles}
          latestTurn={ownedTurns.at(-1) ?? null}
          promptHistory={promptHistory}
          latestTurnSummary={latestTurnSummary}
          queuedTurnAuthoritative={queuedTurnAuthoritative}
          onSend={sendMessage}
          {...(onCompactConversation ? { onCompact: compactConversation } : {})}
          {...(onCompactAndSendMessage ? { onCompactAndSend: compactAndSendMessage } : {})}
          compaction={compaction}
          compactOnReturnSetting={compactOnReturnSetting}
          onListSkills={onListSkills}
          promptPresets={promptPresets}
          promptPresetsEnabled={promptPresetsEnabled}
          promptStashEnabled={promptStashEnabled}
          onPromptPresetCommand={onPromptPresetCommand}
          onUpdateConversation={onUpdateConversation}
          onChooseAttachments={onChooseAttachments}
          onImportAttachments={onImportAttachments}
          onReleaseAttachment={onReleaseAttachment}
          onRunAction={onRunAction}
          onMentionQuery={onMentionQuery}
          onConnectProvider={onConnectProvider}
          onRefreshProvider={onRefreshProvider}
          onOpenProviderSetup={onOpenProviderSetup}
          onOpenBackendSetup={onOpenBackendSetup}
          onProbeBackendProfile={onProbeBackendProfile}
          onOpenResume={onOpenResume}
          resumeOptions={resumeOptions}
          onResumeConversation={onResumeConversation}
          onUsageDisplayModeChange={onUsageDisplayModeChange}
          onStop={stopWithPromptRestore}
          onClearPromptContext={onClearPromptContext}
        />
      </div>
    </Root>
    </ForkSurfaceProvider>
  );
}
