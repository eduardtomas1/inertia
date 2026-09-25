import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  AgentConversationContextRequest,
  ConversationContextPacket,
  ServerEvent,
} from "@shared/contracts";
import { isOwnConversationContext } from "@shared/conversation-context";
import type {
  ConversationContextCommandRunner,
  ConversationContextSourceOption,
} from "../conversation-context/types";

export function ChatReferenceConfirmation({ source, onConfirm }: {
  source: ConversationContextSourceOption;
  onConfirm(accepted: boolean): void;
}): React.JSX.Element {
  const titleId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { cancel.current?.focus(); }, []);
  return (
    <section className="composer-context-request composer-context-confirmation" role="alertdialog"
      aria-labelledby={titleId} onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onConfirm(false);
      }}>
      <strong id={titleId}>Share context from another workspace?</strong>
      <p>“{source.conversationTitle}” in {source.projectName}</p>
      <p>From: {source.workspaceLabel}</p>
      <p>To: {source.targetWorkspaceLabel}</p>
      <p>Shares a size-limited copy with the agent. The original chat stays unchanged.</p>
      <footer>
        <button ref={cancel} type="button" className="secondary-button" onClick={() => onConfirm(false)}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => onConfirm(true)}>Share chat</button>
      </footer>
    </section>
  );
}

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

  const gapAt = (index: number): React.JSX.Element | null => (
    packet && (packet.omissions?.earlierMessages ?? 0) > 0 && packet.omissions!.gapIndex === index
      ? (
        <li data-role="gap">
          <small>
            {packet.omissions!.earlierMessages} earlier{" "}
            {packet.omissions!.earlierMessages === 1 ? "message" : "messages"} omitted
          </small>
        </li>
      )
      : null
  );
  return (
    <section className="composer-context-preview" aria-label="Shared chat context">
      <button type="button" onClick={onDismiss}>Close preview</button>
      {packet
        ? (
          <>
            <header>
              <strong>
                {isOwnConversationContext(packet) ? "This chat" : packet.sourceConversationTitle}
              </strong>
              <small>
                {isOwnConversationContext(packet) ? "Earlier messages" : packet.sourceProjectName}
                {" · "}{packet.messageCount}{" "}
                {packet.messageCount === 1 ? "message" : "messages"}
                {packet.droppedMessageCount > 0
                  ? ` · ${packet.droppedMessageCount} omitted`
                  : ""}
              </small>
              {(packet.omissions?.intermediateAgentUpdates ?? 0) > 0 && (
                <small>
                  {packet.omissions!.intermediateAgentUpdates} intermediate agent{" "}
                  {packet.omissions!.intermediateAgentUpdates === 1 ? "update" : "updates"}
                  {" "}left out so more turns fit.
                </small>
              )}
            </header>
            <ol>
              {packet.excerpts.map((excerpt, index) => (
                <Fragment key={excerpt.sourceMessageId}>
                  {gapAt(index)}
                  <li data-role={excerpt.role}>
                    <span>{excerpt.role === "user" ? "You" : "Agent"}</span>
                    <p>{excerpt.content}</p>
                    {excerpt.truncated && <small>Message shortened to fit the shared context.</small>}
                    {excerpt.attachments && excerpt.attachments.length > 0 && (
                      <small>
                        {excerpt.attachments.map(({ name }) => name).join(", ")}
                      </small>
                    )}
                  </li>
                </Fragment>
              ))}
              {gapAt(packet.excerpts.length)}
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
