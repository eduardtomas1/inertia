import { useEffect, useRef } from "react";
import { ArrowRight, BrainCircuit, CheckCircle2, CircleDot, Code2, FolderPlus, MessageSquarePlus, Paperclip, RotateCcw, ShieldCheck, TerminalSquare, TriangleAlert } from "lucide-react";
import clsx from "clsx";
import type { AgentActivity, AgentApprovalDecision, AgentApprovalRequest, AgentInputRequest, AgentReasoning, ChatAttachment, ChatMessage, CheckpointSummary, Conversation, Project, ProjectAction, ProviderId, ProviderInfo, ThreadUsageSnapshot, WorkspaceEntry } from "@shared/contracts";
import { formatClockTime } from "../lib/format";
import { ApprovalCard, InputRequestCard } from "./AgentRequestCard";
import { Composer } from "./Composer";
import { LoadingMark } from "./ui";

type ChatWorkspaceProps = {
  project: Project | null;
  conversation: Conversation | null;
  messages: ChatMessage[];
  activities: AgentActivity[];
  reasonings: AgentReasoning[];
  checkpoints: CheckpointSummary[];
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
  showUsage: boolean;
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
  onStop: () => void;
  onRevertCheckpoint: (checkpoint: CheckpointSummary) => void;
};

export function ChatWorkspace({
  project,
  conversation,
  messages,
  activities,
  reasonings,
  checkpoints,
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
  showUsage,
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
  onStop,
  onRevertCheckpoint,
}: ChatWorkspaceProps): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const persistedAssistantText = [...messages].reverse().find(({ role }) => role === "assistant")?.content ?? "";
  const visibleStreamingText = persistedAssistantText && streamingText.startsWith(persistedAssistantText)
    ? streamingText.slice(persistedAssistantText.length)
    : streamingText;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, activities.length, streamingText, streamingReasoning, conversation?.id]);

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
          <p>
            Inertia keeps conversations, your project, and a real local terminal together—without turning the workspace into noise.
          </p>
          <button type="button" className="primary-button" onClick={onAddProject}>
            <FolderPlus size={16} />
            <span>Add your first project</span>
            <ArrowRight size={15} />
          </button>
          <div className="welcome-features">
            <div><Code2 size={17} /><span>Project-aware</span></div>
            <div><TerminalSquare size={17} /><span>Local terminal</span></div>
            <div><ShieldCheck size={17} /><span>Local by default</span></div>
          </div>
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
          <button type="button" className="primary-button" onClick={onCreateConversation}>
            <MessageSquarePlus size={16} />
            <span>New thread</span>
          </button>
          <code className="project-path-display">{project.path}</code>
        </section>
      </main>
    );
  }

  return (
    <main className="chat-workspace">
      <div className="message-scroll" aria-label="Thread transcript" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty-thread">
            <span className="empty-thread-icon"><Code2 size={20} /></span>
            <h3>What should we work on?</h3>
            <p>Describe the outcome you want. The details can take shape together.</p>
          </div>
        )}

        {messages.map((message, messageIndex) => {
          const turnIndex = messages.slice(0, messageIndex + 1).filter(({ role }) => role === "user").length;
          const checkpoint = message.role === "user" ? checkpoints.find((item) => item.turnIndex === turnIndex) : undefined;
          const precedingUser = [...messages.slice(0, messageIndex)].reverse().find(({ role }) => role === "user");
          const reasoning = message.role === "assistant"
            ? [...reasonings].reverse().find((item) => item.createdAt <= message.createdAt && (!precedingUser || item.createdAt >= precedingUser.createdAt))
            : undefined;
          return (
          <div className="message-group" key={message.id}>
          {showThinking && reasoning?.content && (
            <details className="thinking-summary">
              <summary><BrainCircuit size={14} /><span>Thought through this turn</span><small>{reasoning.status === "running" ? "Live" : "Summary"}</small></summary>
              <div>{reasoning.content}</div>
            </details>
          )}
          <article className={clsx("message", `is-${message.role}`)} key={message.id}>
            <div className="message-meta">
              <span>{message.role === "assistant" ? "Inertia" : message.role === "system" ? "System" : "You"}</span>
              {showTimestamps && <time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>}
              {checkpoint && <button type="button" className="message-revert" title="Restore the project to before this turn" onClick={() => onRevertCheckpoint(checkpoint)}><RotateCcw size={11} />Revert</button>}
            </div>
            <div className="message-body">{message.content}</div>
            {message.attachments.length > 0 && (
              <div className="message-attachments">
                {message.attachments.map((attachment) => <span key={attachment.id}><Paperclip size={12} />{attachment.name}</span>)}
              </div>
            )}
          </article>
          </div>
          );
        })}
        {(activities.length > 0 || visibleStreamingText || streamingReasoning || approvals.length > 0 || inputRequests.length > 0) && (
          <section className="agent-run-card" aria-label="Agent activity">
            {showThinking && streamingReasoning && (
              <details className="thinking-summary is-live" open>
                <summary><BrainCircuit size={14} /><span>Thinking</span><small>Live</small></summary>
                <div>{streamingReasoning}<span className="streaming-caret" /></div>
              </details>
            )}
            {activities.map((activity) => (
              <div className={`agent-activity is-${activity.status}`} key={activity.id}>
                {activity.status === "failed" ? <TriangleAlert size={14} /> : activity.status === "completed" ? <CheckCircle2 size={14} /> : <CircleDot size={14} />}
                <span><strong>{activity.title}</strong>{activity.detail && <small>{activity.detail}</small>}</span>
              </div>
            ))}
            {visibleStreamingText && <div className="streaming-message"><span className="streaming-caret" />{visibleStreamingText}</div>}
            {approvals.map((request) => <ApprovalCard key={request.id} request={request} onRespond={onRespondToApproval} />)}
            {inputRequests.map((request) => <InputRequestCard key={request.id} request={request} onRespond={onRespondToInput} />)}
          </section>
        )}
        <div ref={endRef} />
      </div>

      <Composer
        conversation={conversation}
        providers={providers}
        actions={actions}
        mentionResults={mentionResults}
        usage={usage}
        showUsage={showUsage}
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
        onStop={onStop}
      />
    </main>
  );
}
