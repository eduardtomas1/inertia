import { PRIVATE_CONNECT_LIMITS } from "../../../../shared/private-connect/protocol";
import { QuestionForm } from "../components/QuestionForm";
import type { Detail, Shell } from "../types";
import { ActivitySummary } from "./ActivitySummary";
import { QueueSection, type PrivateConnectQueueProjection } from "./QueueSection";

const FOLLOW_LATEST_THRESHOLD_PX = 80;

export type ConversationDetailWithQueue = Detail & {
  queue?: PrivateConnectQueueProjection;
};

export function ConversationPane({
  shell,
  detail,
  prompt,
  busy,
  offline,
  messagesRef,
  onScrollIntent,
  onPromptChange,
  onSendPrompt,
  onAnswer,
  onStopRun,
  onSendQueueItem,
  onEditQueueItem,
  onRemoveQueueItem,
  onResumeQueue,
}: {
  shell: Shell | null;
  detail: ConversationDetailWithQueue | null;
  prompt: string;
  busy: boolean;
  offline: boolean;
  messagesRef: React.RefObject<HTMLDivElement | null>;
  onScrollIntent: (followLatest: boolean) => void;
  onPromptChange: (value: string) => void;
  onSendPrompt: () => void;
  onAnswer: (answers: Record<string, string[]>) => void;
  onStopRun: () => void;
  onSendQueueItem?: (id: string) => Promise<void> | void;
  onEditQueueItem?: (id: string, expectedRevision: number, content: string) => Promise<boolean | void> | void;
  onRemoveQueueItem?: (id: string) => Promise<void> | void;
  onResumeQueue?: () => Promise<void> | void;
}): React.JSX.Element {
  const scopes = shell?.capabilities.scopes ?? [];
  const canPrompt = scopes.includes("private:prompt");
  const isRunning = detail?.conversation.status === "running";
  return (
    <section className="conversation-pane">
      {detail ? (
        <>
          <div className="conversation-heading">
            <div>
              <span className="eyebrow">{detail.conversation.providerLabel}</span>
              <h2>{detail.conversation.title}</h2>
            </div>
            {scopes.includes("private:stop") && detail.conversation.runId && (
              <button type="button" disabled={busy || offline} onClick={onStopRun}>Stop run</button>
            )}
          </div>
          <div
            className="messages"
            ref={messagesRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              onScrollIntent(
                element.scrollHeight - element.scrollTop - element.clientHeight
                  < FOLLOW_LATEST_THRESHOLD_PX,
              );
            }}
          >
            {detail.messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <span className="role">{message.role === "assistant" ? "Inertia" : "You"}</span>
                <p>{message.content}</p>
              </article>
            ))}
          </div>
          <ActivitySummary detail={detail} />
          {detail.queue && detail.queue.items.length > 0 && (
            <QueueSection
              queue={detail.queue}
              canMutate={canPrompt}
              hasPendingQuestions={detail.questions.length > 0}
              waitingForLocalAction={detail.waitingForLocalAction}
              busy={busy}
              offline={offline}
              onSendItem={onSendQueueItem}
              onEditItem={onEditQueueItem}
              onRemoveItem={onRemoveQueueItem}
              onResume={onResumeQueue}
            />
          )}
          {detail.questions.length > 0 && detail.inputRequestId && scopes.includes("private:input") && (
            <QuestionForm
              key={detail.inputRequestId}
              questions={detail.questions}
              busy={busy || offline}
              onAnswer={onAnswer}
            />
          )}
          {detail.waitingForLocalAction && (
            <div className="banner" role="status">This conversation needs an action on the desktop. Secrets and approvals stay local.</div>
          )}
          {canPrompt && (
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                onSendPrompt();
              }}
            >
              <textarea
                aria-label="Send a prompt"
                maxLength={PRIVATE_CONNECT_LIMITS.promptCharacters}
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                placeholder={isRunning ? "Queue a follow-up prompt" : "Send a supervised prompt"}
                disabled={busy || offline}
              />
              <button type="submit" disabled={busy || offline || !prompt.trim()}>Send</button>
            </form>
          )}
        </>
      ) : (
        <div className="empty">
          <h2>Choose a conversation</h2>
          <p>Only projects and conversations granted by the desktop appear here.</p>
        </div>
      )}
    </section>
  );
}
