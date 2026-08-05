import { QuestionForm } from "../components/QuestionForm";
import type { Detail, Shell } from "../types";
import { ActivitySummary } from "./ActivitySummary";

const FOLLOW_LATEST_THRESHOLD_PX = 80;

export function ConversationPane({
  shell,
  detail,
  prompt,
  busy,
  messagesRef,
  onScrollIntent,
  onPromptChange,
  onSendPrompt,
  onAnswer,
  onStopRun,
}: {
  shell: Shell | null;
  detail: Detail | null;
  prompt: string;
  busy: boolean;
  messagesRef: React.RefObject<HTMLDivElement | null>;
  onScrollIntent: (followLatest: boolean) => void;
  onPromptChange: (value: string) => void;
  onSendPrompt: () => void;
  onAnswer: (answers: Record<string, string[]>) => void;
  onStopRun: () => void;
}): React.JSX.Element {
  const scopes = shell?.capabilities.scopes ?? [];
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
              <button type="button" onClick={onStopRun}>Stop run</button>
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
          {detail.questions.length > 0 && detail.inputRequestId && scopes.includes("private:input") && (
            <QuestionForm
              key={detail.inputRequestId}
              questions={detail.questions}
              busy={busy}
              onAnswer={onAnswer}
            />
          )}
          {detail.waitingForLocalAction && (
            <div className="banner">This conversation needs an action on the desktop. Secrets and approvals stay local.</div>
          )}
          {scopes.includes("private:prompt") && (
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                onSendPrompt();
              }}
            >
              <textarea
                aria-label="Send a prompt"
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                placeholder="Send a supervised prompt"
                disabled={busy}
              />
              <button type="submit" disabled={busy || !prompt.trim()}>Send</button>
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
