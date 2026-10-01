import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Download, RefreshCw, Search, TerminalSquare, X } from "lucide-react";
import type { Project, ServerEvent } from "@shared/contracts";
import type { CliConversationPreview, CliConversationScan } from "@shared/cli-conversations";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../utils/modalFocus";
import { IconButton } from "./ui";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import "./CliConversationImportDialog.css";

const providerLabel = (id: string): string => id === "codex" ? "Codex" : "Claude Code";
export function CliConversationImportDialog({ project, request, disabled = false, onClose }: {
  project: Pick<Project, "id" | "name">;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  disabled?: boolean;
  onClose(): void;
}): React.JSX.Element {
  const [scan, setScan] = useState<CliConversationScan | null>(null);
  const [preview, setPreview] = useState<CliConversationPreview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [busy, setBusy] = useState<"scan" | "preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);
  const root = useRef<HTMLElement>(null);
  const epoch = useRef(0);
  const importing = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  useNativePreviewSuspension(true);
  useLayoutEffect(() => captureModalFocus(), []);
  useLayoutEffect(() => { root.current?.focus(); }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (importing.current || disabled) return;
    const generation = ++epoch.current;
    setBusy("scan"); setError(null); setScan(null); setPreview(null); setSelected(null); setImported(false);
    try {
      const event = await requestRef.current({ type: "conversation.cli.scan", payload: { projectId: project.id } });
      if (generation !== epoch.current) return;
      if (event.type !== "request.result" || event.result.kind !== "conversation.cli.scan") throw new Error("Could not load CLI conversations. Try scanning again.");
      setScan(event.result.scan);
    } catch (cause) {
      if (generation === epoch.current) setError(cause instanceof Error ? cause.message : "Could not scan CLI conversations.");
    } finally { if (generation === epoch.current) setBusy(null); }
  }, [project.id, disabled]);
  useEffect(() => {
    void refresh();
    return () => { epoch.current += 1; };
  }, [refresh]);

  const select = async (id: string): Promise<void> => {
    if (importing.current || disabled) return;
    const generation = ++epoch.current;
    setSelected(id); setPreview(null); setImported(false); setBusy("preview"); setError(null);
    try {
      const event = await requestRef.current({ type: "conversation.cli.preview", payload: { projectId: project.id, candidateId: id } });
      if (generation !== epoch.current) return;
      if (event.type !== "request.result" || event.result.kind !== "conversation.cli.preview") throw new Error("Could not preview this conversation.");
      setPreview(event.result.preview);
    } catch (cause) {
      if (generation === epoch.current) setError(cause instanceof Error ? cause.message : "Could not preview this conversation.");
    } finally { if (generation === epoch.current) setBusy(null); }
  };
  const importConversation = async (): Promise<void> => {
    if (!preview || busy || importing.current || disabled || preview.candidate.importedConversationId) return;
    importing.current = true;
    const generation = ++epoch.current;
    setBusy("import"); setError(null);
    try {
      const event = await requestRef.current({ type: "conversation.cli.import", payload: { projectId: project.id, candidateId: preview.candidate.id, revision: preview.revision } });
      if (generation !== epoch.current) return;
      if (event.type !== "request.result" || event.result.kind !== "conversation.cli.imported") throw new Error("The import result is unavailable. Scan again to check whether it completed.");
      const next = { ...preview.candidate, importedConversationId: event.result.conversationId };
      setPreview({ ...preview, candidate: next });
      setScan((current) => current ? { ...current, candidates: current.candidates.map((item) => item.id === next.id ? next : item) } : current);
      setImported(true);
    } catch (cause) {
      if (generation === epoch.current) setError(cause instanceof Error ? cause.message : "Could not import this conversation. Scan again to check its status.");
    } finally { importing.current = false; if (generation === epoch.current) setBusy(null); }
  };
  const candidates = (scan?.candidates ?? []).filter((item) => (provider === "all" || item.providerId === provider)
    && `${item.title} ${providerLabel(item.providerId)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="palette-backdrop cli-import-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !importing.current) onClose(); }}>
    <section ref={root} className="cli-import-dialog" role="dialog" aria-modal="true" aria-label="Import CLI conversations" tabIndex={-1}
      onKeyDown={(event) => { trapModalFocus(event, event.currentTarget); if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!importing.current) onClose(); } }}>
      <header className="cli-import-header"><span className="cli-import-icon"><TerminalSquare size={22} /></span><div><h2>Bring your conversations along</h2><p>Import Codex and Claude Code history into {project.name}.</p></div><IconButton label="Close CLI import" disabled={busy === "import"} onClick={onClose}><X size={18} /></IconButton></header>
      <div className="cli-import-toolbar"><label className="cli-import-search"><Search size={15} /><input aria-label="Search CLI conversations" placeholder="Search conversations…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <select aria-label="Filter by CLI provider" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">All providers</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select>
        <button type="button" className="secondary-button" disabled={Boolean(busy) || disabled} onClick={() => void refresh()}><RefreshCw size={14} />Scan again</button></div>
      {error && <p className="cli-import-notice is-error" role="alert">{error}</p>}
      {scan?.limited && <p className="cli-import-notice">Showing a bounded scan of recent local history. Some conversations were not scanned.</p>}
      {Boolean(scan?.skipped) && <p className="cli-import-notice">{scan!.skipped} unreadable, unsupported, or oversized files skipped. Individual files must be 16 MiB or smaller.</p>}
      <div className="cli-import-body">
        <aside aria-label="CLI conversations" aria-busy={busy === "scan"}>
          <div className="cli-import-list-label">{scan ? `${candidates.length} conversations` : "Local history"}</div>
          {busy === "scan" ? <p className="cli-import-empty" role="status">Looking for conversations…</p> : candidates.map((item) => <button key={item.id} type="button" className={`cli-import-candidate${selected === item.id ? " is-selected" : ""}`} aria-pressed={selected === item.id} disabled={busy === "import" || disabled} onClick={() => void select(item.id)}>
            <span className="cli-import-candidate-provider"><ProviderBrandIcon providerId={item.providerId} size={15} />{providerLabel(item.providerId)}{item.importedConversationId && <span className="cli-import-badge"><Check size={11} />Imported</span>}</span>
            <strong>{item.title}</strong><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time>
          </button>)}
          {scan && !candidates.length && <p className="cli-import-empty">{scan.candidates.length ? "No conversations match your search." : "No supported conversations found for this project folder. Conversations from other checkouts belong to their own project."}</p>}
        </aside>
        <div className="cli-import-preview" aria-label="Conversation preview" aria-busy={busy === "preview"}>
          {busy === "preview" ? <p className="cli-import-empty" role="status">Loading preview…</p> : preview ? <>
            <div className="cli-import-preview-heading"><span>{providerLabel(preview.candidate.providerId)} · {preview.messages.length} text messages</span><h3>{preview.candidate.title}</h3></div>
            {preview.omittedMessages > 0 && <p className="cli-import-notice">{preview.omittedMessages} earlier messages omitted from this view. The native CLI session retains its history.</p>}
            <div className="cli-import-messages">{preview.messages.map((message, index) => <article key={index} className={`cli-import-message is-${message.role}`}><h4>{message.role === "user" ? "You" : providerLabel(preview.candidate.providerId)}</h4><p>{message.content}</p></article>)}</div>
          </> : <div className="cli-import-placeholder"><TerminalSquare size={32} /><h3>Pick up where you left off</h3><p>Select a conversation to review its text before importing.</p><span>Local history · Original files unchanged</span></div>}
        </div>
      </div>
      <footer className="cli-import-footer"><div>{imported ? <p role="status"><Check size={15} />Imported. Find this conversation in {project.name}’s chat list.</p> : <><p>Continues the original CLI session. Close it in your terminal before sending here.</p><span>Text history only. Tool output, thinking, and media are not copied. Long messages may be shortened.</span></>}</div>
        <button type="button" className="primary-button" disabled={!preview || Boolean(busy) || disabled || Boolean(preview.candidate.importedConversationId)} onClick={() => void importConversation()}>
          {preview?.candidate.importedConversationId ? <Check size={15} /> : <Download size={15} />}{busy === "import" ? "Importing…" : preview?.candidate.importedConversationId ? "Already imported" : "Import conversation"}
        </button></footer>
    </section>
  </div>;
}
