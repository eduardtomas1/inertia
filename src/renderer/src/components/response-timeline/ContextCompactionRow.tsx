import { Minimize2 } from "lucide-react";
import type { ChatMessage } from "@shared/contracts";
import { contextCompactionLabel } from "@shared/context-compaction";
import "./ContextCompactionRow.css";

export function ContextCompactionRow({ message }: { message: ChatMessage }): React.JSX.Element | null {
  if (!message.compaction) return null;
  const label = contextCompactionLabel(message.compaction);
  return (
    <section className="context-compaction-row" data-response-row-id={message.id} tabIndex={-1} aria-label={label}>
      <article className="message is-user turn-user-request">
        <div className="message-body">{message.content}</div>
      </article>
      <div className="context-compaction-separator" role="separator" aria-label={label}>
        <span aria-hidden="true" />
        <small><Minimize2 size={12} aria-hidden="true" />{label}</small>
        <span aria-hidden="true" />
      </div>
    </section>
  );
}
