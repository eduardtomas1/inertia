import type { Detail, Shell } from "../types";
import { ConversationPane } from "./ConversationPane";
import { ProjectList } from "./ProjectList";

export function WorkspaceShell({
  shell,
  detail,
  error,
  prompt,
  busy,
  offline,
  selectedConversation,
  messagesRef,
  onSelectConversation,
  onScrollIntent,
  onPromptChange,
  onSendPrompt,
  onAnswer,
  onStopRun,
  onSignOut,
}: {
  shell: Shell | null;
  detail: Detail | null;
  error: string | null;
  prompt: string;
  busy: boolean;
  offline: boolean;
  selectedConversation: string | null;
  messagesRef: React.RefObject<HTMLDivElement | null>;
  onSelectConversation: (conversationId: string) => void;
  onScrollIntent: (followLatest: boolean) => void;
  onPromptChange: (value: string) => void;
  onSendPrompt: () => void;
  onAnswer: (answers: Record<string, string[]>) => void;
  onStopRun: () => void;
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <main className="shell">
      <header>
        <div>
          <span className="eyebrow">Inertia Private Connect</span>
          <h1>Your workspace</h1>
        </div>
        <button type="button" disabled={offline} onClick={onSignOut}>Sign out</button>
      </header>
      {offline && (
        <div className="banner" role="status">
          Offline — showing only data already held in this tab. Conversations and API responses are not stored for offline use.
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      <div className="layout">
        <ProjectList
          shell={shell}
          selectedConversation={selectedConversation}
          onSelect={onSelectConversation}
        />
        <ConversationPane
          shell={shell}
          detail={detail}
          prompt={prompt}
          busy={busy}
          offline={offline}
          messagesRef={messagesRef}
          onScrollIntent={onScrollIntent}
          onPromptChange={onPromptChange}
          onSendPrompt={onSendPrompt}
          onAnswer={onAnswer}
          onStopRun={onStopRun}
        />
      </div>
    </main>
  );
}
