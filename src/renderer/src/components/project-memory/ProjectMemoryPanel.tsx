import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { MAX_PROJECT_MEMORY_ENTRIES, projectMemoryDraftSchema, type ProjectMemoryDraft, type ProjectMemoryEntry, type ProjectMemoryState, type ProjectMemorySourcePreview } from "@shared/project-memory";
import { diagnosticErrorReference } from "../../utils/diagnosticNavigation";
import { IconButton } from "../ui";
import type { ProjectMemoryCommand, ProjectMemoryPanelProps } from "./types";
import "./ProjectMemory.css";

const blank: ProjectMemoryDraft = { kind: "rule", title: "", text: "", reason: "" };
type PanelError = { text: string; failedChange: boolean };
type Editor = { id: string; draft: ProjectMemoryDraft; source?: { conversationId: string; messageId: string }; isNew: boolean };

export function ProjectMemoryPanel({ projectId, conversationId, request, disabled = false, sourceMessage, onBusyChange, onDraftChange }: ProjectMemoryPanelProps): React.JSX.Element {
  const [state, setState] = useState<ProjectMemoryState | null>(null);
  const [source, setSource] = useState<ProjectMemorySourcePreview | null>(null);
  const [sourceLoading, setSourceLoading] = useState<string | null>(null);
  const sourceGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError | null>(null);
  const [preview, setPreview] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(() => sourceMessage ? {
    id: crypto.randomUUID(), isNew: true,
    draft: { ...blank, kind: "decision", text: sourceMessage.content.slice(0, 1600) },
    source: { conversationId: sourceMessage.conversationId, messageId: sourceMessage.id },
  } : null);
  const pending = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const root = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const editorTitleId = useId();
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDraftChange?.(editor !== null); }, [editor, onDraftChange]);
  useEffect(() => {
    if (busy || editor || document.activeElement !== document.body) return;
    const target = addButton.current && !addButton.current.disabled ? addButton.current : root.current;
    target?.focus();
  }, [busy, editor]);
  const scope = { projectId, ...(conversationId ? { conversationId } : {}) };
  const refresh = useCallback(async () => {
    const own = ++generation.current;
    setError(null);
    try {
      const event = await request({ type: "project.memory.load", payload: { projectId, ...(conversationId ? { conversationId } : {}) } });
      if (!mounted.current || generation.current !== own) return;
      if (event.type !== "request.result" || event.result.kind !== "project.memory"
        || event.result.state.projectId !== projectId || event.result.state.conversationId !== (conversationId ?? null)) {
        throw new Error("The local service returned unexpected project memory.");
      }
      setState(event.result.state);
    } catch (cause) {
      if (mounted.current && generation.current === own) setError({ text: cause instanceof Error ? cause.message : "Rules and decisions could not be loaded.", failedChange: false });
    }
  }, [projectId, conversationId, request]);
  const invalidateReads = useCallback(() => { generation.current++; }, []);
  useEffect(() => {
    mounted.current = true;
    if (!disabled) void refresh();
    return () => { mounted.current = false; invalidateReads(); };
  }, [refresh, disabled, invalidateReads]);
  const mutate = async (command: ProjectMemoryCommand, onSuccess?: () => void): Promise<void> => {
    if (pending.current || disabled) return;
    pending.current = true;
    ++generation.current;
    setBusy(true); setError(null);
    try {
      const event = await request(command);
      if (!mounted.current) return;
      if (event.type !== "request.result" || event.result.kind !== "project.memory"
        || event.result.state.projectId !== projectId || event.result.state.conversationId !== (conversationId ?? null)) {
        throw new Error("The local service returned unexpected project memory.");
      }
      setState(event.result.state); onSuccess?.();
    } catch (cause) {
      if (mounted.current) setError({ text: cause instanceof Error ? cause.message : "Rules and decisions could not be saved. Your draft is still here.", failedChange: true });
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const inspectSource = async (id: string): Promise<void> => {
    const own = ++sourceGeneration.current;
    setSource(null); setSourceLoading(id); setError(null);
    try {
      const event = await request({ type: "project.memory.source", payload: { projectId, id } });
      if (!mounted.current || sourceGeneration.current !== own) return;
      if (event.type !== "request.result" || event.result.kind !== "project.memory.source"
        || event.result.preview.projectId !== projectId || event.result.preview.id !== id) {
        throw new Error("The local service returned an unexpected source message.");
      }
      setSource(event.result.preview);
    } catch (cause) {
      if (mounted.current && sourceGeneration.current === own) setError({ text: cause instanceof Error ? cause.message : "The source could not be loaded.", failedChange: false });
    } finally {
      if (mounted.current && sourceGeneration.current === own) setSourceLoading(null);
    }
  };
  const blocked = busy || disabled || !state;
  const edit = (entry: ProjectMemoryEntry): void => setEditor({ id: entry.id, isNew: false,
    draft: { kind: entry.kind, title: entry.title, text: entry.text, reason: entry.reason } });
  const change = (field: keyof ProjectMemoryDraft, value: string): void => setEditor((current) => current
    ? { ...current, draft: { ...current.draft, [field]: value } } : null);
  const draftValid = editor !== null && projectMemoryDraftSchema.safeParse(editor.draft).success;
  const notice = (inEditor: boolean): React.JSX.Element | null => error && inEditor === (editor !== null)
    ? <p className="project-memory-error" role={error.failedChange ? "alert" : "status"}>{diagnosticErrorReference(error.text).message}</p>
    : null;
  const summary = state
    ? `${state.entries.length} of ${MAX_PROJECT_MEMORY_ENTRIES} entries${conversationId ? ` · ${state.entries.length - state.disabledIds.length} used in this chat` : ""}`
    : disabled ? "Reconnect to load or change rules and decisions." : "Loading rules and decisions…";
  return <section ref={root} tabIndex={-1} className="project-memory" aria-label="Project rules and decisions">
    <div className="project-memory-toolbar">
      <p className="project-memory-summary" role="status">{summary}</p>
      <IconButton label="Refresh rules & decisions" disabled={busy || disabled} onClick={() => void refresh()}>
        <RefreshCw size={14} aria-hidden="true" />
      </IconButton>
      <button ref={addButton} type="button" className="secondary-button project-memory-add"
        disabled={blocked || editor !== null || (state?.entries.length ?? 0) >= MAX_PROJECT_MEMORY_ENTRIES}
        onClick={() => setEditor({ id: crypto.randomUUID(), isNew: true, draft: { ...blank } })}>
        <Plus size={14} aria-hidden="true" />Add entry
      </button>
    </div>
    <p className="project-memory-help">Included when the next turn starts, including queued work. Running turns and their follow-ups keep their original context. Earlier context remains in the provider's history.</p>
    {notice(false)}
    {state && <>
      {!editor && state.entries.length === 0 && <p className="project-memory-empty">No rules or decisions yet. Add one, or use Remember on a message to keep its source.</p>}
      {editor && <form className="project-memory-editor" aria-labelledby={editorTitleId} onSubmit={(event) => {
        event.preventDefault();
        if (blocked || !draftValid) return;
        void mutate({ type: "project.memory.save", payload: { ...scope, id: editor.id, expectedRevision: state.revision,
          mode: editor.isNew ? "create" : "update", entry: editor.draft, ...(editor.source ? { source: editor.source } : {}) } }, () => setEditor(null));
      }}>
        <h3 id={editorTitleId}>{editor.isNew ? "Remember for this project" : "Edit entry"}</h3>
        <fieldset disabled={blocked}>
          <div className="project-memory-fields">
            <label>Type
              <select value={editor.draft.kind} onChange={(event) => change("kind", event.target.value)}>
                <option value="rule">Rule</option>
                <option value="decision">Decision</option>
              </select>
            </label>
            <label>Title
              <input autoFocus required maxLength={120} value={editor.draft.title} onChange={(event) => change("title", event.target.value)} placeholder="Keep the billing snapshot" />
            </label>
          </div>
          <label>Rule or decision
            <textarea aria-label="Rule or decision" required maxLength={1600} rows={4} value={editor.draft.text} onChange={(event) => change("text", event.target.value)} placeholder="Use the saved proration context when calculating invoices." />
          </label>
          <label>Why it matters
            <textarea aria-label="Why it matters" required maxLength={1200} rows={3} value={editor.draft.reason} onChange={(event) => change("reason", event.target.value)} placeholder="Reading billing events directly misses plan changes from the previous cycle." />
          </label>
        </fieldset>
        {editor.source && <p className="project-memory-hint">The source message stays linked. Review the excerpt and add the reason before saving.</p>}
        {notice(true)}
        <footer>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditor(null)}>Cancel</button>
          <button type="submit" className="primary-button" aria-disabled={blocked || !draftValid}>{busy ? "Saving…" : "Save entry"}</button>
        </footer>
      </form>}
      {state.entries.length > 0 && <ul className="project-memory-list">{state.entries.map((entry) => {
        const excluded = state.disabledIds.includes(entry.id);
        const sourceDeleted = state.unavailableSourceIds.includes(entry.id);
        return <li key={entry.id} className={excluded ? "project-memory-entry is-excluded" : "project-memory-entry"}>
          <h3>{entry.title}</h3>
          <div className="project-memory-entry-actions">
            <IconButton label={`Edit ${entry.title}`} disabled={blocked || editor !== null} onClick={() => edit(entry)}>
              <Pencil size={14} aria-hidden="true" />
            </IconButton>
            <IconButton label={`Delete ${entry.title}`} disabled={blocked || editor !== null} onClick={() => {
              if (window.confirm(`Delete “${entry.title}” from this project's memory? Past turns keep their recorded context.`)) {
                void mutate({ type: "project.memory.delete", payload: { ...scope, expectedRevision: state.revision, id: entry.id } });
              }
            }}>
              <Trash2 size={14} aria-hidden="true" />
            </IconButton>
          </div>
          <p className="project-memory-meta">
            <span>{entry.kind === "rule" ? "Rule" : "Decision"}</span>
            <span aria-hidden="true">·</span>
            {entry.source
              ? <button type="button" className="project-memory-link" disabled={disabled || sourceDeleted || sourceLoading === entry.id}
                aria-expanded={source?.id === entry.id} onClick={() => { if (source?.id === entry.id) setSource(null); else void inspectSource(entry.id); }}>
                <ArrowUpRight size={12} aria-hidden="true" />From {entry.source.conversationTitle}{sourceDeleted ? " · source deleted" : sourceLoading === entry.id ? " · loading…" : ""}
              </button>
              : <span>Added to project</span>}
          </p>
          <p className="project-memory-text">{entry.text}</p>
          <p className="project-memory-reason"><span>Why</span> {entry.reason}</p>
          {source?.id === entry.id && <div className="project-memory-source-preview">
            <strong>Source message · {source.role === "user" ? "You" : "Assistant"}</strong>
            <p>{source.content}</p>
            {source.truncated && <small>Showing the first 4,000 characters.</small>}
          </div>}
          {conversationId && <label className="project-memory-toggle">
            <input type="checkbox" checked={!excluded} aria-disabled={blocked} onChange={(event) => {
              if (blocked) return;
              void mutate({ type: "project.memory.toggle", payload: { projectId, conversationId, expectedRevision: state.revision,
                expectedChatRevision: state.chatRevision, id: entry.id, enabled: event.target.checked } });
            }} />
            Use in this chat
          </label>}
        </li>;
      })}</ul>}
      <button type="button" className="project-memory-link project-memory-preview-toggle" aria-expanded={preview} onClick={() => setPreview(!preview)}>
        {preview ? "Hide" : "Inspect"} included context<ChevronDown size={13} aria-hidden="true" />
      </button>
      {preview && <div className="project-memory-preview">
        <p>{conversationId ? "Context for the next turn in this chat." : "Default context for new chats. Each chat can exclude individual entries."} Refresh to check for changes from other windows.</p>
        <pre tabIndex={0} aria-label="Included project context">{state.context ?? "No rules or decisions are included yet."}</pre>
      </div>}
    </>}
  </section>;
}

export default ProjectMemoryPanel;
