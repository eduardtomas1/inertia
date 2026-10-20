import { useEffect, useId, useRef, useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import clsx from "clsx";
import type { Initiative, InitiativeNote } from "@shared/contracts";
import {
  initiativeNoteExcerpt,
  MAX_INITIATIVE_BRIEF_BYTES,
  MAX_INITIATIVE_NOTE_BODY_BYTES,
  MAX_INITIATIVE_NOTE_TITLE_CHARS,
  MAX_INITIATIVE_NOTES,
  utf8ByteLength,
} from "@shared/initiatives";

import { formatFullDateTime, formatRelativeTime } from "../../lib/format";
import "./InitiativeMemory.css";

export type BriefSaveOutcome = "saved" | "conflict" | "failed";

const numberFormat = new Intl.NumberFormat("en-US");

/** The runtime's clock can run slightly ahead of the window's; never say "in 2 seconds". */
function notInFuture(timestamp: string): string {
  return Date.parse(timestamp) > Date.now() ? new Date().toISOString() : timestamp;
}

function isSubmitShortcut(event: React.KeyboardEvent): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}

function ByteCounter({ id, bytes, limit }: { id: string; bytes: number; limit: number }): React.JSX.Element {
  const over = bytes > limit;
  return (
    <span
      id={id}
      className={clsx("initiative-byte-counter", over && "is-over")}
      aria-live={over ? "polite" : "off"}
    >
      {numberFormat.format(bytes)} / {numberFormat.format(limit)} bytes{over ? " · too long" : ""}
    </span>
  );
}

interface BriefDraft {
  text: string;
  baseRevision: number;
  baseText: string;
}

/**
 * Unsaved brief drafts by initiative. The page remounts the editor for each
 * initiative, so a draft lives here while the user looks at another one and
 * is restored on return; it leaves on save, Discard or Reload. A draft based
 * on a revision changed meanwhile is reported as a conflict when saved.
 */
const briefDrafts = new Map<string, BriefDraft>();

/** Drops the unsaved brief of a deleted initiative, or every draft without an id. */
export function forgetInitiativeBriefDraft(initiativeId?: string): void {
  if (initiativeId === undefined) briefDrafts.clear();
  else briefDrafts.delete(initiativeId);
}

/** The brief draft of one initiative, kept across remounts of the editor. */
function useBriefDraft(initiativeId: string): [
  BriefDraft | null,
  (next: BriefDraft | null | ((current: BriefDraft | null) => BriefDraft | null)) => void,
] {
  const [draft, setDraftState] = useState<BriefDraft | null>(() => briefDrafts.get(initiativeId) ?? null);
  const setDraft = (next: BriefDraft | null | ((current: BriefDraft | null) => BriefDraft | null)): void => {
    // The map is the source of truth, so a save that finishes after the user
    // switched initiatives still updates the draft they will come back to.
    const value = typeof next === "function" ? next(briefDrafts.get(initiativeId) ?? null) : next;
    if (value) briefDrafts.set(initiativeId, value);
    else briefDrafts.delete(initiativeId);
    setDraftState(value);
  };
  return [draft, setDraft];
}

/**
 * The brief draft is based on one brief revision. Saving sends that revision,
 * so a brief changed elsewhere is never overwritten: the conflict is reported
 * in place, the draft is kept, and Reload replaces it with the latest brief.
 */
