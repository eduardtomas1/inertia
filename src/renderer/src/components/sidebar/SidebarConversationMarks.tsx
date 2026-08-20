import { Columns2, PictureInPicture2, Pin } from "lucide-react";

export const EMPTY_DETACHED_CONVERSATION_IDS: ReadonlySet<string> = new Set();

interface SidebarConversationMarksProps {
  detached: boolean;
  pinned: boolean;
  split: boolean;
}

export function SidebarConversationMarks({
  detached,
  pinned,
  split,
}: SidebarConversationMarksProps): React.JSX.Element {
  return (
    <>
      {pinned ? (
        <Pin className="conversation-pin" size={10} aria-label="Pinned thread" />
      ) : null}
      {detached ? (
        <PictureInPicture2
          className="conversation-detached-mark"
          size={11}
          aria-label="Open in a separate chat window"
        />
      ) : null}
      {split ? (
        <Columns2
          className="conversation-split-mark"
          size={11}
          aria-label="Open in split view"
        />
      ) : null}
    </>
  );
}
