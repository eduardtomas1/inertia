import { ExternalLink } from "lucide-react";

export interface DetachedConversationPlaceholderProps {
  title: string;
  windowOpen: boolean;
  onActivate: () => void;
}

export function DetachedConversationPlaceholder({
  title,
  windowOpen,
  onActivate,
}: DetachedConversationPlaceholderProps): React.JSX.Element {
  return (
    <section
      className="chat-workspace centered-state detached-conversation-placeholder"
      aria-label={`Detached chat: ${title}`}
    >
      <h2>{windowOpen ? "Chat window active" : "Chat window closed"}</h2>
      <button type="button" className="secondary-button" onClick={onActivate}>
        <ExternalLink size={14} />
        <span>{windowOpen ? "Focus chat window" : "Open chat here"}</span>
      </button>
    </section>
  );
}
