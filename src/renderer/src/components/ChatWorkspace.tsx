import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  BrainCircuit,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  Code2,
  Copy,
  FileCode2,
  Files,
  FolderPlus,
  MessageSquarePlus,
  Paperclip,
  RotateCcw,
  ShieldCheck,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import clsx from "clsx";
import type {
  AgentActivity,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentReasoning,
  ChatAttachment,
  ChatMessage,
  ChangedFile,
  CheckpointSummary,
  Conversation,
  Project,
  ProjectAction,
  ProviderId,
  ProviderInfo,
  ResponseDensity,
  ThreadUsageSnapshot,
  UsageDisplayMode,
  WorkspaceEntry,
} from "@shared/contracts";
import { formatClockTime } from "../lib/format";
import {
  buildResponseTimeline,
  formatElapsed,
  shouldFollowTimeline,
  turnElapsedMs,
  workSummaryLabel,
  type ResponseTurn,
} from "../utils/responseTimeline";
import { ApprovalCard, InputRequestCard } from "./AgentRequestCard";
import { Composer } from "./Composer";
import { ResponseMarkdown } from "./ResponseMarkdown";
import { LoadingMark } from "./ui";

type ChatWorkspaceProps = {
  project: Project | null;
  conversation: Conversation | null;
  messages: ChatMessage[];
  activities: AgentActivity[];
  reasonings: AgentReasoning[];
  checkpoints: CheckpointSummary[];
  changedFiles: ChangedFile[];
  streamingText: string;
  streamingReasoning: string;
  usage: ThreadUsageSnapshot | null;
  approvals: AgentApprovalRequest[];
  inputRequests: AgentInputRequest[];
  providers: ProviderInfo[];
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
  onSendMessage: (content: string, attachments: ChatAttachment[]) => Promise<void>;
  onRespondToApproval: (request: AgentApprovalRequest, decision: AgentApprovalDecision) => Promise<void>;
  onRespondToInput: (request: AgentInputRequest, answers: Record<string, string[]>) => Promise<void>;
  onUpdateConversation: (update: Partial<Pick<Conversation, "providerId" | "model" | "reasoningEffort" | "interactionMode" | "accessMode">>) => void;
  onChooseAttachments: () => Promise<ChatAttachment[]>;
  onImportAttachments: (files: File[]) => Promise<ChatAttachment[]>;
  onRunAction: (action: ProjectAction) => void;
  onMentionQuery: (query: string) => void;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId: ProviderId) => void;
  onUsageDisplayModeChange: (mode: UsageDisplayMode) => void;
  onStop: () => void;
  onRevertCheckpoint: (checkpoint: CheckpointSummary) => void;
  onClearPromptContext?: () => void;
};

function useCopyAction(): [boolean, (content: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const copy = async (content: string): Promise<void> => {
    if (!navigator.clipboard || !content) return;
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1_500);
  };
  return [copied, copy];
}

function CopyAnswerButton({ content }: { content: string }): React.JSX.Element {
  const [copied, copy] = useCopyAction();
  return (
    <button type="button" className="turn-action" title="Copy answer" onClick={() => void copy(content)}>
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? "Copied" : "Copy answer"}</span>
    </button>
  );
}

function LiveElapsed({ startedAt }: { startedAt: string }): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <span>{formatElapsed(Math.max(0, now - Date.parse(startedAt)))}</span>;
}

function ActivityRow({ activity }: { activity: AgentActivity }): React.JSX.Element {
  const Icon = activity.status === "failed" ? TriangleAlert : activity.status === "completed" ? CheckCircle2 : CircleDot;
  return (
    <div className={clsx("agent-activity", `is-${activity.status}`, activity.kind === "error" && "is-important")}>
      <Icon size={14} />
      <span><strong>{activity.title}</strong>{activity.detail && <small>{activity.detail}</small>}</span>
    </div>
  );
}

function WorkLog({ turn, autoCollapse }: { turn: ResponseTurn; autoCollapse: boolean }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(!autoCollapse);
  useEffect(() => setExpanded(!autoCollapse), [autoCollapse]);
  if (turn.activities.length === 0) return null;
  if (turn.isActive || !autoCollapse) {
    return <div className="turn-work-log">{turn.activities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}</div>;
  }
  return (
    <div className="turn-work-log is-settled">
      {turn.foldableActivities.length > 0 && (
        <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>
            <CheckCircle2 size={14} />
            <span>{workSummaryLabel(turn)}</span>
            <small>{expanded ? "Hide details" : "Show details"}</small>
          </summary>
          <div>{turn.foldableActivities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}</div>
        </details>
      )}
      {turn.importantActivities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}
    </div>
  );
}

