import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, Download, RefreshCw, Search, TerminalSquare, X } from "lucide-react";
import type { Project, ServerEvent } from "@shared/contracts";
import type { CliConversationPreview, CliConversationScan } from "@shared/cli-conversations";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { diagnosticErrorReference } from "../utils/diagnosticNavigation";
import { captureModalFocus, trapModalFocus } from "../utils/modalFocus";
import { IconButton } from "./ui";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import "./CliConversationImportDialog.css";

const providerLabel = (id: string): string => id === "codex" ? "Codex" : "Claude Code";
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
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
  const titleId = useId();
  const descriptionId = useId();
  const listLabelId = useId();
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
  const alreadyImported = Boolean(preview?.candidate.importedConversationId);
  const importUnavailable = !preview || Boolean(busy) || disabled || alreadyImported;
  const scanUnavailable = Boolean(busy) || disabled;
  return createPortal(
    <div className="dialog-backdrop cli-import-backdrop" role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !importing.current) onClose(); }}>
      <section ref={root} className="cli-import-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
        onKeyDown={(event) => { trapModalFocus(event, event.currentTarget); if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!importing.current) onClose(); } }}>
        <header className="cli-import-header">
          <span className="dialog-icon"><TerminalSquare size={18} aria-hidden="true" /></span>
          <div>
            <h2 id={titleId}>Import CLI conversations</h2>
            <p id={descriptionId}>Codex and Claude Code conversations started in {project.name}.</p>
          </div>
          <IconButton label="Close CLI import" disabled={busy === "import"} onClick={onClose}><X size={16} aria-hidden="true" /></IconButton>
        </header>
        <div className="cli-import-toolbar">
          <label className="cli-import-search">
            <Search size={14} aria-hidden="true" />
            <input aria-label="Search CLI conversations" placeholder="Search conversations" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <select className="cli-import-provider" aria-label="Filter by CLI provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="all">All providers</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
          <button type="button" className="secondary-button cli-import-scan" aria-disabled={scanUnavailable}
            onClick={() => { if (!scanUnavailable) void refresh(); }}>
            <RefreshCw size={14} aria-hidden="true" />Scan again
          </button>
        </div>
        <div className="cli-import-body">
          <aside className="cli-import-list" aria-label="CLI conversations" aria-busy={busy === "scan"}>
            <p id={listLabelId} className="cli-import-list-label">{candidates.length ? plural(candidates.length, "conversation") : "Conversations"}</p>
            {scan?.limited && <p className="cli-import-list-note">Showing recent history only. Older conversations were not scanned.</p>}
            {Boolean(scan?.skipped) && <p className="cli-import-list-note">{plural(scan!.skipped, "file")} skipped: unreadable, unsupported or larger than 16&nbsp;MiB.</p>}
            {busy === "scan" ? <p className="cli-import-list-empty" role="status"><span className="loading-mark" aria-hidden="true" />Looking for conversations…</p>
              : <div className="cli-import-candidates" role="group" aria-labelledby={listLabelId}>
                {candidates.map((item) => <button key={item.id} type="button" className="cli-import-candidate" aria-pressed={selected === item.id}
                  disabled={busy === "import" || disabled} onClick={() => void select(item.id)}>
                  <ProviderBrandIcon providerId={item.providerId} size={16} decorative />
                  <span className="cli-import-candidate-copy">
                    <strong>{item.title}</strong>
                    <span className="cli-import-candidate-meta">
                      {providerLabel(item.providerId)} · <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time>
                      {item.importedConversationId && <> · <span className="cli-import-candidate-imported"><Check size={12} aria-hidden="true" />Imported</span></>}
                    </span>
                  </span>
                </button>)}
              </div>}
            {scan && !candidates.length && <p className="cli-import-list-empty">{scan.candidates.length ? "No conversations match your search." : "No supported conversations found for this project folder. Conversations from other checkouts belong to their own project."}</p>}
          </aside>
          <div className="cli-import-preview" aria-label="Conversation preview" aria-busy={busy === "preview"}>
            {busy === "preview" ? <p className="cli-import-placeholder" role="status"><span className="loading-mark" aria-hidden="true" />Loading preview…</p> : preview ? <>
              <div className="cli-import-preview-heading">
                <h3>{preview.candidate.title}</h3>
                <p>{providerLabel(preview.candidate.providerId)} · {plural(preview.messages.length, "text message")}</p>
              </div>
              <div className="cli-import-messages">
                {preview.omittedMessages > 0 && <p className="cli-import-omitted">{plural(preview.omittedMessages, "earlier message")} not shown. The CLI session keeps its full history.</p>}
                {preview.messages.map((message, index) => <article key={index} className={`cli-import-message is-${message.role}`}>
                  <h4>{message.role === "user" ? "You" : providerLabel(preview.candidate.providerId)}</h4>
                  <p>{message.content}</p>
                </article>)}
              </div>
            </> : <p className="cli-import-placeholder">{scan && !scan.candidates.length ? "Nothing to preview." : "Select a conversation to preview its messages."}</p>}
          </div>
        </div>
        <footer className="cli-import-footer">
          <div className="cli-import-footer-status">
            {error ? <p className="cli-import-error" role="alert"><AlertCircle size={14} aria-hidden="true" />{diagnosticErrorReference(error).message}</p>
              : imported ? <p className="cli-import-success" role="status"><Check size={14} aria-hidden="true" />Imported. Find this conversation in {project.name}’s chat list.</p>
                : <>
                  <p>Continues the original CLI session. Close it in your terminal before sending here.</p>
                  <small>Text history only. Tool output, thinking, and media are not copied. Long messages may be shortened.</small>
                </>}
          </div>
          <button type="button" className={alreadyImported ? "secondary-button" : "primary-button"} aria-disabled={importUnavailable}
            onClick={() => void importConversation()}>
            {busy === "import" ? <span className="loading-mark" aria-hidden="true" /> : alreadyImported ? <Check size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
            {busy === "import" ? "Importing…" : alreadyImported ? "Already imported" : "Import conversation"}
          </button>
        </footer>
      </section>
    </div>, document.body,
  );
}