export function InitiativeBrief({
  initiative,
  offline,
  onSave,
}: {
  initiative: Initiative;
  offline: boolean;
  onSave(brief: string, expectedBriefRevision: number): Promise<BriefSaveOutcome>;
}): React.JSX.Element {
  const [draft, setDraft] = useBriefDraft(initiative.id);
  // A saved brief stays shown until the snapshot reaches the revision it made.
  const [saved, setSaved] = useState<{ text: string; revision: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const counterId = useId();
  const statusId = useId();
  const headingId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);

  const pendingSaved = saved && initiative.briefRevision < saved.revision ? saved : null;
  const value = draft?.text ?? pendingSaved?.text ?? initiative.brief;
  const dirty = draft !== null;
  const bytes = utf8ByteLength(value);
  const tooLong = bytes > MAX_INITIATIVE_BRIEF_BYTES;
  const invalid = value.includes("\0");

  const discard = (): void => {
    setDraft(null);
    setConflict(false);
    // The buttons disable once nothing is left to save; keep the user in place.
    textarea.current?.focus();
  };
  const save = async (): Promise<void> => {
    if (!draft || !dirty || saving || offline || tooLong || invalid) return;
    const sent = draft;
    setSaving(true);
    const outcome = await onSave(sent.text, sent.baseRevision);
    setSaving(false);
    if (outcome === "saved") {
      const revision = sent.baseRevision + 1;
      setSaved({ text: sent.text, revision });
      // Typing that continued while saving stays, now based on the saved brief.
      setDraft((current) => !current || current.text === sent.text
        ? null
        : { ...current, baseRevision: revision, baseText: sent.text });
      setConflict(false);
      // Save disables itself; return focus to the editor unless it moved elsewhere.
      const focused = document.activeElement;
      if (!focused || focused === document.body || textarea.current?.closest("section")?.contains(focused)) {
        textarea.current?.focus();
      }
    } else if (outcome === "conflict") {
      setConflict(true);
    }
  };
  const reload = (): void => {
    setDraft(null);
    setSaved(null);
    setConflict(false);
    textarea.current?.focus();
  };

  return (
    <section className="initiative-memory-section initiative-brief" aria-labelledby={headingId}>
      <header className="initiative-memory-heading">
        <h3 id={headingId}>Brief</h3>
        <span className="initiative-memory-meta" id={statusId}>
          {initiative.briefRevision === 0 || !initiative.briefUpdatedAt
            ? "Not written yet"
            : (
                <>
                  Revision {initiative.briefRevision} · updated{" "}
                  <time dateTime={initiative.briefUpdatedAt} title={formatFullDateTime(initiative.briefUpdatedAt)}>
                    {formatRelativeTime(notInFuture(initiative.briefUpdatedAt))}
                  </time>
                </>
              )}
        </span>
      </header>
      <p className="initiative-memory-hint">
        Objective, constraints and decisions every chat in this initiative should know. It is shared on the first message of a new session and after you change it.
      </p>
      <textarea
        ref={textarea}
        className="initiative-brief-input"
        aria-label="Initiative brief"
        aria-describedby={`${counterId} ${statusId}`}
        aria-invalid={tooLong || invalid || undefined}
        placeholder="Write the brief in Markdown."
        value={value}
        disabled={offline}
        rows={6}
        spellCheck
        onChange={(event) => {
          const text = event.target.value;
          const base = draft ?? {
            baseRevision: pendingSaved?.revision ?? initiative.briefRevision,
            baseText: value,
          };
          // Typing back to the saved text leaves nothing to save or discard.
          setDraft(text === base.baseText
            ? null
            : { text, baseRevision: base.baseRevision, baseText: base.baseText });
          // A reported conflict stays until Reload, Discard or nothing is left to save.
          if (text === base.baseText) setConflict(false);
        }}
        onKeyDown={(event) => {
          if (isSubmitShortcut(event)) {
            event.preventDefault();
            void save();
            return;
          }
          if (event.key !== "Escape" || !dirty) return;
          event.preventDefault();
          event.stopPropagation();
          if (window.confirm("Discard your changes to the brief?")) discard();
        }}
      />
      {conflict && (
        <div className="initiative-memory-conflict" role="alert">
          <span>The brief changed elsewhere. Reload to see the latest.</span>
          <button type="button" className="text-button" onClick={reload}>Reload</button>
        </div>
      )}
      <div className="initiative-memory-actions">
        <ByteCounter id={counterId} bytes={bytes} limit={MAX_INITIATIVE_BRIEF_BYTES} />
        <div className="initiative-memory-buttons">
          <button type="button" className="secondary-button" disabled={!dirty || saving} onClick={discard}>
            Discard
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!dirty || saving || offline || tooLong || invalid}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save brief"}
          </button>
        </div>
      </div>
    </section>
  );
}

interface NoteFormValue {
  title: string;
  body: string;
}

