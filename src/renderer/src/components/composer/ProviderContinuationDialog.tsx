import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessagesSquare, X } from "lucide-react";
import type { ConversationContextSourceTranscript } from "@shared/contracts";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { IconButton } from "../ui";
import type { ConversationContextCommandRunner } from "../conversation-context/types";
import type { PendingModelRoute } from "./types";
import "./ProviderContinuationDialog.css";

const isLong = (content: string): boolean => content.length > 280 || content.split("\n").length > 5;

export default function ProviderContinuationDialog({ pendingRoute, busy, disabled, error, onCommand, onClose, onContinue }: {
  pendingRoute: PendingModelRoute;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onCommand: ConversationContextCommandRunner;
  onClose: () => void;
  onContinue: (selection: { sourceMessageIds: string[]; instruction: string }) => void;
}): React.JSX.Element {
  const [transcript, setTranscript] = useState<ConversationContextSourceTranscript | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(0);
  const close = useRef<HTMLButtonElement>(null);
  useNativePreviewSuspension(true);
  useEffect(() => {
    const restore = captureModalFocus(false);
    close.current?.focus();
    return restore;
  }, []);
  useEffect(() => {
    let active = true;
    setTranscript(null); setSelected([]); setLoadError(null); setPage(0);
    void onCommand("conversation.context.source.load", {
      type: "conversation.context.source.load",
      payload: { sourceConversationId: pendingRoute.sourceConversationId, targetConversationId: pendingRoute.sourceConversationId, forContinuation: true },
    }).then((event) => {
      if (!active) return;
      if (event.type !== "request.result" || event.result.kind !== "conversation.context.source"
        || event.result.source.conversationId !== pendingRoute.sourceConversationId) {
        throw new Error("The source conversation could not be loaded.");
      }
      setTranscript(event.result.source);
      setSelected(event.result.source.messages.map(({ sourceMessageId }) => sourceMessageId));
    }).catch((failure: unknown) => {
      if (active) setLoadError(failure instanceof Error ? failure.message : "The source conversation could not be loaded.");
    });
    return () => { active = false; };
  }, [onCommand, pendingRoute.sourceConversationId, attempt]);
  return createPortal(<div className="dialog-backdrop" onClick={(event) => event.stopPropagation()}>
    <section className="commit-dialog provider-continuation-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-continuation-title"
      aria-busy={busy || !transcript && !loadError} onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
        trapModalFocus(event, event.currentTarget);
      }}>
      <header>
        <span className="dialog-icon" aria-hidden="true"><MessagesSquare size={16} /></span>
        <div>
          <h2 id="provider-continuation-title">Continue with {pendingRoute.label}</h2>
          <p>From {pendingRoute.sourceTitle ?? "this chat"} · {pendingRoute.configuration.interactionMode === "plan" ? "Plan" : "Build"} · {{ supervised: "Supervised", "auto-edit": "Auto-accept edits", full: "Full access" }[pendingRoute.configuration.accessMode]}</p>
        </div>
        <IconButton ref={close} label="Close provider continuation" disabled={busy} onClick={onClose}><X size={16} aria-hidden="true" /></IconButton>
      </header>
      <div className="provider-continuation-body">
        <p>A linked chat will continue in <strong>{pendingRoute.sourceWorkspaceLabel ?? "the same checkout"}</strong>. Choose the visible messages to carry over.</p>
        <p className="provider-continuation-detail">Your original chat stays available. Hidden provider state, tool output and attachment contents are not transferred. The new draft lets you inspect the exact context and any omissions before sending.</p>
        {loadError ? <div className="provider-continuation-state" role="alert"><p>{loadError}</p>
          <button type="button" className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>Retry loading context</button></div>
          : !transcript ? <p className="provider-continuation-state" role="status"><span className="loading-mark" aria-hidden="true" />Loading conversation…</p> : <>
            <label className="provider-continuation-select-all"><input type="checkbox" disabled={busy}
              checked={selected.length > 0 && selected.length === transcript.messages.length}
              onChange={(event) => setSelected(event.target.checked ? transcript.messages.map(({ sourceMessageId }) => sourceMessageId) : [])} />
              {selected.length} of {transcript.messages.length} messages selected</label>
            <ul className="provider-continuation-messages">{transcript.messages.slice(page * 50, (page + 1) * 50).map((message) => {
              const open = expanded.includes(message.sourceMessageId);
              return <li key={message.sourceMessageId}>
                <label><input type="checkbox" disabled={busy} checked={selected.includes(message.sourceMessageId)}
                  onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, message.sourceMessageId] : ids.filter((id) => id !== message.sourceMessageId))} />
                  <span><strong>{message.role === "user" ? "You" : "Agent"}</strong><p className={open ? "is-expanded" : undefined}>{message.content}</p>{message.truncated && <small>Excerpt shortened</small>}</span>
                </label>
                {isLong(message.content) && <button type="button" className="provider-continuation-more" aria-expanded={open}
                  onClick={() => setExpanded((ids) => open ? ids.filter((id) => id !== message.sourceMessageId) : [...ids, message.sourceMessageId])}>
                  {open ? "Show less" : "Show more"}</button>}
              </li>;
            })}</ul>
            {transcript.messages.length > 50 && <nav aria-label="Context preview pages">
              <button type="button" className="secondary-button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous messages</button>
              <span>Page {page + 1} of {Math.ceil(transcript.messages.length / 50)}</span>
              <button type="button" className="secondary-button" disabled={(page + 1) * 50 >= transcript.messages.length} onClick={() => setPage((value) => value + 1)}>Next messages</button>
            </nav>}
          </>}
        <label className="provider-continuation-instruction">Next instruction (optional)<textarea rows={3} maxLength={4_000} value={instruction}
          disabled={busy} placeholder="Review the implementation and check the edge cases." onChange={(event) => setInstruction(event.target.value)} /></label>
      </div>
      {error && <p className="provider-continuation-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button" disabled={disabled || !transcript || !selected.length}
          aria-disabled={busy || undefined} onClick={() => { if (!busy) onContinue({ sourceMessageIds: selected, instruction }); }}>
          {busy ? "Creating…" : "Create continuation"}</button>
      </footer>
    </section>
  </div>, document.body);
}
