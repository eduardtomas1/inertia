import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronRight, RefreshCw, Save, StickyNote, TriangleAlert } from "lucide-react";
import type { ClientCommand, ServerEvent } from "@shared/contracts";
import {
  MAX_CONVERSATION_NOTE_CHARS,
  conversationNotesResultSchema,
  type ConversationNote,
} from "@shared/conversation-notes";
import { IconButton } from "./ui";
import "./ConversationNotes.css";

export interface ConversationNotesProps {
  conversationId: string;
  title?: string;
  online: boolean;
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  actions?: React.ReactNode;
}

interface NoteDraft { content: string; revision: number }
const draftKey = (id: string) => `inertia:conversation-notes:${id}`;
const memoryDrafts = new Map<string, NoteDraft | null>();

function readDraft(id: string): NoteDraft | null {
  // Storage can retain an older draft when quota or privacy settings reject a write.
  if (memoryDrafts.has(id)) return memoryDrafts.get(id) ?? null;
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(draftKey(id)) ?? "null");
    if (value && typeof value === "object" && "content" in value && "revision" in value
      && typeof value.content === "string" && value.content.length <= MAX_CONVERSATION_NOTE_CHARS
      && typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0) {
      return { content: value.content, revision: value.revision };
    }
  } catch { /* The in-memory draft still survives navigation when storage is unavailable. */ }
  return memoryDrafts.get(id) ?? null;
}

function retainDraft(id: string, draft: NoteDraft | null): void {
  // Keep cleared entries too, so a failed storage removal cannot resurrect a draft.
  memoryDrafts.set(id, draft);
  try {
    if (draft) window.sessionStorage.setItem(draftKey(id), JSON.stringify(draft));
    else window.sessionStorage.removeItem(draftKey(id));
  } catch { /* Saving to the runtime remains available. */ }
}

/** Key the editor by chat so late responses cannot cross a conversation boundary. */
export function ConversationNotes(props: ConversationNotesProps): React.JSX.Element {
  return <NotesEditor key={props.conversationId} {...props} />;
}