function ChangedFilesSummary({ files }: { files: ChangedFile[] }): React.JSX.Element | null {
  if (files.length === 0) return null;
  return (
    <details className="turn-changed-files">
      <summary><Files size={14} /><span>{files.length} changed {files.length === 1 ? "file" : "files"} in the workspace</span><small>Current</small></summary>
      <div>
        {files.slice(0, 12).map((file) => (
          <span key={file.path} title={file.path}>
            <FileCode2 size={13} />
            <code>{file.path}</code>
            <small>{file.status}</small>
          </span>
        ))}
        {files.length > 12 && <p>And {files.length - 12} more.</p>}
      </div>
    </details>
  );
}

function TurnTimeline({
  turn,
  projectRoot,
  provider,
  streamingText,
  streamingReasoning,
  approvals,
  inputRequests,
  showTimestamps,
  showThinking,
  defaultCodeWrap,
  autoCollapseWorkLog,
  changedFiles,
  showChangedFileSummaries,
  checkpointRestoreDisabled,
  onRespondToApproval,
  onRespondToInput,
  onRevertCheckpoint,
}: {
  turn: ResponseTurn;
  projectRoot: string;
  provider: ProviderInfo | undefined;
  streamingText: string;
  streamingReasoning: string;
  approvals: AgentApprovalRequest[];
  inputRequests: AgentInputRequest[];
  showTimestamps: boolean;
  showThinking: boolean;
  defaultCodeWrap: boolean;
  autoCollapseWorkLog: boolean;
  changedFiles: ChangedFile[];
  showChangedFileSummaries: boolean;
  checkpointRestoreDisabled: boolean;
  onRespondToApproval: ChatWorkspaceProps["onRespondToApproval"];
  onRespondToInput: ChatWorkspaceProps["onRespondToInput"];
  onRevertCheckpoint: ChatWorkspaceProps["onRevertCheckpoint"];
}): React.JSX.Element {
  const persistedLast = turn.assistantMessages.at(-1);
  const liveContent = turn.isActive ? streamingText || persistedLast?.content || "" : "";
  const settledAssistantMessages = turn.isActive && persistedLast
    ? turn.assistantMessages.slice(0, -1)
    : turn.assistantMessages;
  const reasoningContent = turn.isActive ? streamingReasoning || turn.reasoning?.content || "" : turn.reasoning?.content || "";
  const providerLabel = provider?.label ?? "Agent";

  return (
    <section className={clsx("response-turn", turn.isActive && "is-active")} aria-label={`Turn ${turn.index}`}>
      <article className="message is-user">
        <div className="message-meta">
          <span>You</span>
          {showTimestamps && <time dateTime={turn.userMessage.createdAt}>{formatClockTime(turn.userMessage.createdAt)}</time>}
          {turn.checkpoint && <button type="button" className="message-revert" title={checkpointRestoreDisabled ? "Stop the active run before restoring a checkpoint" : "Restore the project to before this turn"} disabled={checkpointRestoreDisabled} onClick={() => onRevertCheckpoint(turn.checkpoint!)}><RotateCcw size={11} />Revert</button>}
        </div>
        <div className="message-body">{turn.userMessage.content}</div>
        {turn.userMessage.attachments.length > 0 && (
          <div className="message-attachments">
            {turn.userMessage.attachments.map((attachment) => <span key={attachment.id}><Paperclip size={12} />{attachment.name}</span>)}
          </div>
        )}
      </article>

      {(turn.activities.length > 0 || reasoningContent || liveContent || turn.isActive || approvals.length > 0 || inputRequests.length > 0) && (
        <section className="agent-run-card" aria-label={`${providerLabel} activity`}>
          {turn.isActive && (
            <header className="turn-working-state">
              <span className="turn-working-pulse"><CircleDot size={14} /></span>
              <strong>{providerLabel} is working</strong>
              <span><Clock3 size={12} /><LiveElapsed startedAt={turn.startedAt} /></span>
            </header>
          )}
          {showThinking && reasoningContent && (
            <details className={clsx("thinking-summary", turn.isActive && "is-live")} open={turn.isActive}>
              <summary><BrainCircuit size={14} /><span>{turn.isActive ? "Reasoning summary" : "Thought through this turn"}</span><small>{turn.isActive ? "Live" : "Summary"}</small></summary>
              <div>{reasoningContent}{turn.isActive && <span className="streaming-caret" />}</div>
            </details>
          )}
          <WorkLog turn={turn} autoCollapse={autoCollapseWorkLog} />
          {approvals.map((request) => <ApprovalCard key={request.id} request={request} onRespond={onRespondToApproval} />)}
          {inputRequests.map((request) => <InputRequestCard key={request.id} request={request} onRespond={onRespondToInput} />)}
        </section>
      )}

      {turn.systemMessages.map((message) => (
        <article className="message is-system" key={message.id}>
          <div className="message-meta"><span>System</span>{showTimestamps && <time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>}</div>
          <div className="message-body">{message.content}</div>
        </article>
      ))}

      {settledAssistantMessages.map((message) => (
        <article className="message is-assistant" key={message.id}>
          <div className="message-meta"><span>Agent</span>{showTimestamps && <time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>}</div>
          <ResponseMarkdown content={message.content} projectRoot={projectRoot} defaultCodeWrap={defaultCodeWrap} />
          <footer className="turn-meta">
            <span><Clock3 size={11} />{formatElapsed(turnElapsedMs(turn))}</span>
            {turn.toolCallCount > 0 && <span>{turn.toolCallCount} tool {turn.toolCallCount === 1 ? "call" : "calls"}</span>}
            <CopyAnswerButton content={message.content} />
          </footer>
        </article>
      ))}

      {turn.isActive && liveContent && (
        <article className="message is-assistant is-streaming" aria-label="Streaming assistant answer">
          <div className="message-meta"><span>Agent</span><span className="live-label">Live</span></div>
          <ResponseMarkdown content={liveContent} projectRoot={projectRoot} defaultCodeWrap={defaultCodeWrap} streaming />
          <span className="streaming-caret" aria-hidden="true" />
        </article>
      )}

      {!turn.isActive && showChangedFileSummaries && <ChangedFilesSummary files={changedFiles} />}
    </section>
  );
}

