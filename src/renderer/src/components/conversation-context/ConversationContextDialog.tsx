import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  MessagesSquare,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  AgentConversationContextRequest,
  ConversationContextExcerpt,
  ConversationContextPacket,
  ConversationContextSourceTranscript,
  ServerEvent,
} from "@shared/contracts";
import {
  MAX_CONVERSATION_CONTEXT_MESSAGES,
  MAX_CONVERSATION_CONTEXT_NOTE_BYTES,
  MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
  MAX_CONVERSATION_CONTEXT_TOTAL_BYTES,
} from "@shared/conversation-context";
import { resultEvent } from "../../lib/runtimeCommands";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import type {
  ConversationContextCommandRunner,
  ConversationContextSourceOption,
} from "./types";
import "./ConversationContextDialog.css";

const INVALID_CONTEXT_RESPONSE = "Invalid context.";
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : "Context unavailable.";
}

function packetResult(event: ServerEvent): ConversationContextPacket {
  const result = resultEvent(event).result;
  if (result.kind !== "conversation.context.packet") {
    throw new Error(INVALID_CONTEXT_RESPONSE);
  }
  return result.packet;
}

function Detail({ title, detail }: {
  title: React.ReactNode;
  detail: React.ReactNode;
}): React.JSX.Element {
  return <span><strong>{title}</strong><small>{detail}</small></span>;
}

function selectedPreview(
  messages: readonly ConversationContextExcerpt[],
  selectedIds: ReadonlySet<string>,
): ConversationContextExcerpt[] {
  const selected = messages.filter(({ sourceMessageId }) =>
    selectedIds.has(sourceMessageId));
  const budget = Math.min(
    MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
    Math.floor(MAX_CONVERSATION_CONTEXT_TOTAL_BYTES / Math.max(selected.length, 1)),
  );
  return selected.map((message) => {
    const encoded = UTF8_ENCODER.encode(message.content);
    if (encoded.byteLength <= budget) return message;
    let end = budget;
    while ((encoded[end]! & 0xc0) === 0x80) end -= 1;
    return {
      ...message,
      content: UTF8_DECODER.decode(encoded.subarray(0, end)),
      truncated: true,
    };
  });
}

function ExcerptList({
  excerpts,
  selectable = false,
  selectedIds,
  onToggle,
}: {
  excerpts: readonly ConversationContextExcerpt[];
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggle?: (messageId: string) => void;
}): React.JSX.Element {
  return (
    <div className="c-xl">
      {excerpts.map((excerpt) => {
        const selected = selectedIds?.has(excerpt.sourceMessageId) ?? false;
        const copy = (
          <>
            <span className="c-xm">
              <strong>{excerpt.role === "user" ? "You" : "Agent"}</strong>
              {excerpt.truncated && <em>bounded excerpt</em>}
            </span>
            <span className="c-xc">{excerpt.content}</span>
          </>
        );
        return selectable ? (
          <button
            type="button"
            key={excerpt.sourceMessageId}
            className="c-x is-selectable"
            aria-pressed={selected}
            onClick={() => onToggle?.(excerpt.sourceMessageId)}
          >
            <span className="c-xk" aria-hidden="true">
              {selected ? "✓" : null}
            </span>
            <span>{copy}</span>
          </button>
        ) : (
          <article className="c-x" key={excerpt.sourceMessageId}>
            {copy}
          </article>
        );
      })}
    </div>
  );
}

function PacketPreview({ packet }: {
  packet: ConversationContextPacket;
}): React.JSX.Element {
  return (
    <div className="c-pp">
      <div className="c-pr">
        <Detail title={packet.sourceConversationTitle} detail={packet.sourceProjectName} />
        <Detail
          title={packet.sourceWorkspaceLabel}
          detail={`Captured ${new Date(packet.createdAt).toLocaleString()}`}
        />
      </div>
      {packet.sourceState === "deleted" && (
        <p className="c-wr" role="status">
          Source deleted · immutable sent excerpt.
        </p>
      )}
      {packet.workspaceRelation === "different-workspace" && (
        <p className="c-bd">
          <ShieldCheck size={14} /> Different project or worktree.
        </p>
      )}
      {packet.note && <blockquote>{packet.note}</blockquote>}
      <ExcerptList excerpts={packet.excerpts} />
    </div>
  );
}

