import { MessagesSquare, X } from "lucide-react";
import type { ConversationContextPacketSummary } from "@shared/contracts";
import { isOwnConversationContext } from "@shared/conversation-context";
import "./ConversationContextPacketStrip.css";

export function ConversationContextPacketStrip({
  packets,
  disabled,
  onPreview,
  onRemove,
}: {
  packets: readonly ConversationContextPacketSummary[];
  disabled: boolean;
  onPreview: (packetId: string) => void;
  onRemove: (packetId: string) => void;
}): React.JSX.Element | null {
  if (packets.length === 0) return null;
  return (
    <div className="p-s" aria-label="Chat context">
      {packets.map((packet) => {
        const own = isOwnConversationContext(packet);
        return (
          <article
            key={packet.id}
            className="p-c"
            data-workspace-relation={packet.workspaceRelation}
            data-reference={own ? "this-chat" : "another-chat"}
          >
            <span className="p-m" aria-hidden="true">
              <MessagesSquare size={14} />
            </span>
            <button
              type="button"
              className="p-o"
              onClick={() => onPreview(packet.id)}
            >
              <span>
                <strong>{own ? "This chat" : `From ${packet.sourceConversationTitle}`}</strong>
                <small>
                  {own ? "Earlier messages" : packet.sourceProjectName} · {packet.messageCount}{" "}
                  {packet.messageCount === 1 ? "message" : "messages"}
                  {packet.droppedMessageCount > 0
                    ? ` · ${packet.droppedMessageCount} omitted`
                    : ""}
                  {packet.workspaceRelation === "different-workspace"
                    ? " · different workspace"
                    : ""}
                </small>
              </span>
              <span aria-hidden="true">↗</span>
            </button>
            <button
              type="button"
              className="p-r"
              aria-label={own
                ? "Remove this chat's earlier messages"
                : `Remove context from ${packet.sourceConversationTitle}`}
              disabled={disabled}
              onClick={() => onRemove(packet.id)}
            >
              <X size={12} />
            </button>
          </article>
        );
      })}
    </div>
  );
}
