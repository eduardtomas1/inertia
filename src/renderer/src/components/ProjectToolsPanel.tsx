import { useEffect, useRef, useState } from "react";
import { Cable, Plus, Pencil, Trash2 } from "lucide-react";
import type { ServerEvent } from "@shared/contracts";
import {
  MAX_PROJECT_TOOLS, PROJECT_TOOL_STATE_LABELS, projectToolDraftSchema, projectToolsViewSchema,
  type ProjectToolDraft, type ProjectToolsView, type ProjectToolView,
} from "@shared/project-tools";
import { RuntimeCommandError } from "../utils/connectionMessages";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import "./ProjectToolsPanel.css";

export interface ProjectToolsPanelProps {
  projectId: string;
  projectName: string;
  conversationId?: string;
  connected: boolean;
  run: (key: string, command: CommandWithoutId, options?: { passive?: boolean; reportError?: boolean }) => Promise<ServerEvent>;
}
const emptyDraft = (): ProjectToolDraft => ({ name: "", url: "", bearerTokenEnv: null, providers: ["claude", "codex"] });

export function ProjectToolsPanel(props: ProjectToolsPanelProps) {
  // Identity changes remount all drafts and pending requests together.
  return <ProjectToolsContent key={`${props.projectId}:${props.conversationId ?? "project"}`} {...props} />;
}

