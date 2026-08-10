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
} from "react";
import {
  ArrowDown,
  ArrowRight,
  Code2,
  FolderPlus,
  MessageCircleQuestion,
  MessageSquarePlus,
  ShieldCheck,
  TerminalSquare,
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
  ChatMessage,
  CheckpointSummary,
  ConversationLatestTurnSummary,
  Conversation,
  ModelBackendProfileView,
  ModelSelection,
  Project,
  ProjectAction,
  ProviderId,
  ProviderInfo,
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
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { shouldFollowTimeline } from "../utils/responseTimeline";
import { revealAgentInputRequest } from "../utils/agentInputNavigation";
import {
  initialTranscriptNavigation,
  isTranscriptReaderNavigationKey,
  type TranscriptMessageSendAcceptance,
  transcriptNavigationFollowsContent,
  transcriptNavigationReducer,
} from "../utils/transcriptNavigation";
import { Composer } from "./Composer";
import type { ChatGoalControlProps } from "./ChatGoalControl";
import type { ProviderTerminalResumeOption } from "./providerResumeOptions";
import type { FinalAnswerAutoScrollEvent } from "./response-timeline/types";
import { LoadingMark } from "./ui";
import { ProviderMaintenanceNotice } from "./ProviderMaintenanceNotice";

const ResponseTimeline = lazy(async () => ({
  default: (await import("./ResponseTimeline")).ResponseTimeline,
}));

const READER_INTENT_GUARD_MS = 750;

type ChatWorkspaceProps = {
  embedded?: boolean;
  project: Project | null;
  conversation: Conversation | null;
  latestTurnSummary: ConversationLatestTurnSummary | null;
  turns: AgentTurn[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  subagents: SubagentTrace[];
  reasonings: AgentReasoning[];
  plans: AgentPlan[];
  checkpoints: CheckpointSummary[];
  turnGitArtifacts: TurnGitArtifact[];
  streamingText: string;
  streamingReasoning: string;
  usage: ThreadUsageSnapshot | null;
  skills: AgentSkillSummary[];
  skillsCapability: AgentWorkflowSkillsCapability | null;
  selectedSkillIds: readonly string[];
  skillsLoading: boolean;
  skillsError: string | null;
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
  previewContextUrl?: string | null;
  providerIdentityLabels?: ProviderIdentityLabels;
  loading: boolean;
  sending: boolean;
  onAddProject: () => void;
  onCreateConversation: () => void;
  onSendMessage: (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    skillIds?: readonly string[],
  ) => Promise<TranscriptMessageSendAcceptance | null>;
  onListSkills: (forceReload?: boolean) => Promise<void>;
  onToggleSkill: (skill: AgentSkillSummary) => void;
  onClearSelectedSkills: () => void;
  onRespondToApproval: (request: AgentApprovalRequest, decision: AgentApprovalDecision) => Promise<void>;
  onRespondToInput: (request: AgentInputRequest, answers: Record<string, string[]>) => Promise<void>;
  onUpdateConversation: (update: Partial<Pick<Conversation, "providerId" | "modelSelection" | "model" | "reasoningEffort" | "interactionMode" | "accessMode">>) => Promise<void>;
  onCreateConversationForSelection: (
    selection: ModelSelection,
    options?: { prefillText?: string },
  ) => Promise<void>;
  onChooseAttachments: () => Promise<ChatAttachment[]>;
  onImportAttachments: (files: File[]) => Promise<ChatAttachment[]>;
  onReleaseAttachment: (id: string) => Promise<void>;
  onRunAction: (action: ProjectAction) => void;
  onMentionQuery: (query: string) => void;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId: ProviderId) => void;
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onOpenBackendSetup: (profileId: string) => void;
  onProbeBackendProfile: (profileId: string, modelId: string) => Promise<void>;
  onRefreshProviderMaintenance: () => Promise<void>;
  onUpdateProvider: () => Promise<void>;
  onCancelProviderUpdate: (operationId: string) => Promise<void>;
  onOpenProviderUpdateInstructions: (url: string) => void;
  onOpenResume: () => void;
  resumeOptions?: readonly ProviderTerminalResumeOption[];
  onResumeConversation?: (conversationId: string) => void;
  onUsageDisplayModeChange: (mode: UsageDisplayMode) => void;
  onStop: () => Promise<void>;
  onFollowUpSubagent?: (trace: SubagentTrace) => void;
  onStopSubagent: (trace: SubagentTrace) => Promise<void>;
  onRevertCheckpoint: (checkpoint: CheckpointSummary) => void;
  onOpenTurnDiff: (turnId: string, path?: string) => void;
  onCompareTurnArtifacts: (earlierTurnId: string, laterTurnId: string) => void;
  onOpenTurnFile: (path: string) => void;
  onClearPromptContext?: () => void;
  onLatestContentVisibilityChange?: (visible: boolean) => void;
};

export function ChatWorkspace({
  embedded = false,
  project,
  conversation,
  latestTurnSummary,
  turns,
  messages,
  activities,
  subagents,
  reasonings,
  plans,
  checkpoints,
  turnGitArtifacts,
  streamingText,
  streamingReasoning,
  usage,
  skills,
  skillsCapability,
  selectedSkillIds,
  skillsLoading,
  skillsError,
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
  previewContextUrl,
  providerIdentityLabels,
  loading,
  sending,
  onAddProject,
  onCreateConversation,
  onSendMessage,
  onListSkills,
  onToggleSkill,
  onClearSelectedSkills,
  onRespondToApproval,
  onRespondToInput,
  onUpdateConversation,
  onCreateConversationForSelection,
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
  onFollowUpSubagent,
  onStopSubagent,
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
  const Root = embedded ? "section" : "main";
  const selectedReasoningEffort = conversation?.modelSelection.reasoningEffort
    ?.trim().toLowerCase() ?? "";
  const keyboardHelpId = useId();
  const stopTimeline = useCallback(() => {
    void onStop().catch(() => undefined);
  }, [onStop]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRegionRef = useRef<HTMLDivElement>(null);
  const followCorrectionFrameRef = useRef<number | null>(null);
  const readerIntentReleaseTimerRef = useRef<number | null>(null);
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
  const goalLoading = goal?.loading ?? false;
  const goalBusy = goal?.busy ?? false;
  const goalError = goal?.error ?? null;
  const goalControl = useMemo<ChatGoalControlProps | null>(() => hasGoalControl ? ({
    workflow: goalWorkflow,
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
    goalLoading,
    goalWorkflow,
    hasGoalControl,
    retryGoal,
    setChatGoal,
  ]);
  const conversationId = conversation?.id ?? null;
  const [navigation, dispatchNavigation] = useReducer(
    transcriptNavigationReducer,
    conversationId,
    initialTranscriptNavigation,
  );
  const activeNavigation = navigation.conversationId === conversationId
    ? navigation
    : initialTranscriptNavigation(conversationId);
  const navigationRef = useRef(activeNavigation);
  navigationRef.current = activeNavigation;
  const readerIntentRef = useRef(false);
  const finalAnswerAutoScrollOwnerRef = useRef<string | null>(null);
  const showJump = activeNavigation.mode === "reading-history";
  const pendingInputRequest = inputRequests.at(-1) ?? null;
  const projectRoot = conversation?.worktreePath ?? project?.path ?? "";
  const contentSignal = `${turns.length}:${turns.at(-1)?.updatedAt ?? ""}:${messages.length}:${messages.at(-1)?.content.length ?? 0}:${activities.length}:${subagents.length}:${subagents.at(-1)?.updatedAt ?? ""}:${plans.length}:${checkpoints.length}:${turnGitArtifacts.length}:${turnGitArtifacts.at(-1)?.status ?? ""}:${turnGitArtifacts.at(-1)?.capturedAt ?? ""}:${streamingText.length}:${streamingReasoning.length}:${approvals.length}:${inputRequests.length}`;

  const clearReaderIntent = useCallback((): void => {
    readerIntentRef.current = false;
    if (readerIntentReleaseTimerRef.current !== null) {
      window.clearTimeout(readerIntentReleaseTimerRef.current);
      readerIntentReleaseTimerRef.current = null;
    }
  }, []);

  const performScrollToLatest = useCallback((
    behavior: ScrollBehavior = "smooth",
  ): void => {
    if (
      readerIntentRef.current
      || finalAnswerAutoScrollOwnerRef.current !== null
    ) return;
    const element = scrollRef.current;
    if (!element) return;
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
    correctMeasuredBottom(8);
  }, [onLatestContentVisibilityChange]);

  const scrollToLatest = useCallback((
    behavior: ScrollBehavior = "smooth",
  ): void => {
    if (!conversationId) return;
    clearReaderIntent();
    dispatchNavigation({
      type: "latest.requested",
      conversationId,
    });
    performScrollToLatest(behavior);
  }, [clearReaderIntent, conversationId, performScrollToLatest]);

  const onFinalAnswerAutoScroll = useCallback((
    event: FinalAnswerAutoScrollEvent,
  ): void => {
    const owner = `${event.conversationId}\u0000${event.answerId}`;
    if (event.status === "started") {
      if (navigationRef.current.conversationId !== event.conversationId) return;
      finalAnswerAutoScrollOwnerRef.current = owner;
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

    readerIntentRef.current = true;
    dispatchNavigation({
      type: "reader.scrolled",
      conversationId: event.conversationId,
      followsLatest: event.followsLatest,
      intentional: true,
    });
    onLatestContentVisibilityChange?.(event.followsLatest);
    if (readerIntentReleaseTimerRef.current !== null) {
      window.clearTimeout(readerIntentReleaseTimerRef.current);
    }
    readerIntentReleaseTimerRef.current = window.setTimeout(() => {
      readerIntentRef.current = false;
      readerIntentReleaseTimerRef.current = null;
    }, READER_INTENT_GUARD_MS);
  }, [onLatestContentVisibilityChange]);

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
    finalAnswerAutoScrollOwnerRef.current = null;
    clearReaderIntent();
    dispatchNavigation({
      type: "conversation.changed",
      conversationId,
    });
    performScrollToLatest("auto");
  }, [clearReaderIntent, conversationId, performScrollToLatest]);

  useEffect(
    () => () => {
      if (followCorrectionFrameRef.current !== null) {
        window.cancelAnimationFrame(followCorrectionFrameRef.current);
      }
      onLatestContentVisibilityChange?.(false);
    },
    [onLatestContentVisibilityChange],
  );

  useEffect(
    () => () => clearReaderIntent(),
    [clearReaderIntent],
  );

  useEffect(() => {
    if (!transcriptNavigationFollowsContent(navigationRef.current)) return;
    const frame = window.requestAnimationFrame(
      () => performScrollToLatest("auto"),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [contentSignal, performScrollToLatest]);

  useEffect(() => {
    const content = timelineRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (transcriptNavigationFollowsContent(navigationRef.current)) {
        performScrollToLatest("auto");
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversationId, performScrollToLatest]);

  useEffect(() => {
    const composer = composerRegionRef.current;
    if (!composer || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (transcriptNavigationFollowsContent(navigationRef.current)) {
        performScrollToLatest("auto");
      }
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [conversationId, performScrollToLatest]);

  const noteReaderIntent = (): void => {
    readerIntentRef.current = true;
    if (followCorrectionFrameRef.current !== null) {
      window.cancelAnimationFrame(followCorrectionFrameRef.current);
      followCorrectionFrameRef.current = null;
    }
    if (readerIntentReleaseTimerRef.current !== null) {
      window.clearTimeout(readerIntentReleaseTimerRef.current);
    }
    readerIntentReleaseTimerRef.current = window.setTimeout(() => {
      readerIntentRef.current = false;
      readerIntentReleaseTimerRef.current = null;
    }, READER_INTENT_GUARD_MS);
  };

  const noteReaderKeyboardIntent = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (isTranscriptReaderNavigationKey(event.key)) noteReaderIntent();
  };

  const onTranscriptScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const follows = shouldFollowTimeline(element.scrollTop, element.clientHeight, element.scrollHeight);
    if (finalAnswerAutoScrollOwnerRef.current !== null) {
      onLatestContentVisibilityChange?.(follows);
      return;
    }
    const intentional = readerIntentRef.current;
    if (follows) clearReaderIntent();
    dispatchNavigation({
      type: "reader.scrolled",
      conversationId: conversationId ?? "",
      followsLatest: follows,
      intentional,
    });
    onLatestContentVisibilityChange?.(follows);
  };

  const sendMessage = useCallback(async (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    skillIds?: readonly string[],
  ): Promise<void> => {
    const sourceConversationId = conversationId;
    const acceptance = await onSendMessage(
      content,
      attachments,
      context,
      skillIds,
    );
    if (!acceptance) return;
    clearReaderIntent();
    dispatchNavigation({
      type: "message.accepted",
      acceptance,
      sourceConversationId,
    });
  }, [clearReaderIntent, conversationId, onSendMessage]);

  const turnAnchorId = activeNavigation.mode === "await-turn"
    ? activeNavigation.turnId
    : null;
  const onTurnAnchorSettled = useCallback((turnId: string): void => {
    if (!conversationId) return;
    dispatchNavigation({
      type: "turn.anchored",
      conversationId,
      turnId,
    });
    onLatestContentVisibilityChange?.(true);
  }, [conversationId, onLatestContentVisibilityChange]);
  const onTurnAnchorCancelled = useCallback((turnId: string): void => {
    if (!conversationId) return;
    dispatchNavigation({
      type: "turn.anchor-cancelled",
      conversationId,
      turnId,
    });
    onLatestContentVisibilityChange?.(false);
  }, [conversationId, onLatestContentVisibilityChange]);

  if (loading) {
    return (
      <Root className="chat-workspace centered-state" aria-busy="true">
        <LoadingMark label="Loading workspace" />
        <p>Preparing your local workspace…</p>
      </Root>
    );
  }

  if (!project) {
    return (
      <Root className="chat-workspace welcome-workspace">
        <section className="welcome-card" aria-labelledby="welcome-title">
          <div className="welcome-mark"><img src="./inertia-logo.png" alt="" /></div>
          <span className="welcome-kicker">A calmer place to build</span>
          <h2 id="welcome-title">Bring a project into focus.</h2>
          <p>Inertia keeps conversations, your project, and a real local terminal together—without turning the workspace into noise.</p>
          <button type="button" className="primary-button" onClick={onAddProject}><FolderPlus size={16} /><span>Add your first project</span><ArrowRight size={15} /></button>
          <div className="welcome-features"><div><Code2 size={17} /><span>Project-aware</span></div><div><TerminalSquare size={17} /><span>Local terminal</span></div><div><ShieldCheck size={17} /><span>Local by default</span></div></div>
        </section>
      </Root>
    );
  }

  if (!conversation) {
    return (
      <Root className="chat-workspace welcome-workspace">
        <section className="project-welcome" aria-labelledby="project-welcome-title">
          <span className="project-welcome-icon"><MessageSquarePlus size={22} /></span>
          <span className="welcome-kicker">{project.name}</span>
          <h2 id="project-welcome-title">Start with a clear chat.</h2>
          <p>Create a chat for the next feature, question, or focused pass through this project.</p>
          <button type="button" className="primary-button" onClick={onCreateConversation}><MessageSquarePlus size={16} /><span>New chat</span></button>
          <code className="project-path-display">{project.path}</code>
        </section>
      </Root>
    );
  }

  return (
    <Root
      className={clsx("chat-workspace", `response-density-${responseDensity}`)}
      data-reasoning-effort={selectedReasoningEffort}
    >
      <div
        ref={scrollRef}
        className="message-scroll"
        aria-label="Thread transcript"
        aria-describedby={keyboardHelpId}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End Alt+G"
        tabIndex={0}
        onScroll={onTranscriptScroll}
        onWheelCapture={noteReaderIntent}
        onTouchStartCapture={noteReaderIntent}
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
          {messages.length === 0 && turns.length === 0 && (
            <div className="empty-thread"><span className="empty-thread-icon"><Code2 size={20} /></span><h3>What should we work on?</h3><p>Describe the outcome you want. The details can take shape together.</p></div>
          )}
          <Suspense fallback={<LoadingMark label="Loading conversation" />}>
            <ResponseTimeline
              turns={turns}
              messages={messages}
              activities={activities}
              subagents={subagents}
              reasonings={reasonings}
              plans={plans}
              checkpoints={checkpoints}
              gitArtifacts={turnGitArtifacts}
              projectRoot={projectRoot}
              projectId={project.id}
              conversationId={conversation.id}
              streamingText={streamingText}
              streamingReasoning={streamingReasoning}
              approvals={approvals}
              inputRequests={inputRequests}
              providerIdentityLabels={providerIdentityLabels}
              showTimestamps={showTimestamps}
              showThinking={showThinking}
              defaultCodeWrap={defaultCodeWrap}
              autoCollapseWorkLog={autoCollapseWorkLog}
              showChangedFileSummaries={showChangedFileSummaries}
              autoScrollToFinalAnswer={autoScrollToFinalAnswer
                && transcriptNavigationFollowsContent(activeNavigation)}
              detailLoading={loading}
              turnAnchorId={turnAnchorId}
              onTurnAnchorSettled={onTurnAnchorSettled}
              onTurnAnchorCancelled={onTurnAnchorCancelled}
              onFinalAnswerAutoScroll={onFinalAnswerAutoScroll}
              scrollElementRef={scrollRef}
              timelineElementRef={timelineRef}
              checkpointRestoreDisabled={turns.some(({ status }) =>
                status === "queued"
                || status === "starting"
                || status === "running"
                || status === "waiting-for-approval"
                || status === "waiting-for-input")}
              onRespondToApproval={onRespondToApproval}
              onRespondToInput={onRespondToInput}
              onRevertCheckpoint={onRevertCheckpoint}
              onOpenTurnDiff={onOpenTurnDiff}
              onCompareTurnArtifacts={onCompareTurnArtifacts}
              onOpenTurnFile={onOpenTurnFile}
              onStop={stopTimeline}
              onFollowUpSubagent={onFollowUpSubagent}
              onStopSubagent={onStopSubagent}
            />
          </Suspense>
        </div>
      </div>

      {showJump && <div className="timeline-follow-controls"><button type="button" onClick={() => scrollToLatest("auto")}><ArrowDown size={14} />Jump to latest</button></div>}

      <div ref={composerRegionRef} className="composer-region">
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
        <Composer
          conversation={conversation}
          providers={providers}
          actions={actions}
          mentionResults={mentionResults}
          usage={usage}
          usageDisplayMode={usageDisplayMode}
          skills={skills}
          skillsCapability={skillsCapability}
          selectedSkillIds={selectedSkillIds}
          skillsLoading={skillsLoading}
          skillsError={skillsError}
          goal={goalControl}
          promptContext={promptContext}
          previewContextUrl={previewContextUrl}
          providerIdentityLabels={providerIdentityLabels}
          disabled={!conversation}
          sending={sending}
          running={conversation.status === "running" || conversation.status === "needs-input"}
          backendProfiles={backendProfiles}
          latestTurn={turns.at(-1) ?? null}
          latestTurnSummary={latestTurnSummary}
          onSend={sendMessage}
          onListSkills={onListSkills}
          onToggleSkill={onToggleSkill}
          onClearSelectedSkills={onClearSelectedSkills}
          onUpdateConversation={onUpdateConversation}
          onCreateConversationForSelection={onCreateConversationForSelection}
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
          onStop={onStop}
          onClearPromptContext={onClearPromptContext}
        />
      </div>
    </Root>
  );
}
