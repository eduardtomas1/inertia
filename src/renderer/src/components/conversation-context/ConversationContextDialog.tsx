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
} from "@shared/contracts";
import {
  MAX_CONVERSATION_CONTEXT_MESSAGES,
  MAX_CONVERSATION_CONTEXT_NOTE_BYTES,
  MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
  MAX_CONVERSATION_CONTEXT_TOTAL_BYTES,
} from "@shared/conversation-context";
import { resultEvent } from "../../lib/runtimeCommands";
import { trapModalFocus } from "../../utils/modalFocus";
import type {
  ConversationContextCommandRunner,
  ConversationContextSourceOption,
} from "./types";
import "./ConversationContextDialog.css";

function failureMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : fallback;
}

function selectedPreview(
  messages: readonly ConversationContextExcerpt[],
  selectedIds: ReadonlySet<string>,
): ConversationContextExcerpt[] {
  const selected = messages.filter(({ sourceMessageId }) =>
    selectedIds.has(sourceMessageId));
  if (selected.length === 0) return [];
  const budget = Math.min(
    MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
    Math.floor(MAX_CONVERSATION_CONTEXT_TOTAL_BYTES / selected.length),
  );
  return selected.map((message) => {
    const encoder = new TextEncoder();
    if (encoder.encode(message.content).byteLength <= budget) return message;
    let low = 0;
    let high = message.content.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encoder.encode(message.content.slice(0, middle)).byteLength <= budget) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return {
      ...message,
      content: message.content.slice(0, low),
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
    <div className="context-excerpt-list">
      {excerpts.map((excerpt) => {
        const selected = selectedIds?.has(excerpt.sourceMessageId) ?? false;
        const copy = (
          <>
            <span className="context-excerpt-meta">
              <strong>{excerpt.role === "user" ? "You" : "Agent"}</strong>
              {excerpt.truncated && <em>bounded excerpt</em>}
            </span>
            <span className="context-excerpt-copy">{excerpt.content}</span>
          </>
        );
        return selectable ? (
          <button
            type="button"
            key={excerpt.sourceMessageId}
            className="context-excerpt is-selectable"
            aria-pressed={selected}
            onClick={() => onToggle?.(excerpt.sourceMessageId)}
          >
            <span className="context-excerpt-check" aria-hidden="true">
              {selected ? "✓" : null}
            </span>
            <span>{copy}</span>
          </button>
        ) : (
          <article className="context-excerpt" key={excerpt.sourceMessageId}>
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
    <div className="context-packet-preview">
      <div className="context-packet-provenance">
        <span><strong>{packet.sourceConversationTitle}</strong><small>{packet.sourceProjectName}</small></span>
        <span><strong>{packet.sourceWorkspaceLabel}</strong><small>Captured {new Date(packet.createdAt).toLocaleString()}</small></span>
      </div>
      {packet.sourceState === "deleted" && (
        <p className="context-dialog-warning" role="status">
          The source chat was deleted. This is the immutable excerpt that was sent.
        </p>
      )}
      {packet.workspaceRelation === "different-workspace" && (
        <p className="context-dialog-boundary">
          <ShieldCheck size={14} /> Context came from a different project or worktree.
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
  const dialogRef = useRef<HTMLElement>(null);
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
  const noteBytes = useMemo(
    () => new TextEncoder().encode(note.trim()).byteLength,
    [note],
  );

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (
        previouslyFocused instanceof HTMLElement
        && document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void closeDialog();
      return;
    }
    trapModalFocus(event, event.currentTarget, true);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (previewPacketId) {
      void onCommand("conversation.context.load", {
        type: "conversation.context.load",
        payload: { packetId: previewPacketId, targetConversationId },
      }).then((event) => {
        if (cancelled) return;
        const result = resultEvent(event).result;
        if (result.kind !== "conversation.context.packet") {
          throw new Error("The saved chat context could not be identified.");
        }
        setPacket(result.packet);
      }).catch((failure: unknown) => {
        if (!cancelled) setError(failureMessage(
          failure,
          "The saved chat context could not be loaded.",
        ));
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
      return () => { cancelled = true; };
    }
    if (!sourceId) {
      setSource(null);
      setSelectedIds(new Set());
      setAcknowledged(false);
      setLoading(false);
      return () => { cancelled = true; };
    }
    setSource(null);
    setSelectedIds(new Set());
    setAcknowledged(false);
    const sourcePayload = { sourceConversationId: sourceId, targetConversationId };
    const sourceRequest = agentRequest
      ? onCommand("conversation.context.agent.source.load", {
        type: "conversation.context.agent.source.load" as const,
        payload: {
          contextRequestId: agentRequest.requestId,
          ...sourcePayload,
        },
      })
      : onCommand("conversation.context.source.load", {
        type: "conversation.context.source.load" as const,
        payload: sourcePayload,
      });
    void sourceRequest.then((event) => {
      if (cancelled) return;
      const result = resultEvent(event).result;
      if (result.kind !== "conversation.context.source") {
        throw new Error("The source transcript could not be identified.");
      }
      if (result.source.targetConversationId !== targetConversationId) {
        throw new Error("The source transcript belongs to another target chat.");
      }
      setSource(result.source);
    }).catch((failure: unknown) => {
      if (!cancelled) setError(failureMessage(
        failure,
        "The source chat could not be loaded.",
      ));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
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
      const event = await onCommand("conversation.context.create", {
        type: "conversation.context.create",
        payload: selection,
      });
      const result = resultEvent(event).result;
      if (result.kind !== "conversation.context.packet") {
        throw new Error("The created chat context could not be identified.");
      }
      onClose();
    } catch (failure) {
      setError(failureMessage(failure, "The chat context could not be created."));
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
      setError(failureMessage(failure, "The context request could not be cancelled."));
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="conversation-context-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void closeDialog();
      }}
    >
      <section
        ref={dialogRef}
        className="conversation-context-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleDialogKeyDown}
      >
        <header>
          <span className="conversation-context-heading-mark" aria-hidden="true">
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
              ? "The exact bounded excerpt attached to this request"
              : agentRequest
                ? "You choose the exact messages this running agent can receive"
              : "Choose only the messages this agent should receive"}</small>
          </span>
          <button ref={closeRef} type="button" aria-label="Close chat context" onClick={() => void closeDialog()}>
            <X size={16} />
          </button>
        </header>

        {previewPacketId ? (
          <div className="conversation-context-preview-body">
            {loading ? <p className="context-dialog-state">Loading shared context…</p>
              : packet ? <PacketPreview packet={packet} />
                : <p className="context-dialog-state is-error">{error ?? "Context unavailable."}</p>}
          </div>
        ) : (
          <div
            className="conversation-context-workbench"
            data-source-selected={sourceId ? "true" : "false"}
          >
            <aside aria-label="Source chats">
              <div className="context-dialog-section-label">Source chat</div>
              {!lockedSourceId && <label className="context-dialog-source-search">
                <span className="sr-only">Search chats</span>
                <input
                  type="search"
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
                  <span>
                    <strong>{option.conversationTitle}</strong>
                    <small>{option.projectName}{option.archived ? " · Archived" : ""}</small>
                  </span>
                  {option.workspaceRelation === "different-workspace" && <ShieldCheck size={12} />}
                </button>
              ))}
              {visibleSources.length === 0 && (
                <p className="context-dialog-source-empty">No matching chats</p>
              )}
              {matchingSources.length > visibleSources.length && (
                <p className="context-dialog-source-empty">
                  Showing the first {visibleSources.length} matches. Refine your search.
                </p>
              )}
            </aside>
            <main>
              <div className="context-dialog-main-header">
                <button type="button" className="context-dialog-mobile-back" disabled={Boolean(lockedSourceId)} onClick={() => setSourceId(null)}>
                  ← Chats
                </button>
                <span>
                  <strong>{source?.conversationTitle ?? selectedSource?.conversationTitle ?? "Select a source"}</strong>
                  <small>{source
                    ? `${source.projectName} · ${source.workspaceLabel}`
                    : "Visible user and agent messages only"}</small>
                </span>
                <em>{selectedIds.size}/{MAX_CONVERSATION_CONTEXT_MESSAGES} selected</em>
              </div>
              <p className="context-dialog-privacy-note">
                <ShieldCheck size={14} />
                Token-like secrets are redacted as a safeguard, not a guarantee. Review every excerpt before sharing.
              </p>
              {loading ? <p className="context-dialog-state">Loading visible messages…</p>
                : error ? <p className="context-dialog-state is-error" role="alert">{error}</p>
                  : source?.messages.length ? (
                    <ExcerptList
                      excerpts={source.messages}
                      selectable
                      selectedIds={selectedIds}
                      onToggle={toggleMessage}
                    />
                  ) : <p className="context-dialog-state">This chat has no shareable messages.</p>}
            </main>
            <aside className="context-dialog-preview" aria-label="Context preview">
              <div className="context-dialog-section-label">Agent preview</div>
              <textarea
                value={note}
                maxLength={1_024}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Optional note about why this context matters"
                aria-label="Context note"
                aria-describedby="context-note-byte-limit"
                aria-invalid={noteBytes > MAX_CONVERSATION_CONTEXT_NOTE_BYTES}
              />
              <small id="context-note-byte-limit" className="context-dialog-note-limit">
                {noteBytes.toLocaleString()}/{MAX_CONVERSATION_CONTEXT_NOTE_BYTES.toLocaleString()} bytes
              </small>
              {previewExcerpts.length > 0
                ? <ExcerptList excerpts={previewExcerpts} />
                : <div className="context-dialog-empty-preview"><MessagesSquare size={22} /><span>Select messages to preview the exact bounded packet.</span></div>}
              {(source?.workspaceRelation ?? selectedSource?.workspaceRelation)
                === "different-workspace" && (
                <label className="context-dialog-acknowledgement">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  <span><strong>Different workspace</strong><small>I understand these excerpts may refer to files unavailable in this chat.</small></span>
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
                || ((source?.workspaceRelation ?? selectedSource?.workspaceRelation)
                  === "different-workspace" && !acknowledged)
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
