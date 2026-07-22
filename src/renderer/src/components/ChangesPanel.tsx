import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { CircleHelp, FileCode2, GitCompareArrows, MessageSquarePlus, RefreshCw, RotateCcw, Sparkles, WandSparkles, X } from "lucide-react";
import type { ChangedFile, DiffFile, DiffHunk, DiffReviewSummary, GitDiffSnapshot } from "@shared/contracts";
import { parseUnifiedDiff, selectedDiffReference } from "@shared/diff-review";
import { IconButton, LoadingMark } from "./ui";

export type DiffSelection = {
  fingerprint: string;
  file: DiffFile;
  hunk: DiffHunk;
  lineIds: string[];
  reference: string;
};

export type ChangesPanelProps = {
  files: ChangedFile[];
  diff: GitDiffSnapshot | null;
  selectedPath: string | null;
  summary: DiffReviewSummary | null;
  loading?: boolean;
  summaryLoading?: boolean;
  wrapLines?: boolean;
  onSelectFile: (path: string) => void;
  onRefresh?: () => void;
  onGenerateSummary?: () => Promise<void>;
  onAsk: (selection: DiffSelection, comment: string) => Promise<void>;
  onRequestRevision: (selection: DiffSelection, comment: string) => Promise<void>;
  onRevert: (selection: DiffSelection, comment: string) => Promise<void>;
  onAddToPrompt: (selection: DiffSelection) => void;
};

type ReviewAction = "ask" | "revise" | "revert";

function pathParts(path: string): { name: string; parent: string } {
  const parts = path.split(/[\\/]/);
  return { name: parts.at(-1) ?? path, parent: parts.slice(0, -1).join("/") };
}

function statusLabel(file: ChangedFile): string {
  const status = file.status.trim().toLowerCase();
  if (file.untracked || status === "??" || status === "untracked") return "Untracked";
  if (status === "a" || status === "added") return "Added";
  if (status === "d" || status === "deleted") return "Deleted";
  if (status === "r" || status === "renamed") return "Renamed";
  if (status === "c" || status === "copied") return "Copied";
  if (["u", "aa", "dd", "unmerged", "conflict"].includes(status)) return "Conflict";
  if (status === "t" || status === "type-changed") return "Type changed";
  if (status === "unknown") return "Unknown";
  return "Modified";
}

function statusCode(file: ChangedFile): string {
  const label = statusLabel(file);
  if (label === "Untracked") return "U";
  if (label === "Conflict") return "!";
  if (label === "Type changed") return "T";
  if (label === "Unknown") return "?";
  return label.charAt(0);
}

function actionLabel(action: ReviewAction): string {
  if (action === "ask") return "Ask agent";
  if (action === "revise") return "Request revision";
  return "Revert selected lines";
}