function ProjectToolsContent({ projectId, projectName, conversationId, connected, run }: ProjectToolsPanelProps) {
  const [view, setView] = useState<ProjectToolsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ original: ProjectToolView | null; draft: ProjectToolDraft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  const mounted = useRef(true);
  const addRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (restoreFocus.current && !editor && !busy && view) {
      restoreFocus.current = false;
      (addRef.current?.disabled ? headingRef.current : addRef.current)?.focus();
    }
  }, [editor, busy, view]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!connected) { setView(null); return; }
    const load = async () => {
      try {
        const event = await runRef.current("project-tools-load", {
          type: "project.tools.load", payload: { projectId, ...(conversationId ? { conversationId } : {}) },
        }, { passive: true, reportError: false });
        if (cancelled) return;
        if (event.type !== "request.result" || event.result.kind !== "project.tools") throw new Error("unavailable");
        const result = projectToolsViewSchema.parse(event.result.tools);
        if (result.projectId !== projectId || result.conversationId !== (conversationId ?? null)) throw new Error("identity mismatch");
        setView(result);
        setError((previous) => previous === "Could not refresh tool status. Reconnect or try again." ? null : previous);
      } catch {
        if (!cancelled) {
          setView(null);
          setError("Could not refresh tool status. Reconnect or try again.");
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => { void load(); }, 2_000);
      }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectId, conversationId, connected, refresh]);

  const closeEditor = () => { restoreFocus.current = true; setEditor(null); };
  const mutate = async (command: CommandWithoutId) => {
    setBusy(true);
    setError(null);
    try {
      const event = await runRef.current("project-tools-save", command, { passive: true, reportError: false });
      if (!mounted.current) return;
      if (event.type === "request.error") { setError(event.message); return; }
      if (event.type !== "request.ok") throw new Error("Unexpected result");
      setView(null);
      closeEditor();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof RuntimeCommandError && failure.delivery === "rejected"
        ? failure.message : "Could not confirm the change. Check the refreshed connections before trying again.");
    } finally {
      if (mounted.current) { setBusy(false); setRefresh((value) => value + 1); }
    }
  };
  const save = () => {
    if (!editor) return;
    const parsed = projectToolDraftSchema.safeParse(editor.draft);
    if (!parsed.success) {
      setError("Enter a name, an HTTPS URL (or loopback HTTP), and at least one provider. Use an environment variable name for authentication, never a token.");
      return;
    }
    void mutate({ type: "project.tools.save", payload: {
      projectId, connection: parsed.data,
      ...(editor.original ? { id: editor.original.id, revision: editor.original.revision } : {}),
    } });
  };

  return <section className="project-tools-panel" aria-label="Project tools">
    <header className="project-tools-heading">
      <span className="project-tools-symbol"><Cable size={20} aria-hidden="true" /></span>
      <div><h2 ref={headingRef} tabIndex={-1}>Project tools</h2><p>{projectName}</p></div>
    </header>
    <p className="project-tools-intro">Connect once. Use with Claude and Codex in this project.</p>
    <div className="project-tools-scope">
      <strong>{conversationId ? "Status for this chat" : "Project configuration"}</strong>
      <p>{conversationId ? "Availability is confirmed by this chat’s running agent. Each new run checks again." : "Open a chat and send a message to check which tools its agent can use."}</p>
    </div>
    {!connected && <p role="status" className="project-tools-notice">Reconnect to Inertia to view or change tool connections.</p>}
    {error && <p role="alert" className="project-tools-error">{error}</p>}
    {connected && !view && !error && <p role="status">Loading connections…</p>}
    {connected && view && <div className="project-tools-list">
      {view.connections.length === 0 && !editor && <div className="project-tools-empty"><strong>No connections yet</strong><p>Add a Streamable HTTP MCP server to share its tools across this project’s chats.</p></div>}
      {view.connections.map((connection) => <article key={connection.id} className="project-tool-card" aria-label={connection.name}>
        <div className="project-tool-title"><h3>{connection.name}</h3><span className={`project-tool-status is-${connection.state}`}>{PROJECT_TOOL_STATE_LABELS[connection.state]}</span></div>
        <p className="project-tool-url">{connection.url}</p>
        <div className="project-tool-providers">{connection.providers.map((provider) => <span key={provider}>{provider === "claude" ? "Claude" : "Codex"}</span>)}<span>HTTP</span></div>
        <p className="project-tool-reason">{connection.reason}</p>
        {connection.toolNames.length > 0 && <details open className="project-tool-names"><summary>{connection.toolNames.length} available {connection.toolNames.length === 1 ? "tool" : "tools"}</summary><ul>{connection.toolNames.map((name) => <li key={name}><code>{name}</code></li>)}</ul></details>}
        {connection.bearerTokenEnv && <p className="project-tool-auth">Token from <code>{connection.bearerTokenEnv}</code></p>}
        <div className="project-tool-actions">
          <button type="button" disabled={busy || !!editor} onClick={() => { setError(null); setEditor({ original: connection, draft: { name: connection.name, url: connection.url, providers: [...connection.providers], bearerTokenEnv: connection.bearerTokenEnv } }); }}><Pencil size={13} aria-hidden="true" />Edit<span className="sr-only"> {connection.name}</span></button>
          <button type="button" disabled={busy || !!editor} onClick={() => { void mutate({ type: "project.tools.remove", payload: { projectId, id: connection.id, revision: connection.revision } }); }}><Trash2 size={13} aria-hidden="true" />Remove<span className="sr-only"> {connection.name}</span></button>
        </div>
      </article>)}
    </div>}
    {editor && <form className="project-tools-editor" aria-label={editor.original ? "Edit connection" : "New connection"} onSubmit={(event) => { event.preventDefault(); save(); }}>
      <h3>{editor.original ? "Edit connection" : "New connection"}</h3>
      <fieldset disabled={busy || !connected}>
        <label>Name<input autoFocus required maxLength={80} value={editor.draft.name} placeholder="Project documentation" onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, name: event.target.value } })} /></label>
        <label>Server URL<input required type="url" maxLength={2048} value={editor.draft.url} placeholder="https://tools.example.com/mcp" onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, url: event.target.value } })} /></label>
        <p className="project-tools-field-help">HTTPS or loopback HTTP. No credentials, query parameters or environment templates in the URL.</p>
        <label>Bearer token environment variable <span>(optional)</span><input maxLength={128} value={editor.draft.bearerTokenEnv ?? ""} placeholder="INERTIA_MCP_DOCS_TOKEN" autoComplete="off" spellCheck={false} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, bearerTokenEnv: event.target.value || null } })} /></label>
        <p className="project-tools-field-help">Use a name starting with INERTIA_MCP_, not its value. Set it in the environment that launches Inertia; restart Inertia after changing it.</p>
        <fieldset className="project-tools-provider-picker"><legend>Use with</legend>{(["claude", "codex"] as const).map((provider) => <label key={provider}><input type="checkbox" checked={editor.draft.providers.includes(provider)} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, providers: event.target.checked ? [...editor.draft.providers, provider] : editor.draft.providers.filter((value) => value !== provider) } })} />{provider === "claude" ? "Claude" : "Codex"}</label>)}</fieldset>
        <p className="project-tools-field-help">Changes apply on the next message. A running agent keeps its original connections.</p>
      </fieldset>
      <div className="project-tools-editor-actions"><button type="button" disabled={busy} onClick={closeEditor}>Cancel</button><button type="submit" className="project-tools-save" disabled={busy || !connected}>{busy ? "Saving…" : "Save connection"}</button></div>
    </form>}
    <button type="button" className="project-tools-add" ref={addRef} disabled={!connected || busy || !!editor || !view || view.connections.length >= MAX_PROJECT_TOOLS} onClick={() => { setError(null); setEditor({ original: null, draft: emptyDraft() }); }}><Plus size={15} aria-hidden="true" />Add connection</button>
    <footer className="project-tools-compatibility"><strong>Supported connections</strong><p>Streamable HTTP with no authentication or an environment-based bearer token. Claude Code’s native SDK and Codex’s app server only.</p><p>Local command servers, legacy SSE, OAuth sign-in and other agents are not supported yet. Terminal MCP settings are not imported. Update your agent if it cannot report this chat’s tools.</p><p>Only connect servers you trust. Their tools follow the chat’s existing approval mode.</p></footer>
  </section>;
}
