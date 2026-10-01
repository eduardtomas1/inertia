import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Plus, RefreshCw, Trash2, Pencil, ArrowUpRight } from "lucide-react";
import { MAX_PROJECT_MEMORY_ENTRIES, projectMemoryDraftSchema, type ProjectMemoryDraft, type ProjectMemoryEntry, type ProjectMemoryState, type ProjectMemorySourcePreview } from "@shared/project-memory";
import type { ProjectMemoryCommand, ProjectMemoryPanelProps } from "./types";
import "./ProjectMemory.css";

const blank: ProjectMemoryDraft = { kind: "rule", title: "", text: "", reason: "" };
type Editor = { id: string; draft: ProjectMemoryDraft; source?: { conversationId: string; messageId: string }; isNew: boolean };

export function ProjectMemoryPanel({ projectId, conversationId, projectName, request, disabled = false, sourceMessage, onBusyChange, onDraftChange }: ProjectMemoryPanelProps): React.JSX.Element {
  const [state, setState] = useState<ProjectMemoryState | null>(null);
  const [source, setSource] = useState<ProjectMemorySourcePreview | null>(null);
  const [sourceLoading, setSourceLoading] = useState<string | null>(null);
  const sourceGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(() => sourceMessage ? {
    id: crypto.randomUUID(), isNew: true,
    draft: { ...blank, kind: "decision", text: sourceMessage.content.slice(0, 1600) },
    source: { conversationId: sourceMessage.conversationId, messageId: sourceMessage.id },
  } : null);
  const pending = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDraftChange?.(editor !== null); }, [editor, onDraftChange]);
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
      if (mounted.current && generation.current === own) setError(cause instanceof Error ? cause.message : "Project memory could not be loaded.");
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
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Project memory could not be saved. Your draft is still here.");
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
      if (mounted.current && sourceGeneration.current === own) setError(cause instanceof Error ? cause.message : "The source could not be loaded.");
    } finally {
      if (mounted.current && sourceGeneration.current === own) setSourceLoading(null);
    }
  };
  const blocked = busy || disabled || !state;
  const edit = (entry: ProjectMemoryEntry): void => setEditor({ id: entry.id, isNew: false,
    draft: { kind: entry.kind, title: entry.title, text: entry.text, reason: entry.reason } });
  const change = (field: keyof ProjectMemoryDraft, value: string): void => setEditor((current) => current
    ? { ...current, draft: { ...current.draft, [field]: value } } : null);
  return <section className="project-memory" aria-label="Project rules and decisions">
    <header className="project-memory-heading">
      <div><span className="project-memory-eyebrow">{projectName}</span><h2><BookOpen size={18} />Rules & decisions</h2>
        <p>Keep the conventions and the reasons behind your choices available to every provider.</p></div>
      <button type="button" className="secondary-button" disabled={busy || disabled} onClick={() => void refresh()} aria-label="Refresh project memory"><RefreshCw size={14} /></button>
    </header>
    <p className="project-memory-help">Included when the next turn starts, including queued work. Running turns and their follow-ups keep their original context. Earlier context remains in the provider's history.</p>
    {disabled && <p role="status">Reconnect to load or change project memory.</p>}
    {error && <p className="project-memory-error" role="alert">{error}</p>}
    {!state && !error && !disabled && <p role="status">Loading project memory…</p>}
    {state && <>
      <div className="project-memory-toolbar"><span>{state.entries.length} / {MAX_PROJECT_MEMORY_ENTRIES} entries{conversationId && ` · ${state.entries.length - state.disabledIds.length} enabled in this chat`}</span>
        <button type="button" className="secondary-button" disabled={blocked || editor !== null || state.entries.length >= MAX_PROJECT_MEMORY_ENTRIES}
          onClick={() => setEditor({ id: crypto.randomUUID(), isNew: true, draft: { ...blank } })}><Plus size={14} />Add entry</button></div>
      {!editor && state.entries.length === 0 && <div className="project-memory-empty"><BookOpen size={24} /><h3>A little context goes a long way</h3>
        <p>Save a test command, a project convention, or a decision worth keeping. Use Remember on a chat message to keep its source.</p></div>}
      {editor && <form className="project-memory-editor" onSubmit={(event) => {
        event.preventDefault();
        if (blocked || !projectMemoryDraftSchema.safeParse(editor.draft).success) return;
        void mutate({ type: "project.memory.save", payload: { ...scope, id: editor.id, expectedRevision: state.revision,
          mode: editor.isNew ? "create" : "update", entry: editor.draft, ...(editor.source ? { source: editor.source } : {}) } }, () => setEditor(null));
      }}>
        <h3>{editor.isNew ? "Remember for this project" : "Edit entry"}</h3>
        <fieldset disabled={blocked}>
          <div className="project-memory-fields"><label>Type<select value={editor.draft.kind} onChange={(event) => change("kind", event.target.value)}><option value="rule">Rule</option><option value="decision">Decision</option></select></label>
            <label>Title<input autoFocus required maxLength={120} value={editor.draft.title} onChange={(event) => change("title", event.target.value)} placeholder="Keep the billing snapshot" /></label></div>
          <label>Rule or decision<textarea aria-label="Rule or decision" required maxLength={1600} rows={4} value={editor.draft.text} onChange={(event) => change("text", event.target.value)} placeholder="Use the saved proration context when calculating invoices." /></label>
          <label>Why it matters<textarea aria-label="Why it matters" required maxLength={1200} rows={3} value={editor.draft.reason} onChange={(event) => change("reason", event.target.value)} placeholder="Reading billing events directly misses plan changes from the previous cycle." /></label>
        </fieldset>
        {editor.source && <p className="project-memory-help">The source message will stay linked. Review the excerpt and add the reason before saving.</p>}
        <footer><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditor(null)}>Cancel</button>
          <button type="submit" className="primary-button" disabled={blocked || !projectMemoryDraftSchema.safeParse(editor.draft).success}>{busy ? "Saving…" : "Save entry"}</button></footer>
      </form>}
      <ul className="project-memory-list">{state.entries.map((entry) => <li key={entry.id} className={state.disabledIds.includes(entry.id) ? "is-excluded" : undefined}>
        <div className="project-memory-entry-heading"><span className="project-memory-kind">{entry.kind}</span><h3>{entry.title}</h3>
          <button type="button" className="icon-button" aria-label={`Edit ${entry.title}`} disabled={blocked || editor !== null} onClick={() => edit(entry)}><Pencil size={13} /></button>
          <button type="button" className="icon-button" aria-label={`Delete ${entry.title}`} disabled={blocked || editor !== null} onClick={() => {
            if (window.confirm(`Delete “${entry.title}” from this project's memory? Past turns keep their recorded context.`)) {
              void mutate({ type: "project.memory.delete", payload: { ...scope, expectedRevision: state.revision, id: entry.id } });
            }
          }}><Trash2 size={13} /></button></div>
        <p className="project-memory-text">{entry.text}</p><div className="project-memory-reason"><strong>Why</strong><p>{entry.reason}</p></div>
        <div className="project-memory-entry-footer">{entry.source ? <button type="button" className="project-memory-source" disabled={disabled || state.unavailableSourceIds.includes(entry.id) || sourceLoading === entry.id}
          aria-expanded={source?.id === entry.id} onClick={() => { if (source?.id === entry.id) setSource(null); else void inspectSource(entry.id); }}>
          <ArrowUpRight size={12} />From {entry.source.conversationTitle}{state.unavailableSourceIds.includes(entry.id) ? " · source deleted" : sourceLoading === entry.id ? " · loading…" : ""}</button> : <span className="project-memory-source">Added to project</span>}
          {conversationId && <label className="project-memory-toggle"><input type="checkbox" checked={!state.disabledIds.includes(entry.id)} disabled={blocked}
            onChange={(event) => void mutate({ type: "project.memory.toggle", payload: { projectId, conversationId, expectedRevision: state.revision,
              expectedChatRevision: state.chatRevision, id: entry.id, enabled: event.target.checked } })} />Use in this chat</label>}</div>
        {source?.id === entry.id && <div className="project-memory-source-preview"><strong>Source message · {source.role === "user" ? "You" : "Assistant"}</strong>
          <p>{source.content}</p>{source.truncated && <small>Showing the first 4,000 characters.</small>}</div>}
      </li>)}</ul>
      <button type="button" className="project-memory-preview-toggle secondary-button" aria-expanded={preview} onClick={() => setPreview(!preview)}>{preview ? "Hide" : "Inspect"} included context</button>
      {preview && <div className="project-memory-preview"><p>{conversationId ? "Context for the next turn in this chat." : "Default context for new chats. Each chat can exclude individual entries."} Refresh to check for changes from other windows.</p>
        <pre aria-label="Included project context">{state.context ?? "No project memory is included yet."}</pre></div>}
    </>}
  </section>;
}

export default ProjectMemoryPanel;