export function ChangesPanel({
  files,
  diff,
  selectedPath,
  summary,
  loading = false,
  summaryLoading = false,
  wrapLines = true,
  onSelectFile,
  onRefresh,
  onGenerateSummary,
  onAsk,
  onRequestRevision,
  onRevert,
  onAddToPrompt,
}: ChangesPanelProps): React.JSX.Element {
  const [selection, setSelection] = useState<{ hunkId: string; anchor: number; lineIds: string[] } | null>(null);
  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const structured = useMemo(() => parseUnifiedDiff(diff?.patch ?? ""), [diff?.patch]);
  const selectedFile = selectedPath
    ? structured.files.find((file) => file.path === selectedPath) ?? null
    : structured.files[0] ?? null;
  const activeSummary = summary?.fingerprint === structured.fingerprint ? summary : null;
  const fileSummary = activeSummary?.files.find((item) => item.path === selectedFile?.path) ?? null;
  const totals = useMemo(() => files.reduce(
    (result, file) => ({ insertions: result.insertions + file.insertions, deletions: result.deletions + file.deletions }),
    { insertions: 0, deletions: 0 },
  ), [files]);

  useEffect(() => {
    setSelection(null);
    setReviewAction(null);
    setComment("");
  }, [structured.fingerprint, selectedPath]);

  const clearSelection = () => { setSelection(null); setReviewAction(null); setComment(""); };
  const chooseLine = (hunk: DiffHunk, index: number, extend: boolean) => {
    const start = extend && selection?.hunkId === hunk.id ? Math.min(selection.anchor, index) : index;
    const end = extend && selection?.hunkId === hunk.id ? Math.max(selection.anchor, index) : index;
    setSelection({ hunkId: hunk.id, anchor: extend && selection?.hunkId === hunk.id ? selection.anchor : index, lineIds: hunk.lines.slice(start, end + 1).filter((line) => line.kind !== "meta").map((line) => line.id) });
    setReviewAction(null);
    setComment("");
  };
  const reviewSelection = (file: DiffFile, hunk: DiffHunk): DiffSelection | null => {
    if (!selection || selection.hunkId !== hunk.id || selection.lineIds.length === 0) return null;
    return {
      fingerprint: structured.fingerprint,
      file,
      hunk,
      lineIds: selection.lineIds,
      reference: selectedDiffReference(file, hunk, selection.lineIds),
    };
  };
  const submit = async (file: DiffFile, hunk: DiffHunk) => {
    const selected = reviewSelection(file, hunk);
    if (!selected || !reviewAction || submitting) return;
    setSubmitting(true);
    try {
      if (reviewAction === "ask") await onAsk(selected, comment);
      if (reviewAction === "revise") await onRequestRevision(selected, comment);
      if (reviewAction === "revert") await onRevert(selected, comment);
      clearSelection();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="changes-panel" aria-label="Workspace changes" aria-busy={loading}>
      <header className="panel-toolbar">
        <div className="panel-heading">
          <GitCompareArrows size={17} aria-hidden="true" />
          <div className="panel-heading-copy"><h2>Changes</h2><span>{files.length} {files.length === 1 ? "file" : "files"}</span></div>
        </div>
        <div className="panel-stats" aria-label={`${totals.insertions} insertions and ${totals.deletions} deletions`}>
          <span className="stat-additions">+{totals.insertions}</span><span className="stat-deletions">−{totals.deletions}</span>
          {onGenerateSummary && files.length > 0 && (
            <IconButton label={activeSummary ? "Refresh agent summaries" : "Summarize changes"} onClick={() => void onGenerateSummary()} disabled={summaryLoading || loading}>
              {summaryLoading ? <LoadingMark label="Summarizing changes" /> : <Sparkles size={15} />}
            </IconButton>
          )}
          {onRefresh && <IconButton label="Refresh changes" onClick={onRefresh} disabled={loading}>{loading ? <LoadingMark label="Refreshing changes" /> : <RefreshCw size={15} />}</IconButton>}
        </div>
      </header>

      {activeSummary && <div className="diff-overall-summary"><Sparkles size={14} /><span><strong>Change summary</strong>{activeSummary.overall}</span></div>}

      {files.length === 0 ? (
        <div className="panel-empty changes-empty"><GitCompareArrows size={22} /><h3>No local changes</h3><p>Edits made in this workspace will appear here.</p></div>
      ) : (
        <div className="changes-layout">
          <div className="changes-file-picker"><span>Reviewing</span><select aria-label="Changed file" value={selectedPath ?? files[0]?.path ?? ""} onChange={(event) => { clearSelection(); onSelectFile(event.target.value); }}>{files.map((file) => <option value={file.path} key={file.path}>{statusCode(file)} · {file.path}</option>)}</select></div>
          <nav className="changes-file-list" aria-label="Changed files">
            {files.map((file) => {
              const parts = pathParts(file.path);
              return <button type="button" className={clsx("change-file-button", file.path === selectedPath && "is-selected")} aria-pressed={file.path === selectedPath} onClick={() => { clearSelection(); onSelectFile(file.path); }} key={file.path}>
                <span className="change-file-leading"><FileCode2 size={15} /><span className="change-file-status" title={statusLabel(file)}>{statusCode(file)}</span></span>
                <span className="change-file-copy"><span className="change-file-name">{parts.name}</span>{parts.parent && <span className="change-file-path">{parts.parent}</span>}</span>
                <span className="change-file-stats"><span className="file-insertions">+{file.insertions}</span><span className="file-deletions">−{file.deletions}</span></span>
              </button>;
            })}
          </nav>

          <div className="changes-diff" aria-label={selectedFile ? `Diff for ${selectedFile.path}` : "Unified diff"}>
            {loading && !diff ? <div className="panel-loading"><LoadingMark label="Loading diff" /><span>Loading diff…</span></div> : selectedFile ? (
              <div className={clsx("diff-code", wrapLines && "wraps")} tabIndex={0}>
                {fileSummary && <div className="diff-file-summary"><strong>{selectedFile.path}</strong><span>{fileSummary.summary}</span></div>}
                <p className="diff-selection-help">Select a line, then Shift-click another to review a range.</p>
                {selectedFile.hunks.map((hunk) => {
                  const hunkSummary = fileSummary?.hunks.find((item) => item.hunkId === hunk.id)?.summary;
                  const selected = reviewSelection(selectedFile, hunk);
                  const lastSelectedId = selected ? hunk.lines.filter((line) => selected.lineIds.includes(line.id)).at(-1)?.id : null;
                  const changedSelection = selected ? hunk.lines.some((line) => selected.lineIds.includes(line.id) && (line.kind === "addition" || line.kind === "deletion")) : false;
                  return <section className="diff-hunk" key={hunk.id}>
                    <div className="diff-hunk-header"><code>{hunk.header}</code>{hunkSummary && <span><Sparkles size={12} />{hunkSummary}</span>}</div>
                    {hunk.lines.map((line, index) => <div key={line.id}>
                      <button
                        type="button"
                        className={clsx("diff-line", `is-${line.kind}`, selected?.lineIds.includes(line.id) && "is-selected")}
                        onClick={(event) => chooseLine(hunk, index, event.shiftKey)}
                        disabled={line.kind === "meta"}
                      >
                        <span className="diff-line-number" aria-hidden="true">{line.oldLineNumber ?? ""}</span><span className="diff-line-number" aria-hidden="true">{line.newLineNumber ?? ""}</span><span className="diff-line-prefix">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}</span><span className="diff-line-content">{line.content || " "}</span>
                      </button>
                      {selected && line.id === lastSelectedId && (
                        <div className="diff-selection-popover">
                          <div className="diff-selection-actions">
                            <button type="button" onClick={() => setReviewAction("ask")}><CircleHelp size={13} />Ask about</button>
                            <button type="button" onClick={() => setReviewAction("revise")}><WandSparkles size={13} />Request revision</button>
                            <button type="button" onClick={() => setReviewAction("revert")} disabled={!changedSelection}><RotateCcw size={13} />Revert</button>
                            <button type="button" onClick={() => { onAddToPrompt(selected); clearSelection(); }}><MessageSquarePlus size={13} />Add to prompt</button>
                            <IconButton label="Clear selection" onClick={clearSelection}><X size={13} /></IconButton>
                          </div>
                          {reviewAction && (
                            <form onSubmit={(event) => { event.preventDefault(); void submit(selectedFile, hunk); }}>
                              <textarea autoFocus value={comment} maxLength={2_000} placeholder={reviewAction === "ask" ? "What would you like to know?" : reviewAction === "revise" ? "Describe the revision you want…" : "Optional note about the revert…"} onChange={(event) => setComment(event.currentTarget.value)} />
                              <div><span>{selected.lineIds.length} selected lines</span><button type="submit" className="primary-button" disabled={submitting}>{submitting ? <LoadingMark label={actionLabel(reviewAction)} /> : actionLabel(reviewAction)}</button></div>
                            </form>
                          )}
                        </div>
                      )}
                    </div>)}
                  </section>;
                })}
              </div>
            ) : <div className="panel-empty changes-empty"><FileCode2 size={22} /><h3>{selectedPath ? "Diff unavailable" : "Select a file"}</h3><p>{selectedPath ? "This file is outside the bounded diff preview. Refresh after reducing the change set." : "Choose a changed file to inspect it."}</p></div>}
            {diff?.truncated && <p className="panel-notice diff-truncated">This diff is truncated to keep the workspace responsive.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