function NoteForm({
  initial,
  label,
  submitLabel,
  disabled,
  onSubmit,
  onCancel,
}: {
  initial: NoteFormValue;
  label: string;
  submitLabel: string;
  disabled: boolean;
  onSubmit(value: NoteFormValue): Promise<boolean>;
  onCancel(): void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  // Shown after a submit with a problem, and cleared once the text is fixed.
  const [problem, setProblem] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const counterId = useId();
  const problemId = useId();
  useEffect(() => {
    titleInput.current?.focus();
  }, []);
  const title = value.title.trim();
  const bytes = utf8ByteLength(value.body);
  const changed = value.title !== initial.title || value.body !== initial.body;
  const currentProblem = noteFormProblem(title, value.body);
  const submit = async (): Promise<void> => {
    if (title === "" || disabled || submitting) return;
    if (currentProblem) {
      setProblem(currentProblem.message);
      (currentProblem.field === "title" ? titleInput : bodyInput).current?.focus();
      return;
    }
    setSubmitting(true);
    const done = await onSubmit({ title, body: value.body });
    setSubmitting(false);
    if (done) onCancel();
  };
  const update = (next: NoteFormValue): void => {
    setValue(next);
    if (problem && !noteFormProblem(next.title.trim(), next.body)) setProblem(null);
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (isSubmitShortcut(event)) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // Like the brief: unsaved text is only dropped after a confirmation.
      if (!changed || window.confirm("Discard this note?")) onCancel();
    }
  };
  return (
    <form
      className="initiative-note-form"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        ref={titleInput}
        className="initiative-note-title-input"
        aria-label="Note title"
        placeholder="Title"
        autoComplete="off"
        aria-invalid={noteTitleTooLong(title) || undefined}
        aria-describedby={problem ? problemId : undefined}
        value={value.title}
        onChange={(event) => {
          update({ ...value, title: event.target.value.replace(/[\t\r\n]/gu, " ") });
        }}
        onKeyDown={onKeyDown}
      />
      <textarea
        ref={bodyInput}
        className="initiative-note-body-input"
        aria-label="Note text"
        aria-describedby={problem ? `${counterId} ${problemId}` : counterId}
        aria-invalid={noteFormProblem("", value.body) !== null || undefined}
        placeholder="What every chat should remember"
        rows={3}
        value={value.body}
        onChange={(event) => {
          update({ ...value, body: event.target.value });
        }}
        onKeyDown={onKeyDown}
      />
      {problem && (
        <p className="initiative-note-problem" id={problemId} role="alert">{problem}</p>
      )}
      <div className="initiative-memory-actions">
        <ByteCounter id={counterId} bytes={bytes} limit={MAX_INITIATIVE_NOTE_BODY_BYTES} />
        <div className="initiative-memory-buttons">
          <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary-button" disabled={title === "" || disabled || submitting}>
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * Why a note cannot be saved yet. Titles count code points, as the runtime
 * does, so a title of emoji is measured the way it is stored; the input has no
 * maxLength because that counts UTF-16 units.
 */
function noteTitleTooLong(title: string): boolean {
  return [...title].length > MAX_INITIATIVE_NOTE_TITLE_CHARS;
}

function noteFormProblem(title: string, body: string): { field: "title" | "body"; message: string } | null {
  if (noteTitleTooLong(title)) {
    return { field: "title", message: `Note titles are limited to ${MAX_INITIATIVE_NOTE_TITLE_CHARS} characters.` };
  }
  if (utf8ByteLength(body) > MAX_INITIATIVE_NOTE_BODY_BYTES) {
    return {
      field: "body",
      message: `Notes are limited to ${numberFormat.format(MAX_INITIATIVE_NOTE_BODY_BYTES)} bytes.`,
    };
  }
  if (body.includes("\0")) return { field: "body", message: "Notes cannot contain NUL characters." };
  return null;
}

function ProvenanceBadge({ note }: { note: InitiativeNote }): React.JSX.Element {
  return (
    <span className="initiative-note-provenance" data-provenance={note.provenance}>
      {note.provenance === "agent" ? "Agent" : "You"}
    </span>
  );
}

export type InitiativeNoteCommand =
  | { type: "initiative.note.create"; payload: { initiativeId: string; title: string; body: string } }
  | { type: "initiative.note.update"; payload: { id: string; expectedRevision: number; title?: string; body?: string } }
  | {
      type: "initiative.note.resolve";
      payload: { id: string; expectedRevision: number; decision: "accept" | "reject"; title?: string; body?: string };
    }
  | { type: "initiative.note.delete"; payload: { id: string } };

/**
 * Accepted notes, the proposals waiting for review and the add form. Notes
 * are read on demand: the snapshot carries only the revisions and the number
 * of proposals, which tell this list when to read again.
 */
export function InitiativeNotes({
  initiative,
  offline,
  confirmDestructiveActions,
  loadNotes,
  onCommand,
}: {
  initiative: Initiative;
  offline: boolean;
  confirmDestructiveActions: boolean;
  loadNotes(initiativeId: string): Promise<InitiativeNote[] | null>;
  /** Resolves true when the runtime applied the change. */
  onCommand(command: InitiativeNoteCommand): Promise<boolean>;
}): React.JSX.Element {
  const [notes, setNotes] = useState<InitiativeNote[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<{ id: string; mode: "edit" | "accept" } | null>(null);
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const section = useRef<HTMLElement>(null);
  // Where focus returns once a form closes or a note leaves the list: the
  // note's own first action, or Add note when that note is gone.
  const pendingFocus = useRef<string | null>(null);
  const headingId = useId();
  const loader = useRef(loadNotes);
  useEffect(() => {
    loader.current = loadNotes;
  });
  useEffect(() => {
    let current = true;
    void loader.current(initiative.id).then((loaded) => {
      if (current && loaded) setNotes(loaded);
    });
    return () => {
      current = false;
    };
  }, [initiative.id, initiative.notesRevision, initiative.proposedNoteCount, reloadKey]);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target || editing || adding) return;
    const element = target === "add"
      ? addButton.current
      : section.current?.querySelector<HTMLElement>(`[data-note-focus="${target}"]`);
    if (element && !(element as HTMLButtonElement).disabled) {
      pendingFocus.current = null;
      element.focus();
    } else if (target !== "add" && notes && !notes.some(({ id }) => id === target)) {
      pendingFocus.current = null;
      addButton.current?.focus();
    }
  });

  const run = async (command: InitiativeNoteCommand): Promise<boolean> => {
    const applied = await onCommand(command);
    // Edits to proposals move no snapshot field, so read again either way.
    setReloadKey((key) => key + 1);
    return applied;
  };
  // One review decision per proposal at a time: a second click while the
  // first is on its way would only meet a stale revision and a conflict.
  const resolving = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const resolve = async (
    note: InitiativeNote,
    decision: "accept" | "reject",
    edits: Partial<NoteFormValue> = {},
  ): Promise<boolean> => {
    if (resolving.current.has(note.id)) return false;
    resolving.current.add(note.id);
    setBusy(new Set(resolving.current));
    try {
      return await run({
        type: "initiative.note.resolve",
        payload: { id: note.id, expectedRevision: note.revision, decision, ...edits },
      });
    } finally {
      resolving.current.delete(note.id);
      setBusy(new Set(resolving.current));
    }
  };
  const accepted = notes?.filter(({ state }) => state === "accepted") ?? [];
  const proposed = notes?.filter(({ state }) => state === "proposed") ?? [];
  const full = accepted.length + proposed.length >= MAX_INITIATIVE_NOTES;
  const closeAdd = (): void => {
    pendingFocus.current = "add";
    setAdding(false);
  };
  const closeEdit = (noteId: string): void => {
    pendingFocus.current = noteId;
    setEditing(null);
  };

  return (
    <section ref={section} className="initiative-memory-section initiative-notes" aria-labelledby={headingId}>
      <header className="initiative-memory-heading">
        <h3 id={headingId}>Notes</h3>
        <span className="initiative-memory-meta">
          {notes === null ? "" : `${accepted.length} shared${initiative.notesRevision > 0 ? ` · revision ${initiative.notesRevision}` : ""}`}
        </span>
      </header>
      {proposed.length > 0 && (
        <section className="initiative-note-review" aria-label="Needs review">
          <h4>Needs review <span>{proposed.length}</span></h4>
          <ul>
            {proposed.map((note) => (
              <li key={note.id} className="initiative-note">
                {editing?.id === note.id && editing.mode === "accept" ? (
                  <NoteForm
                    initial={{ title: note.title, body: note.body }}
                    label={`Edit and accept ${note.title}`}
                    submitLabel="Save and accept"
                    disabled={offline || busy.has(note.id)}
                    onSubmit={(value) => resolve(note, "accept", value)}
                    onCancel={() => closeEdit(note.id)}
                  />
                ) : (
                  <>
                    <div className="initiative-note-text">
                      <span className="initiative-note-title">{note.title}</span>
                      <ProvenanceBadge note={note} />
                      {note.body && <p className="initiative-note-body">{note.body}</p>}
                    </div>
                    <div className="initiative-note-actions" role="group" aria-label={`Review ${note.title}`}>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={offline || busy.has(note.id)}
                        onClick={() => {
                          pendingFocus.current = note.id;
                          void resolve(note, "accept");
                        }}
                      >
                        <Check size={14} aria-hidden="true" />Accept
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        data-note-focus={note.id}
                        disabled={offline || busy.has(note.id)}
                        onClick={() => setEditing({ id: note.id, mode: "accept" })}
                      >
                        <Pencil size={14} aria-hidden="true" />Edit and accept
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={offline || busy.has(note.id)}
                        onClick={() => {
                          pendingFocus.current = "add";
                          void resolve(note, "reject");
                        }}
                      >
                        <X size={14} aria-hidden="true" />Reject
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {notes !== null && accepted.length === 0 && (
        <p className="initiative-empty-note">No notes yet. Notes you add here are shared with every chat in this initiative.</p>
      )}
      {accepted.length > 0 && (
        <ul className="initiative-note-list" aria-label="Shared notes">
          {accepted.map((note) => (
            <li key={note.id} className="initiative-note">
              {editing?.id === note.id && editing.mode === "edit" ? (
                <NoteForm
                  initial={{ title: note.title, body: note.body }}
                  label={`Edit ${note.title}`}
                  submitLabel="Save note"
                  disabled={offline}
                  onSubmit={(value) => {
                    const changes = {
                      ...(value.title !== note.title ? { title: value.title } : {}),
                      ...(value.body !== note.body ? { body: value.body } : {}),
                    };
                    if (Object.keys(changes).length === 0) return Promise.resolve(true);
                    return run({
                      type: "initiative.note.update",
                      payload: { id: note.id, expectedRevision: note.revision, ...changes },
                    });
                  }}
                  onCancel={() => closeEdit(note.id)}
                />
              ) : (
                <>
                  <div className="initiative-note-text">
                    <span className="initiative-note-title">{note.title}</span>
                    <ProvenanceBadge note={note} />
                    {note.body && (
                      <p className="initiative-note-excerpt" title={note.body}>{initiativeNoteExcerpt(note.body)}</p>
                    )}
                  </div>
                  <div className="initiative-note-actions" role="group" aria-label={`Note ${note.title}`}>
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`Edit ${note.title}`}
                      data-note-focus={note.id}
                      disabled={offline}
                      onClick={() => setEditing({ id: note.id, mode: "edit" })}
                    >
                      <Pencil size={14} aria-hidden="true" />Edit
                    </button>
                    <button
                      type="button"
                      className="text-button is-danger"
                      aria-label={`Delete ${note.title}`}
                      disabled={offline}
                      onClick={() => {
                        if (confirmDestructiveActions && !window.confirm(`Delete the note “${note.title}”?`)) return;
                        pendingFocus.current = "add";
                        void run({ type: "initiative.note.delete", payload: { id: note.id } });
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <NoteForm
          initial={{ title: "", body: "" }}
          label="Add note"
          submitLabel="Add note"
          disabled={offline || full}
          onSubmit={(value) => run({
            type: "initiative.note.create",
            payload: { initiativeId: initiative.id, ...value },
          })}
          onCancel={closeAdd}
        />
      ) : (
        <div className="initiative-note-add">
          <button
            ref={addButton}
            type="button"
            className="secondary-button"
            disabled={offline || notes === null || full}
            onClick={() => setAdding(true)}
          >
            <Plus size={14} aria-hidden="true" />Add note
          </button>
          {full && <span className="initiative-memory-hint">An initiative keeps at most {MAX_INITIATIVE_NOTES} notes.</span>}
        </div>
      )}
    </section>
  );
}
