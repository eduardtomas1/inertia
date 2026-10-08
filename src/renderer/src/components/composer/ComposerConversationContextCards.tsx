import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  AgentConversationContextRequest,
  ConversationContextPacket,
  ServerEvent,
} from "@shared/contracts";
import {
  isOwnConversationContext,
  type ConversationContextExcerpt,
  type ConversationContextOmissions,
} from "@shared/conversation-context";
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
      <p>“{source.conversationTitle}”</p>
      <p>From: {source.projectName} · {source.workspaceLabel}</p>
      <p>To: this chat · {source.targetWorkspaceLabel}</p>
      <p>Shares a size-limited copy with the agent. The original chat stays unchanged.</p>
      <footer>
        <button ref={cancel} type="button" className="secondary-button" onClick={() => onConfirm(false)}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => onConfirm(true)}>Share chat</button>
      </footer>
    </section>
  );
}

interface ContextPreviewContent {
  title: string;
  detail: string;
  excerpts: readonly ConversationContextExcerpt[];
  omissions?: ConversationContextOmissions;
}

function messageCount(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"}`;
}

function packetPreview(
  event: ServerEvent,
  packetId: string,
  targetConversationId: string,
): ContextPreviewContent | null {
  if (event.type !== "request.result" || event.result.kind !== "conversation.context.packet") return null;
  const packet = event.result.packet as ConversationContextPacket;
  if (packet.id !== packetId || packet.targetConversationId !== targetConversationId) return null;
  const own = isOwnConversationContext(packet);
  return {
    title: own ? "This chat" : packet.sourceConversationTitle,
    detail: `${own ? "Earlier messages" : packet.sourceProjectName} · ${messageCount(packet.messageCount)}${
      packet.droppedMessageCount > 0 ? ` · ${packet.droppedMessageCount} omitted` : ""}`,
    excerpts: packet.excerpts,
    omissions: packet.omissions,
  };
}

function sourcePreview(
  event: ServerEvent,
  sourceConversationId: string,
  targetConversationId: string,
): ContextPreviewContent | null {
  if (event.type !== "request.result" || event.result.kind !== "conversation.context.source") return null;
  const source = event.result.source;
  if (source.conversationId !== sourceConversationId || source.targetConversationId !== targetConversationId) return null;
  return {
    title: source.conversationTitle,
    detail: `${source.projectName} · ${messageCount(source.messages.length)}`,
    excerpts: source.messages,
  };
}

function ContextPreview({
  label,
  loadingText,
  load,
  revision,
  onDismiss,
}: {
  label: string;
  loadingText: string;
  load(): Promise<ContextPreviewContent | null>;
  revision?: string;
  onDismiss(): void;
}): React.JSX.Element {
  const [content, setContent] = useState<ContextPreviewContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const section = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);

  useLayoutEffect(() => {
    opener.current = document.activeElement;
    section.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    setContent(null);
    setError(null);
    void load().then((loaded) => {
      if (!active) return;
      if (loaded) setContent(loaded);
      else setError("This shared context is unavailable.");
    }).catch(() => {
      if (active) setError("Could not load shared context. Try again.");
    });
    return () => { active = false; };
  }, [load, revision, attempt]);

  const dismiss = (): void => {
    const previous = opener.current;
    onDismiss();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
  const gapAt = (index: number): React.JSX.Element | null => (
    content && (content.omissions?.earlierMessages ?? 0) > 0 && content.omissions!.gapIndex === index
      ? (
        <li data-role="gap">
          <small>
            {content.omissions!.earlierMessages} earlier{" "}
            {content.omissions!.earlierMessages === 1 ? "message" : "messages"} omitted
          </small>
        </li>
      )
      : null
  );
  return (
    <section ref={section} className="composer-context-preview" aria-label={label} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}>
      <button type="button" onClick={dismiss}>Close preview</button>
      {content
        ? (
          <>
            <header>
              <strong>{content.title}</strong>
              <small>{content.detail}</small>
              {(content.omissions?.intermediateAgentUpdates ?? 0) > 0 && (
                <small>
                  {content.omissions!.intermediateAgentUpdates} intermediate agent{" "}
                  {content.omissions!.intermediateAgentUpdates === 1 ? "update" : "updates"}
                  {" "}left out so more turns fit.
                </small>
              )}
            </header>
            <ol>
              {content.excerpts.map((excerpt, index) => (
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
              {gapAt(content.excerpts.length)}
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
          : <p role="status">{loadingText}</p>}
    </section>
  );
}

export function ConversationContextPreviewCard({
  packetId,
  targetConversationId,
  revision,
  onCommand,
  onDismiss,
}: {
  packetId: string;
  targetConversationId: string;
  revision?: string;
  onCommand: ConversationContextCommandRunner;
  onDismiss(): void;
}): React.JSX.Element {
  const load = useCallback(() => onCommand("conversation.context.load", {
    type: "conversation.context.load",
    payload: { packetId, targetConversationId },
  }).then((event) => packetPreview(event, packetId, targetConversationId)),
  [packetId, targetConversationId, onCommand]);
  return (
    <ContextPreview label="Shared chat context" loadingText="Loading the exact shared excerpt…"
      load={load} revision={revision} onDismiss={onDismiss} />
  );
}

function AgentSourcePreviewCard({
  request,
  sourceConversationId,
  onCommand,
  onDismiss,
}: {
  request: AgentConversationContextRequest;
  sourceConversationId: string;
  onCommand: ConversationContextCommandRunner;
  onDismiss(): void;
}): React.JSX.Element {
  const { requestId, targetConversationId } = request;
  const load = useCallback(() => onCommand("conversation.context.agent.source.load", {
    type: "conversation.context.agent.source.load",
    payload: { contextRequestId: requestId, sourceConversationId, targetConversationId },
  }).then((event) => sourcePreview(event, sourceConversationId, targetConversationId)),
  [requestId, sourceConversationId, targetConversationId, onCommand]);
  return (
    <ContextPreview label="Chat to share" loadingText="Loading the chat…"
      load={load} onDismiss={onDismiss} />
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
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    setSelected(preselected ?? "");
    setPending(false);
    setAcknowledgement(null);
    setError(null);
    setResponse(null);
    setPreviewing(false);
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
    <>
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
                  setPreviewing(false);
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
          {source && (
            <button type="button" aria-expanded={previewing} onClick={() => setPreviewing((open) => !open)}>
              Preview
            </button>
          )}
        </div>
      </section>
      {source && previewing && (
        <AgentSourcePreviewCard
          key={source.conversationId}
          request={request}
          sourceConversationId={source.conversationId}
          onCommand={onCommand}
          onDismiss={() => setPreviewing(false)}
        />
      )}
    </>
  );
}
