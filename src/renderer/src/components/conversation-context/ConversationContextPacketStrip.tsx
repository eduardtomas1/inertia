import { MessagesSquare, X } from "lucide-react";
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
    <div className="p-s" aria-label="Selected chat context">
      {packets.map((packet) => (
        <article
          key={packet.id}
          className="p-c"
          data-workspace-relation={packet.workspaceRelation}
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
              <strong>From {packet.sourceConversationTitle}</strong>
              <small>
                {packet.sourceProjectName} · {packet.messageCount}{" "}
                {packet.messageCount === 1 ? "message" : "messages"}
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
            aria-label={`Remove context from ${packet.sourceConversationTitle}`}
            disabled={disabled}
            onClick={() => onRemove(packet.id)}
          >
            <X size={12} />
          </button>
        </article>
      ))}
    </div>
  );
}