function NotesEditor({ conversationId, title, online, sendCommand, actions }: ConversationNotesProps): React.JSX.Element {
  const labelId = useId();
  const [saved, setSaved] = useState<ConversationNote | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(() => readDraft(conversationId));
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const content = draft?.content ?? saved?.content ?? "";
  const dirty = draft !== null && (!saved || draft.content !== saved.content);

  const accept = useCallback((note: ConversationNote, expectedDraft?: NoteDraft): void => {
    setSaved(note);
    const current = draftRef.current;
    if (!current || current.content === note.content) {
      draftRef.current = null; setDraft(null); retainDraft(conversationId, null); setConflict(false);
    } else if (expectedDraft && current.revision === expectedDraft.revision) {
      const next = { ...current, revision: note.revision };
      draftRef.current = next; setDraft(next); retainDraft(conversationId, next); setConflict(false);
    } else {
      setConflict(current.revision !== note.revision);
    }
  }, [conversationId]);

  const load = useCallback(async (): Promise<void> => {
    if (!online || pending.current) return;
    const version = ++generation.current;
    pending.current = true; setBusy(true); setError(null);
    try {
      const event = await sendCommand({ type: "conversation.notes.get", requestId: crypto.randomUUID(), payload: { conversationId } });
      if (version !== generation.current) return;
      const result = event.type === "request.result" ? conversationNotesResultSchema.safeParse(event.result) : null;
      if (!result?.success || result.data.note.conversationId !== conversationId) throw new Error("Notes could not be loaded. Try again.");
      accept(result.data.note);
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : "Notes could not be loaded.");
    } finally {
      if (version === generation.current) { pending.current = false; setBusy(false); }
    }
  }, [online, conversationId, sendCommand, accept]);

  const invalidateRequests = useCallback((): void => {
    generation.current += 1;
    pending.current = false;
  }, []);

  useEffect(() => {
    void load();
    const focus = () => { void load(); };
    window.addEventListener("focus", focus);
    return () => { invalidateRequests(); window.removeEventListener("focus", focus); };
  }, [load, invalidateRequests]);

  const save = async (replace = false): Promise<void> => {
    const current = draftRef.current;
    if (!online || pending.current || !saved || !current || (conflict && !replace)) return;
    const version = ++generation.current;
    pending.current = true; setBusy(true); setError(null);
    try {
      const event = await sendCommand({ type: "conversation.notes.update", requestId: crypto.randomUUID(), payload: {
        conversationId, content: current.content, expectedRevision: replace ? saved.revision : current.revision,
      } });
      const result = event.type === "request.result" ? conversationNotesResultSchema.safeParse(event.result) : null;
      if (!result?.success || result.data.note.conversationId !== conversationId) throw new Error("Notes could not be saved. Your draft is still here.");
      if (version !== generation.current) return;
      if (result.data.outcome === "conflict") {
        setSaved(result.data.note); setConflict(true);
      } else accept(result.data.note, current);
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : "Notes could not be saved. Your draft is still here.");
    } finally {
      if (version === generation.current) { pending.current = false; setBusy(false); }
    }
  };

  const keepSaved = (): void => {
    draftRef.current = null; setDraft(null); retainDraft(conversationId, null); setConflict(false); setError(null);
  };
  const canSave = online && Boolean(saved) && dirty && !busy && !conflict;

  return <section className="conversation-notes" aria-labelledby={labelId}>
    <header className="panel-toolbar">
      <div className="panel-heading"><StickyNote size={17} aria-hidden="true" /><div className="panel-heading-copy">
        <h2 id={labelId}>Notes</h2><span title={title}>{title ?? "For this chat"}</span>
      </div></div>
      <div className="conversation-notes-actions">
        <IconButton label="Refresh notes" aria-disabled={!online || busy || undefined} onClick={() => { void load(); }}><RefreshCw size={15} aria-hidden="true" /></IconButton>
        {actions}
      </div>
    </header>
    <div className="conversation-notes-body">
      <p className="conversation-notes-hint">Keep decisions, reminders, and next steps here. Notes are not sent to the agent.</p>
      {error && <p className="conversation-notes-error" role="alert">{error}</p>}
      <textarea aria-label="Chat notes" placeholder="What do you want to remember?" maxLength={MAX_CONVERSATION_NOTE_CHARS}
        value={content} disabled={!saved && !draft} spellCheck
        onChange={(event) => {
          const next = { content: event.target.value, revision: draftRef.current?.revision ?? saved?.revision ?? 0 };
          draftRef.current = next; setDraft(next); retainDraft(conversationId, next);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault(); event.stopPropagation(); void save();
          }
        }} />
      {conflict && <div className="conversation-notes-conflict" role="alert">
        <TriangleAlert size={14} aria-hidden="true" />
        <div>
          <strong>Notes changed in another window.</strong><p>Your draft is preserved. Compare it with the saved version before choosing which to keep.</p>
          <details><summary>Show saved notes<ChevronRight size={13} aria-hidden="true" /></summary><pre tabIndex={0} role="region" aria-label="Saved notes">{saved?.content || "The saved note is empty."}</pre></details>
          <div><button type="button" className="secondary-button" disabled={busy} onClick={keepSaved}>Use saved notes</button>
            <button type="button" className="secondary-button" disabled={!online || busy} onClick={() => { void save(true); }}>Replace with my draft</button></div>
        </div>
      </div>}
      <footer>
        <span role="status">{!online ? "Offline · draft kept in this window" : busy ? "Syncing…" : dirty ? "Unsaved changes" : saved ? <><Check size={13} aria-hidden="true" />Saved</> : "Notes unavailable"}</span>
        <span className="conversation-notes-count">{content.length.toLocaleString()} / 20,000</span>
        <button type="button" className="primary-button" aria-disabled={!canSave || undefined} onClick={() => { if (canSave) void save(); }}><Save size={14} aria-hidden="true" />Save notes</button>
      </footer>
    </div>
  </section>;
}
