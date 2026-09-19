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
  onDismiss,
}: {
  packetId: string;
  targetConversationId: string;
  onCommand: ConversationContextCommandRunner;
  onDismiss(): void;
}): React.JSX.Element {
  const [packet, setPacket] = useState<ConversationContextPacket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setPacket(null);
    setError(null);
    void onCommand("conversation.context.load", {
      type: "conversation.context.load",
      payload: { packetId, targetConversationId },
    }).then((event) => {
      if (!active) return;
      const loaded = packetFromEvent(event);
      if (loaded?.id !== packetId || loaded.targetConversationId !== targetConversationId) {
        setError("This shared context is unavailable.");
      } else {
        setPacket(loaded);
      }
    }).catch(() => {
      if (active) setError("Could not load shared context. Try again.");
    });
    return () => { active = false; };
  }, [packetId, targetConversationId, onCommand, attempt]);

  return (
    <section className="composer-context-preview" aria-label="Shared chat context">
      <button type="button" onClick={onDismiss}>Close preview</button>
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
                  {excerpt.truncated && <small>Message shortened to fit the shared context.</small>}
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
        : error
          ? (
            <>
              <p role="alert">{error}</p>
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                Retry preview
              </button>
            </>
          )
          : <p role="status">Loading the exact shared excerpt…</p>}
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
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);

  useEffect(() => {
    setSelected(preselected ?? "");
    setPending(false);
    setAcknowledgement(null);
    setError(null);
    setResponse(null);
  }, [preselected, request.requestId]);

  const choice = selected || preselected || "";
  const source = sources.find(
    ({ conversationId }) => conversationId === choice,
  ) ?? null;
  const differentWorkspace = source?.workspaceRelation === "different-workspace";
  const acknowledgementKey = source
    ? JSON.stringify([request.requestId, source.conversationId, source.workspaceLabel, source.targetWorkspaceLabel])
    : null;
  const acknowledged = acknowledgementKey !== null && acknowledgement === acknowledgementKey;

  const respond = (share: boolean): void => {
    if (pending || response) return;
    if (share && (!source || (differentWorkspace && !acknowledged))) return;
    setPending(true);
    setError(null);
    const command = share && source
      ? {
          type: "conversation.context.agent.respond" as const,
          payload: {
            decision: "select" as const,
            contextRequestId: request.requestId,
            sourceConversationId: source.conversationId,
            targetConversationId: request.targetConversationId,
            acknowledgedWorkspaceDifference: differentWorkspace && acknowledged,
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
      .then((event) => {
        if (event.type !== "request.ok") throw new Error("Context response was not accepted.");
        setResponse(share ? "Sharing approved." : "Request declined.");
      })
      .catch(() => setError(share ? "Could not share this chat. Try again." : "Could not decline this request. Try again."))
      .finally(() => setPending(false));
  };

  return (
    <section
      className="composer-context-request"
      aria-label="Agent requested chat context"
    >
      <header>
        <strong>The agent asked to read another chat</strong>
        <small>It receives a size-limited, redacted copy of the chat only if you share it. Older messages and long text may be shortened.</small>
      </header>
      {preselected
        ? <p>{source?.conversationTitle ?? "That chat is unavailable."}</p>
        : (
          <label>
            <span>Chat to share</span>
            <select
              value={choice}
              disabled={pending || response !== null}
              onChange={(event) => {
                setSelected(event.target.value);
                setAcknowledgement(null);
                setError(null);
              }}
            >
              <option value="">Choose a chat…</option>
              {sources.map((option) => (
                <option key={option.conversationId} value={option.conversationId}>
                  {option.conversationTitle}
                  {` · ${option.projectName} · ${option.workspaceLabel}`}
                  {option.workspaceRelation === "different-workspace"
                    ? " · different workspace"
                    : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      {source && (
        <p>
          From {source.projectName} · {source.workspaceLabel}<br />
          To this chat · {source.targetWorkspaceLabel}
        </p>
      )}
      {differentWorkspace && (
        <label>
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={pending || response !== null}
            onChange={(event) => setAcknowledgement(event.target.checked ? acknowledgementKey : null)}
          />
          Share context across these different workspaces
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      {response && <p role="status">{response}</p>}
      <div>
        <button
          type="button"
          disabled={pending || response !== null || !source || (differentWorkspace && !acknowledged)}
          onClick={() => respond(true)}
        >
          Share chat
        </button>
        <button type="button" disabled={pending || response !== null} onClick={() => respond(false)}>
          Decline
        </button>
      </div>
    </section>
  );
}