export function ChatWorkspace({
  project,
  conversation,
  messages,
  activities,
  reasonings,
  checkpoints,
  changedFiles,
  streamingText,
  streamingReasoning,
  usage,
  approvals,
  inputRequests,
  providers,
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
  onChooseAttachments,
  onImportAttachments,
  onRunAction,
  onMentionQuery,
  onConnectProvider,
  onRefreshProvider,
  onUsageDisplayModeChange,
  onStop,
  onRevertCheckpoint,
  onClearPromptContext,
}: ChatWorkspaceProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRegionRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const timeline = useMemo(() => conversation ? buildResponseTimeline({
    messages,
    activities,
    reasonings,
    checkpoints,
    status: conversation.status,
    conversationUpdatedAt: conversation.updatedAt,
  }) : [], [activities, checkpoints, conversation, messages, reasonings]);
  const latestTurnId = [...timeline].reverse().find(({ kind }) => kind === "turn")?.id;
  const activeProvider = providers.find(({ id }) => id === conversation?.providerId);
  const projectRoot = conversation?.worktreePath ?? project?.path ?? "";
  const contentSignal = `${messages.length}:${messages.at(-1)?.content.length ?? 0}:${activities.length}:${streamingText.length}:${streamingReasoning.length}:${approvals.length}:${inputRequests.length}`;

  const scrollToLatest = (behavior: ScrollBehavior = "smooth"): void => {
    const element = scrollRef.current;
    if (!element) return;
    followingRef.current = true;
    setShowJump(false);
    element.scrollTo({ top: element.scrollHeight, behavior });
  };

  useLayoutEffect(() => {
    scrollToLatest("auto");
  }, [conversation?.id]);

  useEffect(() => {
    if (!followingRef.current) return;
    const frame = window.requestAnimationFrame(() => scrollToLatest(streamingText ? "auto" : "smooth"));
    return () => window.cancelAnimationFrame(frame);
  }, [contentSignal]);

  useEffect(() => {
    const content = timelineRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToLatest("auto");
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversation?.id]);

  useEffect(() => {
    const composer = composerRegionRef.current;
    if (!composer || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToLatest("auto");
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [conversation?.id]);

  const onTranscriptScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const follows = shouldFollowTimeline(element.scrollTop, element.clientHeight, element.scrollHeight);
    followingRef.current = follows;
    setShowJump(!follows);
  };

  if (loading) {
    return (
      <main className="chat-workspace centered-state" aria-busy="true">
        <LoadingMark label="Loading workspace" />
        <p>Preparing your local workspace…</p>
      </main>
    );
  }

  if (!project) {
    return (
      <main className="chat-workspace welcome-workspace">
        <section className="welcome-card" aria-labelledby="welcome-title">
          <div className="welcome-mark"><img src="./inertia-logo.png" alt="" /></div>
          <span className="welcome-kicker">A calmer place to build</span>
          <h2 id="welcome-title">Bring a project into focus.</h2>
          <p>Inertia keeps conversations, your project, and a real local terminal together—without turning the workspace into noise.</p>
          <button type="button" className="primary-button" onClick={onAddProject}><FolderPlus size={16} /><span>Add your first project</span><ArrowRight size={15} /></button>
          <div className="welcome-features"><div><Code2 size={17} /><span>Project-aware</span></div><div><TerminalSquare size={17} /><span>Local terminal</span></div><div><ShieldCheck size={17} /><span>Local by default</span></div></div>
        </section>
      </main>
    );
  }

  if (!conversation) {
    return (
      <main className="chat-workspace welcome-workspace">
        <section className="project-welcome" aria-labelledby="project-welcome-title">
          <span className="project-welcome-icon"><MessageSquarePlus size={22} /></span>
          <span className="welcome-kicker">{project.name}</span>
          <h2 id="project-welcome-title">Start with a clear thread.</h2>
          <p>Create a thread for the next feature, question, or focused pass through this project.</p>
          <button type="button" className="primary-button" onClick={onCreateConversation}><MessageSquarePlus size={16} /><span>New thread</span></button>
          <code className="project-path-display">{project.path}</code>
        </section>
      </main>
    );
  }

  return (
    <main className={clsx("chat-workspace", `response-density-${responseDensity}`)}>
      <div ref={scrollRef} className="message-scroll" aria-label="Thread transcript" onScroll={onTranscriptScroll}>
        <div ref={timelineRef} className="response-timeline" aria-live="polite">
          {messages.length === 0 && (
            <div className="empty-thread"><span className="empty-thread-icon"><Code2 size={20} /></span><h3>What should we work on?</h3><p>Describe the outcome you want. The details can take shape together.</p></div>
          )}
          {timeline.map((item) => {
            if (item.kind === "message") {
              return (
                <article className={clsx("message", `is-${item.message.role}`)} key={item.id}>
                  <div className="message-meta"><span>{item.message.role === "assistant" ? "Agent" : "System"}</span>{showTimestamps && <time dateTime={item.message.createdAt}>{formatClockTime(item.message.createdAt)}</time>}</div>
                  {item.message.role === "assistant"
                    ? <ResponseMarkdown content={item.message.content} projectRoot={projectRoot} defaultCodeWrap={defaultCodeWrap} />
                    : <div className="message-body">{item.message.content}</div>}
                </article>
              );
            }
            if (item.kind === "activity") {
              return <section className="agent-run-card orphan-run-card" aria-label="Agent activity" key={item.id}>{item.activities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}</section>;
            }
            return (
              <TurnTimeline
                key={item.id}
                turn={item.turn}
                projectRoot={projectRoot}
                provider={activeProvider}
                streamingText={item.turn.isActive ? streamingText : ""}
                streamingReasoning={item.turn.isActive ? streamingReasoning : ""}
                approvals={item.turn.isActive ? approvals : []}
                inputRequests={item.turn.isActive ? inputRequests : []}
                showTimestamps={showTimestamps}
                showThinking={showThinking}
                defaultCodeWrap={defaultCodeWrap}
                autoCollapseWorkLog={autoCollapseWorkLog}
                changedFiles={item.id === latestTurnId ? changedFiles : []}
                showChangedFileSummaries={showChangedFileSummaries}
                checkpointRestoreDisabled={conversation.status === "running" || conversation.status === "needs-input"}
                onRespondToApproval={onRespondToApproval}
                onRespondToInput={onRespondToInput}
                onRevertCheckpoint={onRevertCheckpoint}
              />
            );
          })}
        </div>
      </div>

      {showJump && <div className="timeline-follow-controls"><button type="button" onClick={() => scrollToLatest()}><ArrowDown size={14} />Jump to latest</button></div>}

      <div ref={composerRegionRef} className="composer-region">
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
          onSend={onSendMessage}
          onUpdateConversation={onUpdateConversation}
          onChooseAttachments={onChooseAttachments}
          onImportAttachments={onImportAttachments}
          onRunAction={onRunAction}
          onMentionQuery={onMentionQuery}
          onConnectProvider={onConnectProvider}
          onRefreshProvider={onRefreshProvider}
          onUsageDisplayModeChange={onUsageDisplayModeChange}
          onStop={onStop}
          onClearPromptContext={onClearPromptContext}
        />
      </div>
    </main>
  );
}
