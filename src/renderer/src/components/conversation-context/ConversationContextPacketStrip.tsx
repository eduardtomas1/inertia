import { ArrowUpRight, MessagesSquare, Trash2 } from "lucide-react";
import type { ConversationContextPacketSummary } from "@shared/contracts";
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
    <div className="conversation-context-strip" aria-label="Selected chat context">
      {packets.map((packet) => (
        <article
          key={packet.id}
          className="conversation-context-card"
          data-workspace-relation={packet.workspaceRelation}
        >
          <span className="conversation-context-card-mark" aria-hidden="true">
            <MessagesSquare size={14} />
          </span>
          <button
            type="button"
            className="conversation-context-card-open"
            onClick={() => onPreview(packet.id)}
          >
            <span>
              <strong>From {packet.sourceConversationTitle}</strong>
              <small>
                {packet.sourceProjectName} · {packet.messageCount}{" "}
                {packet.messageCount === 1 ? "message" : "messages"}
                {packet.workspaceRelation === "different-workspace"
                  ? " · different workspace"
                  : ""}
              </small>
            </span>
            <ArrowUpRight size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="conversation-context-card-remove"
            aria-label={`Remove context from ${packet.sourceConversationTitle}`}
            disabled={disabled}
            onClick={() => onRemove(packet.id)}
          >
            <Trash2 size={12} />
          </button>
        </article>
      ))}
    </div>
  );
}
