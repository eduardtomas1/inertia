import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, CircleSlash, Clock, KeyRound, Plus, RotateCcw } from "lucide-react";
import type { ServerEvent } from "@shared/contracts";
import {
  MAX_PROJECT_TOOLS, PROJECT_TOOL_STATE_LABELS, projectToolDraftSchema, projectToolsViewSchema,
  type ProjectToolDraft, type ProjectToolState, type ProjectToolsView, type ProjectToolView,
} from "@shared/project-tools";
import { RuntimeCommandError } from "../utils/connectionMessages";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import "./WorkspaceSurfaces.css";
import "./ProjectToolsPanel.css";

export interface ProjectToolsPanelProps {
  projectId: string;
  projectName: string;
  conversationId?: string;
  connected: boolean;
  run: (key: string, command: CommandWithoutId, options?: { passive?: boolean; reportError?: boolean }) => Promise<ServerEvent>;
}
const emptyDraft = (): ProjectToolDraft => ({ name: "", url: "", bearerTokenEnv: null, providers: ["claude", "codex"] });
const REFRESH_ERROR = "Could not refresh tool status. Reconnect or try again.";
const providerLabel = (provider: "claude" | "codex") => provider === "claude" ? "Claude" : "Codex";
const STATE_ICONS: Record<ProjectToolState, React.JSX.Element> = {
  configured: <Clock size={13} aria-hidden="true" />,
  available: <CheckCircle2 size={13} aria-hidden="true" />,
  "needs-auth": <KeyRound size={13} aria-hidden="true" />,
  "needs-restart": <RotateCcw size={13} aria-hidden="true" />,
  unavailable: <AlertCircle size={13} aria-hidden="true" />,
  unsupported: <CircleSlash size={13} aria-hidden="true" />,
};

export function ProjectToolsPanel(props: ProjectToolsPanelProps) {
  // Identity changes remount all drafts and pending requests together.
  return <ProjectToolsContent key={`${props.projectId}:${props.conversationId ?? "project"}`} {...props} />;
}

