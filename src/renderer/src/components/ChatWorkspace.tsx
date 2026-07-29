import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  Code2,
  FolderPlus,
  MessageSquarePlus,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import clsx from "clsx";
import type {
  AgentActivity,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  ChatAttachment,
  ChatMessage,
  CheckpointSummary,
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
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { shouldFollowTimeline } from "../utils/responseTimeline";
import { Composer } from "./Composer";
import { ResponseTimeline } from "./ResponseTimeline";
import { LoadingMark } from "./ui";
import { ProviderMaintenanceNotice } from "./ProviderMaintenanceNotice";

type ChatWorkspaceProps = {
  embedded?: boolean;
  project: Project | null;
  conversation: Conversation | null;
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
  promptContext?: string | null;
  loading: boolean;
  sending: boolean;
  onAddProject: () => void;
  onCreateConversation: () => void;
  onSendMessage: (content: string, attachments: ChatAttachment[], context?: TurnRequestContext) => Promise<void>;
  onRespondToApproval: (request: AgentApprovalRequest, decision: AgentApprovalDecision) => Promise<void>;
  onRespondToInput: (request: AgentInputRequest, answers: Record<string, string[]>) => Promise<void>;
  onUpdateConversation: (update: Partial<Pick<Conversation, "providerId" | "modelSelection" | "model" | "reasoningEffort" | "interactionMode" | "accessMode">>) => void;
  onCreateConversationForSelection: (selection: ModelSelection) => Promise<void>;
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
  onUsageDisplayModeChange: (mode: UsageDisplayMode) => void;
  onStop: () => Promise<void>;
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
  promptContext,
  loading,
  sending,
  onAddProject,
  onCreateConversation,
  onSendMessage,
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
  onUsageDisplayModeChange,
  onStop,
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
  const keyboardHelpId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRegionRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const projectRoot = conversation?.worktreePath ?? project?.path ?? "";
  const contentSignal = `${turns.length}:${turns.at(-1)?.updatedAt ?? ""}:${messages.length}:${messages.at(-1)?.content.length ?? 0}:${activities.length}:${subagents.length}:${subagents.at(-1)?.updatedAt ?? ""}:${plans.length}:${streamingText.length}:${streamingReasoning.length}:${approvals.length}:${inputRequests.length}`;

  const scrollToLatest = useCallback((
    behavior: ScrollBehavior = "smooth",
  ): void => {
    const element = scrollRef.current;
    if (!element) return;
    followingRef.current = true;
    setShowJump(false);
    element.scrollTo({ top: element.scrollHeight, behavior });
    onLatestContentVisibilityChange?.(true);
  }, [onLatestContentVisibilityChange]);

  useLayoutEffect(() => {
    scrollToLatest("auto");
  }, [conversation?.id, scrollToLatest]);

  useEffect(
    () => () => onLatestContentVisibilityChange?.(false),
    [onLatestContentVisibilityChange],
  );

  const followBehavior: ScrollBehavior = streamingText ? "auto" : "smooth";
  useEffect(() => {
    if (!followingRef.current) return;
    const frame = window.requestAnimationFrame(
      () => scrollToLatest(followBehavior),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [contentSignal, followBehavior, scrollToLatest]);

  useEffect(() => {
    const content = timelineRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToLatest("auto");
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversation?.id, scrollToLatest]);

  useEffect(() => {
    const composer = composerRegionRef.current;
    if (!composer || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToLatest("auto");
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [conversation?.id, scrollToLatest]);

  const onTranscriptScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const follows = shouldFollowTimeline(element.scrollTop, element.clientHeight, element.scrollHeight);
    followingRef.current = follows;
    setShowJump(!follows);
    onLatestContentVisibilityChange?.(follows);
  };

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
    <Root className={clsx("chat-workspace", `response-density-${responseDensity}`)}>
      <div
        ref={scrollRef}
        className="message-scroll"
        aria-label="Thread transcript"
        aria-describedby={keyboardHelpId}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End Alt+G"
        tabIndex={0}
        onScroll={onTranscriptScroll}
      >
        <span id={keyboardHelpId} className="visually-hidden">
          Use Alt plus Up or Down to move between turns, Alt plus Home for the request,
          Alt plus End for the final answer, and Alt plus G for the turn artifact.
        </span>
        <div ref={timelineRef} className="response-timeline">
          {messages.length === 0 && turns.length === 0 && (
            <div className="empty-thread"><span className="empty-thread-icon"><Code2 size={20} /></span><h3>What should we work on?</h3><p>Describe the outcome you want. The details can take shape together.</p></div>
          )}
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
            providers={providers}
            streamingText={streamingText}
            streamingReasoning={streamingReasoning}
            approvals={approvals}
            inputRequests={inputRequests}
            showTimestamps={showTimestamps}
            showThinking={showThinking}
            defaultCodeWrap={defaultCodeWrap}
            autoCollapseWorkLog={autoCollapseWorkLog}
            showChangedFileSummaries={showChangedFileSummaries}
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
            onStop={() => { void onStop().catch(() => undefined); }}
            onStopSubagent={onStopSubagent}
          />
        </div>
      </div>

      {showJump && <div className="timeline-follow-controls"><button type="button" onClick={() => scrollToLatest("auto")}><ArrowDown size={14} />Jump to latest</button></div>}

      <div ref={composerRegionRef} className="composer-region">
        <ProviderMaintenanceNotice
          providerLabel={providers.find(({ id }) =>
            id === conversation.providerId)?.label ?? conversation.providerId}
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
          promptContext={promptContext}
          disabled={!conversation}
          sending={sending}
          running={conversation.status === "running" || conversation.status === "needs-input"}
          backendProfiles={backendProfiles}
          latestTurn={turns.at(-1) ?? null}
          onSend={onSendMessage}
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
          onUsageDisplayModeChange={onUsageDisplayModeChange}
          onStop={onStop}
          onClearPromptContext={onClearPromptContext}
        />
      </div>
    </Root>
  );
}
