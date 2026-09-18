import { useEffect, useState } from "react";
import type {
  AgentConversationContextRequest,
  ConversationContextPacket,
  ServerEvent,
} from "@shared/contracts";
import type {
  ConversationContextCommandRunner,
  ConversationContextSourceOption,
} from "../conversation-context/types";

function packetFromEvent(event: ServerEvent): ConversationContextPacket | null {
  if (event.type !== "request.result") return null;
  const result = event.result as {
    kind?: string;
    packet?: ConversationContextPacket;
  };
  return result.kind === "conversation.context.packet" && result.packet
    ? result.packet
    : null;
}

export function ConversationContextPreviewCard({
  packetId,
  targetConversationId,
  onCommand,
}: {
  packetId: string;
  targetConversationId: string;
  onCommand: ConversationContextCommandRunner;
}): React.JSX.Element {
  const [packet, setPacket] = useState<ConversationContextPacket | null>(null);

  useEffect(() => {
    let active = true;
    setPacket(null);
    void onCommand("conversation.context.load", {
      type: "conversation.context.load",
      payload: { packetId, targetConversationId },
    }).then((event) => {
      if (active) setPacket(packetFromEvent(event));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [packetId, targetConversationId, onCommand]);

  return (
    <section className="composer-context-preview" aria-label="Shared chat context">
      {packet
        ? (
          <>
            <header>
              <strong>{packet.sourceConversationTitle}</strong>
              <small>
                {packet.sourceProjectName} · {packet.messageCount}{" "}
                {packet.messageCount === 1 ? "message" : "messages"}
                {packet.droppedMessageCount > 0
                  ? ` · ${packet.droppedMessageCount} oldest omitted`
                  : ""}
              </small>
            </header>
            <ol>
              {packet.excerpts.map((excerpt) => (
                <li key={excerpt.sourceMessageId} data-role={excerpt.role}>
                  <span>{excerpt.role === "user" ? "You" : "Agent"}</span>
                  <p>{excerpt.content}</p>
                  {excerpt.attachments && excerpt.attachments.length > 0 && (
                    <small>
                      {excerpt.attachments.map(({ name }) => name).join(", ")}
                    </small>
                  )}
                </li>
              ))}
            </ol>
          </>
        )
        : <p>Loading the exact shared excerpt…</p>}
    </section>
  );
}

export function ConversationContextRequestCard({
  request,
  sources,
  onCommand,
}: {
  request: AgentConversationContextRequest;
  sources: readonly ConversationContextSourceOption[];
  onCommand: ConversationContextCommandRunner;
}): React.JSX.Element {
  const preselected = request.requestedSourceConversationId;
  const [selected, setSelected] = useState<string>("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setSelected(preselected ?? "");
    setPending(false);
  }, [preselected, request.requestId]);

  const choice = selected || preselected || "";
  const source = sources.find(
    ({ conversationId }) => conversationId === choice,
  ) ?? null;

  const respond = (share: boolean): void => {
    if (pending) return;
    if (share && !source) return;
    setPending(true);
    const command = share && source
      ? {
          type: "conversation.context.agent.respond" as const,
          payload: {
            decision: "select" as const,
            contextRequestId: request.requestId,
            sourceConversationId: source.conversationId,
            targetConversationId: request.targetConversationId,
            acknowledgedWorkspaceDifference:
              source.workspaceRelation === "different-workspace",
          },
        }
      : {
          type: "conversation.context.agent.respond" as const,
          payload: {
            decision: "cancel" as const,
            contextRequestId: request.requestId,
            targetConversationId: request.targetConversationId,
          },
        };
    void onCommand("conversation.context.agent.respond", command)
      .catch(() => undefined)
      .finally(() => setPending(false));
  };

  return (
    <section
      className="composer-context-request"
      aria-label="Agent requested chat context"
    >
      <header>
        <strong>The agent asked to read another chat</strong>
        <small>It receives the whole chat, redacted, only if you share it.</small>
      </header>
      {preselected
        ? <p>{source?.conversationTitle ?? "That chat is unavailable."}</p>
        : (
          <label>
            <span>Chat to share</span>
            <select
              value={choice}
              disabled={pending}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">Choose a chat…</option>
              {sources.map((option) => (
                <option key={option.conversationId} value={option.conversationId}>
                  {option.conversationTitle}
                  {option.workspaceRelation === "different-workspace"
                    ? " · different workspace"
                    : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      <div>
        <button
          type="button"
          disabled={pending || !source}
          onClick={() => respond(true)}
        >
          Share whole chat
        </button>
        <button type="button" disabled={pending} onClick={() => respond(false)}>
          Decline
        </button>
      </div>
    </section>
  );
}
