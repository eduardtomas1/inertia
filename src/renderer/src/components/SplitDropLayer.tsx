import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import {
  currentChatDrag,
  registerChatDropTarget,
  subscribeChatDrag,
} from "../utils/chatDrag";
import {
  splitDropRect,
  splitDropZone,
  type SplitDropZone,
} from "../utils/splitConversation";

interface SplitDropLayerProps {
  surfaceRef: RefObject<HTMLElement | null>;
  activeConversationId: string | null;
  splitConversationId: string | null;
  onDrop: ((conversationId: string, zone: SplitDropZone) => void) | null;
}

export function SplitDropLayer({
  surfaceRef,
  activeConversationId,
  splitConversationId,
  onDrop,
}: SplitDropLayerProps): React.JSX.Element | null {
  const drag = useSyncExternalStore(subscribeChatDrag, currentChatDrag);
  const stackedOnly = useMediaQuery("(max-width: 860px)");
  useNativePreviewSuspension(drag !== null);

  useEffect(() => {
    if (!onDrop) return;
    return registerChatDropTarget({
      resolve: (conversationId, x, y) => {
        const surface = surfaceRef.current;
        if (
          !surface
          || (conversationId === activeConversationId && !splitConversationId)
        ) {
          return null;
        }
        const hit = document.elementFromPoint(x, y);
        if (!hit || !surface.contains(hit)) return null;
        const rect = surface.getBoundingClientRect();
        const zone = splitDropZone(rect, x, y, stackedOnly);
        return zone ? { zone, ...splitDropRect(rect, zone) } : null;
      },
      drop: onDrop,
    });
  }, [activeConversationId, onDrop, splitConversationId, stackedOnly, surfaceRef]);

  if (!drag) return null;
  return createPortal(
    <>
      {drag.target && (
        <div
          className="split-drop-highlight"
          data-split-drop-zone={drag.target.zone}
          aria-hidden="true"
          style={{
            left: drag.target.left,
            top: drag.target.top,
            width: drag.target.width,
            height: drag.target.height,
          }}
        />
      )}
      <div
        className="chat-drag-chip"
        aria-hidden="true"
        style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 12}px)` }}
      >
        {drag.title}
      </div>
    </>,
    document.body,
  );
}