export function ConversationContextDialog({
  targetConversationId,
  sources,
  previewPacketId = null,
  agentRequest = null,
  onCommand,
  onClose,
}: {
  targetConversationId: string;
  sources: readonly ConversationContextSourceOption[];
  previewPacketId?: string | null;
  agentRequest?: AgentConversationContextRequest | null;
  onCommand: ConversationContextCommandRunner;
  onClose: () => void;
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const lockedSourceId = agentRequest?.requestedSourceConversationId ?? null;
  const [sourceId, setSourceId] = useState<string | null>(
    lockedSourceId ?? sources[0]?.conversationId ?? null,
  );
  const [sourceQuery, setSourceQuery] = useState("");
  const deferredSourceQuery = useDeferredValue(sourceQuery.trim().toLocaleLowerCase());
  const [source, setSource] = useState<ConversationContextSourceTranscript | null>(null);
  const [packet, setPacket] = useState<ConversationContextPacket | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedSource = sources.find(({ conversationId }) =>
    conversationId === sourceId) ?? null;
  const matchingSources = useMemo(() => sources.filter((option) => (
    (!lockedSourceId || option.conversationId === lockedSourceId)
    && (
    !deferredSourceQuery
    || `${option.conversationTitle}\n${option.projectName}`
      .toLocaleLowerCase()
      .includes(deferredSourceQuery)
    )
  )), [deferredSourceQuery, lockedSourceId, sources]);
  const visibleSources = matchingSources.slice(0, 100);
  const previewExcerpts = useMemo(() => selectedPreview(
    source?.messages ?? [],
    selectedIds,
  ), [selectedIds, source]);
  const noteBytes = UTF8_ENCODER.encode(note.trim()).byteLength;
  const differentWorkspace = (
    source?.workspaceRelation ?? selectedSource?.workspaceRelation
  ) === "different-workspace";

  useEffect(() => {
    const restoreFocus = captureModalFocus(false);
    closeRef.current?.focus();
    return restoreFocus;
  }, []);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void closeDialog();
      return;
    }
    trapModalFocus(event, event.currentTarget);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPacket(null);
    setSource(null);
    setSelectedIds(new Set());
    setAcknowledged(false);
    const load = async (): Promise<void> => {
      try {
        if (previewPacketId) {
          const packet = packetResult(await onCommand("conversation.context.load", {
            type: "conversation.context.load",
            payload: { packetId: previewPacketId, targetConversationId },
          }));
          if (!cancelled) setPacket(packet);
          return;
        }
        if (!sourceId) return;
        const payload = { sourceConversationId: sourceId, targetConversationId };
        const event = agentRequest
          ? await onCommand("conversation.context.agent.source.load", {
            type: "conversation.context.agent.source.load",
            payload: { contextRequestId: agentRequest.requestId, ...payload },
          })
          : await onCommand("conversation.context.source.load", {
            type: "conversation.context.source.load",
            payload,
          });
        const result = resultEvent(event).result;
        if (
          result.kind !== "conversation.context.source"
          || result.source.targetConversationId !== targetConversationId
        ) {
          throw new Error(INVALID_CONTEXT_RESPONSE);
        }
        if (!cancelled) setSource(result.source);
      } catch (failure) {
        if (!cancelled) setError(failureMessage(failure));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [agentRequest, onCommand, previewPacketId, sourceId, targetConversationId]);

  const toggleMessage = (messageId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else if (next.size < MAX_CONVERSATION_CONTEXT_MESSAGES) next.add(messageId);
      return next;
    });
  };
  const createPacket = async (): Promise<void> => {
    if (
      !sourceId
      || selectedIds.size === 0
      || noteBytes > MAX_CONVERSATION_CONTEXT_NOTE_BYTES
    ) return;
    setSaving(true);
    setError(null);
    let agentSelectionSubmitted = false;
    try {
      const selection = {
        sourceConversationId: sourceId,
        targetConversationId,
        sourceMessageIds: [...selectedIds],
        ...(note.trim() ? { note: note.trim() } : {}),
        acknowledgedWorkspaceDifference: acknowledged,
      };
      if (agentRequest) {
        await onCommand("conversation.context.agent.respond", {
          type: "conversation.context.agent.respond",
          payload: {
            decision: "select",
            contextRequestId: agentRequest.requestId,
            ...selection,
          },
        });
        agentSelectionSubmitted = true;
        return;
      }
      packetResult(await onCommand("conversation.context.create", {
        type: "conversation.context.create",
        payload: selection,
      }));
      onClose();
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      if (!agentSelectionSubmitted) setSaving(false);
    }
  };

  const closeDialog = async (): Promise<void> => {
    if (saving) return;
    if (!agentRequest) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCommand("conversation.context.agent.respond", {
        type: "conversation.context.agent.respond",
        payload: {
          decision: "cancel",
          contextRequestId: agentRequest.requestId,
          targetConversationId,
        },
      });
    } catch (failure) {
      setError(failureMessage(failure));
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="c-b"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void closeDialog();
      }}
    >
      <section
        className="c-d"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleDialogKeyDown}
      >
        <header>
          <span className="c-h" aria-hidden="true">
            <MessagesSquare size={18} />
          </span>
          <span>
            <strong id={titleId}>
              {previewPacketId
                ? "Shared chat context"
                : agentRequest
                  ? "Agent requested chat context"
                  : "Bring context from another chat"}
            </strong>
            <small>{previewPacketId
              ? "Exact bounded excerpt attached"
              : agentRequest
                ? "Choose exactly what this agent receives"
                : "Choose what this agent receives"}</small>
          </span>
          <button ref={closeRef} type="button" aria-label="Close chat context" onClick={() => void closeDialog()}>
            <X size={16} />
          </button>
        </header>

        {previewPacketId ? (
          <div className="c-pb">
            {loading ? <p className="c-st">Loading shared context…</p>
              : packet ? <PacketPreview packet={packet} />
                : <p className="c-st is-error">{error ?? "Context unavailable."}</p>}
          </div>
        ) : (
          <div
            className="c-w"
            data-source-selected={sourceId ? "true" : "false"}
          >
            <aside aria-label="Source chats">
              <div className="c-l">Source chat</div>
              {!lockedSourceId && <label className="c-s">
                <input
                  type="search"
                  aria-label="Search chats"
                  value={sourceQuery}
                  placeholder="Search chats"
                  onChange={(event) => setSourceQuery(event.target.value)}
                />
              </label>}
              {visibleSources.map((option) => (
                <button
                  type="button"
                  key={option.conversationId}
                  aria-current={option.conversationId === sourceId ? "true" : undefined}
                  onClick={() => {
                    if (!lockedSourceId) setSourceId(option.conversationId);
                  }}
                >
                  <Detail
                    title={option.conversationTitle}
                    detail={`${option.projectName}${option.archived ? " · Archived" : ""}${option.workspaceRelation === "different-workspace" ? " · Different workspace" : ""}`}
                  />
                </button>
              ))}
              {visibleSources.length === 0 && (
                <p className="c-e">No matching chats</p>
              )}
              {matchingSources.length > visibleSources.length && (
                <p className="c-e">
                  More matches. Refine your search.
                </p>
              )}
            </aside>
            <main>
              <div className="c-m">
                <button type="button" className="c-mb" disabled={Boolean(lockedSourceId)} onClick={() => setSourceId(null)}>
                  ← Chats
                </button>
                <Detail
                  title={source?.conversationTitle ?? selectedSource?.conversationTitle ?? "Select a source"}
                  detail={source
                    ? `${source.projectName} · ${source.workspaceLabel}`
                    : "Visible user and agent messages"}
                />
                <em>{selectedIds.size}/{MAX_CONVERSATION_CONTEXT_MESSAGES} selected</em>
              </div>
              <p className="c-n">
                <ShieldCheck size={14} />
                Redaction is a safeguard, not a guarantee. Review every excerpt.
              </p>
              {loading ? <p className="c-st">Loading visible messages…</p>
                : error ? <p className="c-st is-error" role="alert">{error}</p>
                  : source?.messages.length ? (
                    <ExcerptList
                      excerpts={source.messages}
                      selectable
                      selectedIds={selectedIds}
                      onToggle={toggleMessage}
                    />
                  ) : <p className="c-st">This chat has no shareable messages.</p>}
            </main>
            <aside className="c-p" aria-label="Context preview">
              <div className="c-l">Agent preview</div>
              <textarea
                value={note}
                maxLength={1_024}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Optional context note"
                aria-label="Context note"
                aria-describedby="context-note-byte-limit"
                aria-invalid={noteBytes > MAX_CONVERSATION_CONTEXT_NOTE_BYTES}
              />
              <small id="context-note-byte-limit" className="c-nl">
                {noteBytes}/{MAX_CONVERSATION_CONTEXT_NOTE_BYTES} bytes
              </small>
              {previewExcerpts.length > 0
                ? <ExcerptList excerpts={previewExcerpts} />
                : <div className="c-ep"><MessagesSquare size={22} /><span>Select messages to preview.</span></div>}
              {differentWorkspace && (
                <label className="c-a">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  <Detail
                    title="Different workspace"
                    detail="Referenced files may be unavailable here."
                  />
                </label>
              )}
            </aside>
          </div>
        )}

        {!previewPacketId && (
          <footer>
            <span>{error && <em role="alert">{error}</em>}</span>
            <button type="button" className="secondary-button" disabled={saving} onClick={() => void closeDialog()}>Cancel</button>
            <button
              type="button"
              className="primary-button"
              disabled={
                saving
                || selectedIds.size === 0
                || noteBytes > MAX_CONVERSATION_CONTEXT_NOTE_BYTES
                || (differentWorkspace && !acknowledged)
              }
              onClick={() => void createPacket()}
            >
              <MessagesSquare size={14} /> {saving
                ? "Sharing…"
                : agentRequest
                  ? "Share with agent"
                  : "Attach context"}
            </button>
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}
