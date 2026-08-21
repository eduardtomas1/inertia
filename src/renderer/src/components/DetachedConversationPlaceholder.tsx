import { ExternalLink, PictureInPicture2 } from "lucide-react";

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
      <span className="detached-conversation-symbol" aria-hidden="true">
        <PictureInPicture2 size={25} />
      </span>
      <span className="detached-conversation-eyebrow">
        {windowOpen ? "Chat window active" : "Chat window closed"}
      </span>
      <h2>{title}</h2>
      <p>
        {windowOpen
          ? "This chat has one interactive home in its own window. Its work continues independently of this workspace."
          : "Closing the window left this workspace unchanged. Any active work keeps running in the background. Open the chat here when you want to bring it back."}
      </p>
      <button type="button" className="secondary-button" onClick={onActivate}>
        <ExternalLink size={14} />
        <span>{windowOpen ? "Focus chat window" : "Open chat here"}</span>
      </button>
    </section>
  );
}
