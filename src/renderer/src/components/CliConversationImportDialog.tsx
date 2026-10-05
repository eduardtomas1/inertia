import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, Download, RefreshCw, Search, X } from "lucide-react";
import type { Project, ServerEvent } from "@shared/contracts";
import { cliOmissionText, cliProviderLabel, type CliConversationCandidate, type CliConversationPreview, type CliConversationScan } from "@shared/cli-conversations";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { diagnosticErrorReference } from "../utils/diagnosticNavigation";
import { captureModalFocus, trapModalFocus } from "../utils/modalFocus";
import { IconButton } from "./ui";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import "./CliConversationImportDialog.css";

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const providerFilters = [["all", "All"], ["codex", "Codex"], ["claude", "Claude"]] as const;
const mac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");
const importShortcut = mac ? "Meta+Enter" : "Control+Enter";
const cardLabel = (date: Date): string => date.toLocaleString(undefined, date.getFullYear() === new Date().getFullYear()
  ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
  : { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const scanNote = ({ limited, skipped }: Pick<CliConversationScan, "limited" | "skipped">): string | null => {
  const parts = [
    skipped > 0 ? `${plural(skipped, "conversation")} could not be read` : null,
    limited ? "showing recent conversations only" : null,
  ].filter((part): part is string => part !== null);
  if (!parts.length) return null;
  const sentence = parts.join("; ");
  return `${sentence[0]!.toLocaleUpperCase()}${sentence.slice(1)}.`;
};
const fullLabel = (date: Date): string => date.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
const accessibleName = (item: CliConversationCandidate): string =>
  `${item.title}, ${cliProviderLabel(item.providerId)}, ${fullLabel(new Date(item.updatedAt))}${item.importedConversationId ? ", imported" : ""}`;

export function CliConversationImportDialog({ project, request, disabled = false, onClose, onOpenConversation }: {
  project: Pick<Project, "id" | "name">;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  disabled?: boolean;
  onClose(): void;
  onOpenConversation?(conversationId: string): void;
}): React.JSX.Element {
  const [scan, setScan] = useState<CliConversationScan | null>(null);
  const [preview, setPreview] = useState<CliConversationPreview | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [busy, setBusy] = useState<"scan" | "preview" | "import" | null>(disabled ? null : "scan");
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);
  const epoch = useRef(0);
  const importing = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const searchInput = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLDivElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const returnFocusId = useRef<string | null>(null);
  const idPrefix = useId();
  const openTitleId = useId();
  useNativePreviewSuspension(true);
  useLayoutEffect(() => captureModalFocus(), []);
  useLayoutEffect(() => { searchInput.current?.focus(); }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (importing.current || disabled) return;
    const generation = ++epoch.current;
    setBusy("scan"); setError(null); setScan(null); setPreview(null); setOpenId(null); setImported(false);
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

  const open = async (id: string): Promise<void> => {
    if (importing.current || disabled) return;
    const generation = ++epoch.current;
    returnFocusId.current = id;
    setOpenId(id); setPreview(null); setImported(false); setError(null); setBusy("preview");
    try {
      const event = await requestRef.current({ type: "conversation.cli.preview", payload: { projectId: project.id, candidateId: id } });
      if (generation !== epoch.current) return;
      if (event.type !== "request.result" || event.result.kind !== "conversation.cli.preview") throw new Error("Could not preview this conversation.");
      setPreview(event.result.preview);
    } catch (cause) {
      if (generation !== epoch.current) return;
      setPreview(null);
      setError(cause instanceof Error ? cause.message : "Could not preview this conversation.");
    } finally { if (generation === epoch.current) setBusy(null); }
  };
  const back = (): void => {
    if (importing.current) return;
    epoch.current += 1;
    setOpenId(null); setPreview(null); setBusy(null); setError(null); setImported(false);
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

  const rows = (scan?.candidates ?? [])
    .filter((item) => (provider === "all" || item.providerId === provider)
      && [item.title, cliProviderLabel(item.providerId), item.opening.user, item.opening.assistant ?? ""].join("\n").toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const cardId = (id: string): string => `${idPrefix}-card-${id}`;
  useLayoutEffect(() => {
    if (openId) { backButton.current?.focus(); return; }
    const id = returnFocusId.current;
    if (!id) return;
    returnFocusId.current = null;
    document.getElementById(`${idPrefix}-card-${id}`)?.focus();
  }, [idPrefix, openId]);
  const onGalleryKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches(".cli-import-card")) return;
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>(".cli-import-card")];
    const index = cards.indexOf(event.target);
    const columns = Math.max(1, Math.round(event.currentTarget.clientWidth / Math.max(1, event.target.offsetWidth)));
    const target = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1
      : event.key === "ArrowDown" ? index + columns : event.key === "ArrowUp" ? index - columns
        : event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : null;
    if (target === null) return;
    event.preventDefault();
    cards[Math.min(Math.max(target, 0), cards.length - 1)]?.focus();
  };

  const openedId = preview?.candidate.importedConversationId && onOpenConversation ? preview.candidate.importedConversationId : null;
  const openChat = (): void => {
    if (!openedId || !onOpenConversation) return;
    onClose();
    onOpenConversation(openedId);
  };
  const runAction = (): void => { if (openedId) openChat(); else void importConversation(); };
  const openCandidate = openId ? scan?.candidates.find((item) => item.id === openId) ?? preview?.candidate ?? null : null;
  const alreadyImported = Boolean(preview?.candidate.importedConversationId);
  const importUnavailable = !preview || Boolean(busy) || disabled || alreadyImported;
  const scanUnavailable = Boolean(busy) || disabled;
  const status = error ? diagnosticErrorReference(error).message : imported ? "Imported." : null;
  const note = scan && busy !== "scan" && !openId ? scanNote(scan) : null;
  const galleryState = busy === "scan" ? "Looking for conversations…"
    : error ? diagnosticErrorReference(error).message
      : scan && !rows.length ? scan.candidates.length ? "No conversations match your search." : "No CLI conversations found." : null;
  return createPortal(
    <div className="dialog-backdrop cli-import-backdrop" role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !importing.current) onClose(); }}>
      <section className="cli-import-dialog" role="dialog" aria-modal="true" aria-label="Import CLI conversations" tabIndex={-1}
        onKeyDown={(event) => {
          trapModalFocus(event, event.currentTarget);
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation();
            if (importing.current) return;
            if (openId) back(); else onClose();
          }
          if (openId && event.key === "Enter" && (mac ? event.metaKey : event.ctrlKey)) { event.preventDefault(); runAction(); }
        }}>
        <div className="cli-import-search">
          <Search size={17} aria-hidden="true" />
          <input ref={searchInput} aria-label="Search CLI conversations" placeholder="Search Codex and Claude Code conversations…" value={query} autoComplete="off"
            onChange={(event) => { setQuery(event.target.value); if (openId) back(); }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" || openId) return;
              const first = gallery.current?.querySelector<HTMLElement>(".cli-import-card");
              if (!first) return;
              event.preventDefault();
              first.focus();
            }} />
          <div className="cli-import-filter" role="group" aria-label="Filter by CLI provider">
            {providerFilters.map(([value, label], index) => <span key={value}>
              {index > 0 && <span aria-hidden="true">·</span>}
              <button type="button" aria-pressed={provider === value} onClick={() => { setProvider(value); if (openId) back(); }}>{label}</button>
            </span>)}
          </div>
          <IconButton label="Scan again" className={busy === "scan" ? "is-scanning" : undefined} aria-disabled={scanUnavailable}
            onClick={() => { if (!scanUnavailable) void refresh(); }}>
            <RefreshCw size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Close CLI import" disabled={busy === "import"} onClick={onClose}><X size={15} aria-hidden="true" /></IconButton>
        </div>
        <div className="cli-import-body">
          {openId && openCandidate ? <div key={openId} className="cli-import-open" role="group" aria-labelledby={openTitleId}>
            <div className="cli-import-open-head">
              <IconButton ref={backButton} label="Back to conversations" disabled={busy === "import"} onClick={back}><ArrowLeft size={15} aria-hidden="true" /></IconButton>
              <h2 id={openTitleId}>{openCandidate.title}</h2>
            </div>
            <div className="cli-import-open-scroll">
              {busy === "preview" ? <p className="cli-import-state" role="status">Loading conversation…</p>
                : preview && <div className="cli-import-messages">
                  {preview.omittedMessages > 0 && <p className="cli-import-omitted">{cliOmissionText({ omitted: preview.omittedMessages, total: preview.omittedMessages + preview.messages.length }, alreadyImported)}</p>}
                  {preview.messages.map((message, index) => <article key={index} className={`cli-import-message is-${message.role}`}
                    aria-label={message.role === "user" ? "You" : cliProviderLabel(preview.candidate.providerId)}>
                    <p>{message.content}</p>
                  </article>)}
                </div>}
            </div>
            <div className="cli-import-actions">
              {status && <p className="cli-import-status" role={error ? "alert" : "status"}>{status}</p>}
              {preview && <button type="button" className={openedId || !alreadyImported ? "primary-button" : "secondary-button"}
                aria-disabled={openedId ? false : importUnavailable} aria-keyshortcuts={importShortcut} onClick={runAction}>
                {openedId ? <ArrowRight size={14} aria-hidden="true" /> : busy === "import" ? <span className="loading-mark" aria-hidden="true" /> : alreadyImported ? <Check size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                {openedId ? "Open chat" : busy === "import" ? "Importing…" : alreadyImported ? "Already imported" : "Import conversation"}
              </button>}
            </div>
          </div>
            : galleryState ? <p className="cli-import-state" role={error ? "alert" : busy === "scan" ? "status" : undefined}>{galleryState}</p>
              : <div ref={gallery} className="cli-import-gallery" role="list" aria-label="CLI conversations" onKeyDown={onGalleryKeyDown}>
                {rows.map((item, index) => {
                  return <div key={item.id} role="listitem" className="cli-import-cell" style={{ "--cli-import-index": Math.min(index, 10) } as React.CSSProperties}>
                    <button type="button" id={cardId(item.id)} className="cli-import-card" aria-label={accessibleName(item)}
                      aria-disabled={disabled} onClick={() => void open(item.id)}>
                      <ProviderBrandIcon providerId={item.providerId} size={56} decorative className="cli-import-card-watermark" />
                      <span className="cli-import-card-title">{item.title}</span>
                      <span className="cli-import-mini" aria-hidden="true">
                        <span className="cli-import-mini-user">{item.opening.user}</span>
                        {item.opening.assistant && <span className="cli-import-mini-reply">{item.opening.assistant}</span>}
                      </span>
                      <span className="cli-import-card-meta">
                        <ProviderBrandIcon providerId={item.providerId} size={16} decorative />
                        <time dateTime={item.updatedAt}>{cardLabel(new Date(item.updatedAt))}</time>
                        {item.importedConversationId && <span>Imported</span>}
                      </span>
                      {item.importedOmission && <span className="cli-import-card-omission">{cliOmissionText(item.importedOmission, true)}</span>}
                    </button>
                  </div>;
                })}
              </div>}
          {note && <p className="cli-import-note">{note}</p>}
        </div>
      </section>
    </div>, document.body,
  );
}