function ProjectToolsContent({ projectId, projectName, conversationId, connected, run }: ProjectToolsPanelProps) {
  const [view, setView] = useState<ProjectToolsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorFor, setErrorFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ original: ProjectToolView | null; draft: ProjectToolDraft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  const mounted = useRef(true);
  const addRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const ids = useId();
  useEffect(() => {
    if (restoreFocus.current && !editor && !busy && view) {
      restoreFocus.current = false;
      addRef.current?.focus();
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
        setError((previous) => previous === REFRESH_ERROR ? null : previous);
      } catch {
        if (!cancelled) {
          setView(null);
          setError(REFRESH_ERROR);
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
    if (!editor || busy || !connected) return;
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
  const draft = (change: Partial<ProjectToolDraft>) => { if (editor && !busy) setEditor({ ...editor, draft: { ...editor.draft, ...change } }); };
  const addUnavailable = !connected || busy || !!editor || !view || view.connections.length >= MAX_PROJECT_TOOLS;
  const rowUnavailable = busy || !!editor;
  const count = view?.connections.length ?? 0;
  const errorNode = error && <p className="project-tools-error" role={error === REFRESH_ERROR ? "status" : "alert"}>
    <AlertCircle size={14} aria-hidden="true" /><span>{error}</span>
  </p>;
  const errorPlacement = error === REFRESH_ERROR ? "top" : editor ? "editor" : errorFor && view?.connections.some(({ id }) => id === errorFor) ? errorFor : "top";

  const editorForm = editor && <form className="project-tools-editor" aria-labelledby={`${ids}-editor`} onSubmit={(event) => { event.preventDefault(); save(); }}>
    <h3 id={`${ids}-editor`}>{editor.original ? "Edit connection" : "New connection"}</h3>
    <fieldset className="project-tools-fields" disabled={!connected}>
      <label className="project-tools-field">
        <span>Name</span>
        <input autoFocus required maxLength={80} readOnly={busy} value={editor.draft.name} placeholder="Project documentation"
          onChange={(event) => draft({ name: event.target.value })} />
      </label>
      <div className="project-tools-field">
        <label htmlFor={`${ids}-url`}>Server URL</label>
        <input id={`${ids}-url`} required type="url" maxLength={2048} readOnly={busy} value={editor.draft.url}
          placeholder="https://tools.example.com/mcp" aria-describedby={`${ids}-url-help`}
          onChange={(event) => draft({ url: event.target.value })} />
        <p id={`${ids}-url-help`}>HTTPS or loopback HTTP. No credentials, query parameters or environment templates in the URL.</p>
      </div>
      <div className="project-tools-field">
        <label htmlFor={`${ids}-token`}>Bearer token environment variable <span>(optional)</span></label>
        <input id={`${ids}-token`} maxLength={128} readOnly={busy} value={editor.draft.bearerTokenEnv ?? ""}
          placeholder="INERTIA_MCP_DOCS_TOKEN" autoComplete="off" spellCheck={false} aria-describedby={`${ids}-token-help`}
          onChange={(event) => draft({ bearerTokenEnv: event.target.value || null })} />
        <p id={`${ids}-token-help`}>Use a name starting with INERTIA_MCP_, not its value. Set it in the environment that launches Inertia; restart Inertia after changing it.</p>
      </div>
      <fieldset className="project-tools-providers" aria-describedby={`${ids}-providers-help`}>
        <legend>Use with</legend>
        <div>
          {(["claude", "codex"] as const).map((provider) => <label key={provider}>
            <input type="checkbox" checked={editor.draft.providers.includes(provider)}
              onChange={(event) => draft({ providers: event.target.checked
                ? [...editor.draft.providers, provider]
                : editor.draft.providers.filter((value) => value !== provider) })} />
            {providerLabel(provider)}
          </label>)}
        </div>
        <p id={`${ids}-providers-help`}>Changes apply on the next message. A running agent keeps its original connections.</p>
      </fieldset>
    </fieldset>
    {errorPlacement === "editor" && errorNode}
    <div className="project-tools-editor-actions">
      <button type="button" className="workspace-surface-button" disabled={busy} onClick={closeEditor}>Cancel</button>
      <button type="submit" className="project-tools-save" aria-disabled={busy || !connected}>
        <span data-active={!busy} aria-hidden={busy}>Save connection</span>
        <span data-active={busy} aria-hidden={!busy}>Saving…</span>
      </button>
    </div>
  </form>;

  return <section className="workspace-surface project-tools-surface" aria-label="Project tools">
    <div className="workspace-surface-scroll">
      {!connected && <div className="workspace-surface-attention is-offline" role="status">
        <AlertCircle size={14} aria-hidden="true" />
        <span><strong>Workspace runtime unavailable</strong><small>Reconnect to view or change tool connections.</small></span>
      </div>}
      <div className="project-tools-intro">
        <div className="project-tools-toolbar">
          <h2 id={`${ids}-label`} className="project-tools-label">
            Connections{count > 0 && <> <span className="project-tools-count">{count}</span></>}
          </h2>
          <button type="button" className="workspace-surface-button project-tools-add" ref={addRef} aria-disabled={addUnavailable}
            onClick={() => { if (addUnavailable) return; setError(null); setErrorFor(null); setEditor({ original: null, draft: emptyDraft() }); }}>
            <Plus size={14} aria-hidden="true" />Add connection
          </button>
        </div>
        <p className="project-tools-scope">
          Shared by every chat in {projectName}. {conversationId
            ? "This chat’s running agent confirms which tools it can use; each new run checks again."
            : "Open a chat and send a message to check which tools its agent can use."}
        </p>
      </div>
      {errorPlacement === "top" && errorNode}
      {connected && !view && !error && <p className="project-tools-empty" role="status">Loading connections…</p>}
      {editor && !editor.original && editorForm}
      {connected && view && view.connections.length === 0 && !editor && <p className="project-tools-empty">
        No connections. Add a Streamable HTTP MCP server to share its tools with this project’s chats.
      </p>}
      {connected && view && view.connections.length > 0 && <ul className="project-tools-list" aria-labelledby={`${ids}-label`}>
        {view.connections.map((connection) => <li key={connection.id}>
          {editor?.original?.id === connection.id ? editorForm : <article className="project-tool-card" aria-label={connection.name}>
            <h3 className="project-tool-title">{connection.name}</h3>
            <p className={`project-tool-status is-${connection.state}`}>
              {STATE_ICONS[connection.state]}{PROJECT_TOOL_STATE_LABELS[connection.state]}
            </p>
            <p className="project-tool-meta">
              <span className="project-tool-providers">{connection.providers.map(providerLabel).join(" and ")}</span>
              <span aria-hidden="true">·</span>
              <span className="project-tool-url" title={connection.url}>{connection.url}</span>
            </p>
            {connection.bearerTokenEnv && <p className="project-tool-auth">Token from <code>{connection.bearerTokenEnv}</code></p>}
            <p className="project-tool-reason">{connection.reason}</p>
            {connection.toolNames.length > 0 && <details open className="project-tool-names">
              <summary>
                <ChevronRight size={13} aria-hidden="true" />
                {connection.toolNames.length} available {connection.toolNames.length === 1 ? "tool" : "tools"}
              </summary>
              <ul>{connection.toolNames.map((name) => <li key={name}><code>{name}</code></li>)}</ul>
            </details>}
            {errorPlacement === connection.id && errorNode}
            <div className="project-tool-actions">
              <button type="button" className="project-tool-link" aria-disabled={rowUnavailable} onClick={() => {
                if (rowUnavailable) return;
                setError(null); setErrorFor(null);
                setEditor({ original: connection, draft: { name: connection.name, url: connection.url, providers: [...connection.providers], bearerTokenEnv: connection.bearerTokenEnv } });
              }}>Edit<span className="sr-only"> {connection.name}</span></button>
              <button type="button" className="project-tool-link" aria-disabled={rowUnavailable} onClick={() => {
                if (rowUnavailable) return;
                setErrorFor(connection.id);
                void mutate({ type: "project.tools.remove", payload: { projectId, id: connection.id, revision: connection.revision } });
              }}>Remove<span className="sr-only"> {connection.name}</span></button>
            </div>
          </article>}
        </li>)}
      </ul>}
      <footer className="project-tools-compatibility">
        <h2 className="project-tools-label">Supported connections</h2>
        <p>Streamable HTTP with no authentication or an environment-based bearer token. Claude Code’s native SDK and Codex’s app server only.</p>
        <p>Local command servers, legacy SSE, OAuth sign-in and other agents are not supported yet. Terminal MCP settings are not imported. Update your agent if it cannot report this chat’s tools.</p>
        <p>Only connect servers you trust. Their tools follow the chat’s existing approval mode.</p>
      </footer>
    </div>
  </section>;
}
