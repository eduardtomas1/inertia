import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, ChevronUp, CircleHelp, FileCode2, GitCompareArrows, MessageSquarePlus, Pencil, RefreshCw, RotateCcw, Sparkles, Square, StickyNote, Trash2, WandSparkles, X } from "lucide-react";
import type { ChangedFile, DiffFile, DiffHunk, DiffReviewClassificationHint, DiffReviewNote, DiffReviewState, DiffReviewSummary, DiffReversalOperation, GitDiffSnapshot } from "@shared/contracts";
import { buildDiffContext, diffFileFingerprint, diffHunkFingerprint, parseUnifiedDiff, selectedLineFingerprint } from "@shared/diff-review";
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
  reviewStates?: DiffReviewState[];
  notes?: DiffReviewNote[];
  loading?: boolean;
  summaryLoading?: boolean;
  wrapLines?: boolean;
  lastReversal?: DiffReversalOperation | null;
  onSelectFile: (path: string) => void;
  onRefresh?: () => void;
  onGenerateSummary?: () => Promise<void>;
  onCancelSummary?: () => Promise<void>;
  onAsk: (selection: DiffSelection, comment: string) => Promise<void>;
  onRequestRevision: (selection: DiffSelection, comment: string) => Promise<void>;
  onRevert: (selection: DiffSelection, comment: string) => Promise<void>;
  onUndoReversal?: () => Promise<void>;
  onSetReviewState: (state: Omit<DiffReviewState, "conversationId" | "stale" | "updatedAt">) => Promise<void>;
  onCreateNote: (note: Omit<DiffReviewNote, "id" | "conversationId" | "stale" | "createdAt" | "updatedAt">) => Promise<void>;
  onUpdateNote: (noteId: string, body: string) => Promise<void>;
  onDeleteNote: (noteId: string) => Promise<void>;
  onAddTextToPrompt: (text: string) => void;
  onAddToPrompt: (selection: DiffSelection) => void;
};

type ReviewAction = "ask" | "revise" | "revert" | "note";
type ReviewFilter = "all" | "unreviewed" | "reviewed";

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
  if (action === "note") return "Save local note";
  return "Revert selected lines";
}

const classificationLabels: Record<DiffReviewClassificationHint["classification"], string> = {
  "behavior-change": "Behavior change",
  "regression-risk": "Regression risk",
  "security-sensitive": "Security-sensitive",
  migration: "Migration",
  "test-impact": "Test impact",
  "performance-sensitive": "Performance-sensitive",
  "documentation-only": "Documentation-only",
};

function ClassificationHints({ hints = [] }: { hints?: DiffReviewClassificationHint[] }): React.JSX.Element | null {
  if (hints.length === 0) return null;
  return (
    <span className="diff-summary-hints" aria-label="Agent classification hints">
      {hints.map((hint) => (
        <span title={`Agent hint · ${hint.evidence}`} key={hint.classification}>{classificationLabels[hint.classification]}</span>
      ))}
    </span>
  );
}

export function ChangesPanel({
  files,
  diff,
  selectedPath,
  summary,
  reviewStates = [],
  notes = [],
  loading = false,
  summaryLoading = false,
  wrapLines = true,
  lastReversal = null,
  onSelectFile,
  onRefresh,
  onGenerateSummary,
  onCancelSummary,
  onAsk,
  onRequestRevision,
  onRevert,
  onUndoReversal,
  onSetReviewState,
  onCreateNote,
  onUpdateNote,
  onDeleteNote,
  onAddTextToPrompt,
  onAddToPrompt,
}: ChangesPanelProps): React.JSX.Element {
  const [selection, setSelection] = useState<{ hunkId: string; anchor: number; lineIds: string[] } | null>(null);
  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [activeHunkId, setActiveHunkId] = useState<string | null>(null);
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
  const hunkReviewed = (file: DiffFile, hunk: DiffHunk): boolean => {
    const fingerprint = diffHunkFingerprint(file, hunk);
    return reviewStates.some((state) => state.scope === "hunk" && state.path === file.path && state.hunkId === hunk.id && state.targetFingerprint === fingerprint && state.reviewed && !state.stale);
  };
  const fileReviewed = (file: DiffFile): boolean => {
    const fingerprint = diffFileFingerprint(file);
    return reviewStates.some((state) => state.scope === "file" && state.path === file.path && state.targetFingerprint === fingerprint && state.reviewed && !state.stale);
  };
  const effectivelyReviewed = (file: DiffFile, hunk: DiffHunk): boolean => fileReviewed(file) || hunkReviewed(file, hunk);
  const totalHunks = structured.files.reduce((total, file) => total + file.hunks.length, 0);
  const reviewedHunks = structured.files.reduce((total, file) => total + file.hunks.filter((hunk) => effectivelyReviewed(file, hunk)).length, 0);
  const visibleFiles = structured.files.filter((file) => {
    const reviewed = fileReviewed(file) || (file.hunks.length > 0 && file.hunks.every((hunk) => hunkReviewed(file, hunk)));
    return reviewFilter === "all" || (reviewFilter === "reviewed" ? reviewed : !reviewed);
  });
  const hunkMatchesFilter = (file: DiffFile, hunk: DiffHunk): boolean => {
    if (reviewFilter === "all") return true;
    const reviewed = effectivelyReviewed(file, hunk);
    return reviewFilter === "reviewed" ? reviewed : !reviewed;
  };

  useEffect(() => {
    setSelection(null);
    setReviewAction(null);
    setComment("");
    setSelectionError(null);
    setActiveHunkId(null);
  }, [structured.fingerprint, selectedPath]);

  const clearSelection = () => { setSelection(null); setReviewAction(null); setComment(""); setSelectionError(null); };
  const chooseLine = (hunk: DiffHunk, index: number, extend: boolean) => {
    const start = extend && selection?.hunkId === hunk.id ? Math.min(selection.anchor, index) : index;
    const end = extend && selection?.hunkId === hunk.id ? Math.max(selection.anchor, index) : index;
    const lineIds = hunk.lines.slice(start, end + 1).filter((line) => line.kind !== "meta").map((line) => line.id);
    if (lineIds.length > 500) {
      setSelectionError("Select at most 500 lines at a time.");
      return;
    }
    setSelection({ hunkId: hunk.id, anchor: extend && selection?.hunkId === hunk.id ? selection.anchor : index, lineIds });
    setActiveHunkId(hunk.id);
    setSelectionError(null);
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
      reference: "",
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
      if (reviewAction === "note") await onCreateNote({
        path: file.path,
        hunkId: hunk.id,
        lineIds: selected.lineIds,
        targetFingerprint: selectedLineFingerprint(file, hunk, selected.lineIds),
        body: comment,
      });
      clearSelection();
    } finally {
      setSubmitting(false);
    }
  };
  const addSelectionToPrompt = (file: DiffFile, hunk: DiffHunk, selected: DiffSelection) => {
    try {
      const reference = buildDiffContext(file, hunk, selected.lineIds, { purpose: "prompt" }).text;
      onAddToPrompt({ ...selected, reference });
      clearSelection();
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "This selection cannot be added safely.");
    }
  };
  const toggleState = async (file: DiffFile, hunk?: DiffHunk) => {
    const currentReviewed = hunk ? hunkReviewed(file, hunk) : fileReviewed(file);
    await onSetReviewState({
      scope: hunk ? "hunk" : "file",
      path: file.path,
      hunkId: hunk?.id ?? null,
      targetFingerprint: hunk ? diffHunkFingerprint(file, hunk) : diffFileFingerprint(file),
      reviewed: !currentReviewed,
    });
  };
  const createScopedNote = async (file: DiffFile, hunk?: DiffHunk) => {
    const body = window.prompt(`Add a local note for ${hunk ? "this hunk" : file.path}:`)?.trim();
    if (!body) return;
    await onCreateNote({
      path: file.path,
      hunkId: hunk?.id ?? null,
      lineIds: [],
      targetFingerprint: hunk ? diffHunkFingerprint(file, hunk) : diffFileFingerprint(file),
      body,
    });
  };
  const editNote = async (note: DiffReviewNote) => {
    const body = window.prompt("Edit local review note:", note.body)?.trim();
    if (body && body !== note.body) await onUpdateNote(note.id, body);
  };
  const notePromptText = (note: DiffReviewNote) => [
    `Local review note for ${note.path}${note.hunkId ? ` (${note.hunkId})` : ""}${note.stale ? " [stale target]" : ""}:`,
    note.body,
  ].join("\n");
  const requestNoteRevision = async (note: DiffReviewNote, file: DiffFile, hunk: DiffHunk) => {
    const lineIds = note.lineIds.length > 0 ? note.lineIds : hunk.lines.filter((line) => line.kind !== "meta").map((line) => line.id);
    await onRequestRevision({ fingerprint: structured.fingerprint, file, hunk, lineIds, reference: "" }, note.body);
  };
  const navigateHunk = (direction: -1 | 1) => {
    const all = visibleFiles.flatMap((file) => file.hunks
      .filter((hunk) => hunkMatchesFilter(file, hunk))
      .map((hunk) => ({ file, hunk })));
    if (all.length === 0) return;
    const active = all.findIndex(({ file, hunk }) => file.path === selectedFile?.path && hunk.id === activeHunkId);
    const selectedFileStart = all.findIndex(({ file }) => file.path === selectedFile?.path);
    const base = active >= 0 ? active : selectedFileStart >= 0 ? selectedFileStart : 0;
    const next = all[(base + direction + all.length) % all.length]!;
    setActiveHunkId(next.hunk.id);
    onSelectFile(next.file.path);
    window.setTimeout(() => document.getElementById(`review-${next.hunk.id}`)?.scrollIntoView({ block: "center" }), 0);
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
          {lastReversal && onUndoReversal && (
            <button type="button" className="subtle-button" title={`Restore ${lastReversal.filePath} to its staged and working-tree state before the reversal`} onClick={() => void onUndoReversal()}>
              <RotateCcw size={13} />Undo revert
            </button>
          )}
          {onGenerateSummary && files.length > 0 && (
            <IconButton
              label={summaryLoading ? "Cancel change summary" : activeSummary ? "Refresh agent summaries" : "Summarize changes"}
              onClick={() => {
                const action = summaryLoading ? onCancelSummary?.() : onGenerateSummary();
                if (action) void action.catch(() => undefined);
              }}
              disabled={loading || (summaryLoading && !onCancelSummary)}
            >
              {summaryLoading ? <><LoadingMark label="Summarizing changes" /><Square size={10} /></> : <Sparkles size={15} />}
            </IconButton>
          )}
          {onRefresh && <IconButton label="Refresh changes" onClick={onRefresh} disabled={loading}>{loading ? <LoadingMark label="Refreshing changes" /> : <RefreshCw size={15} />}</IconButton>}
        </div>
      </header>

      {activeSummary && <div className="diff-overall-summary"><Sparkles size={14} /><span><strong>Change summary</strong>{activeSummary.overall}<ClassificationHints hints={activeSummary.classifications} /></span></div>}
      {totalHunks > 0 && (
        <div className="diff-review-toolbar">
          <span><strong>{reviewedHunks}/{totalHunks}</strong> hunks reviewed</span>
          <progress aria-label={`${reviewedHunks} of ${totalHunks} hunks reviewed`} max={totalHunks} value={reviewedHunks} />
          <select aria-label="Filter review state" value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)}>
            <option value="all">All changes</option>
            <option value="unreviewed">Unreviewed</option>
            <option value="reviewed">Reviewed</option>
          </select>
          <IconButton label="Previous review hunk (P)" onClick={() => navigateHunk(-1)}><ChevronUp size={14} /></IconButton>
          <IconButton label="Next review hunk (N)" onClick={() => navigateHunk(1)}><ChevronDown size={14} /></IconButton>
        </div>
      )}

      {files.length === 0 ? (
        <div className="panel-empty changes-empty"><GitCompareArrows size={22} /><h3>No local changes</h3><p>Edits made in this workspace will appear here.</p></div>
      ) : (
        <div className="changes-layout">
          <div className="changes-file-picker"><span>Reviewing</span><select aria-label="Changed file" value={selectedPath ?? files[0]?.path ?? ""} onChange={(event) => { clearSelection(); onSelectFile(event.target.value); }}>{files.map((file) => <option value={file.path} key={file.path}>{statusCode(file)} · {file.path}</option>)}</select></div>
          <nav className="changes-file-list" aria-label="Changed files">
            {files.filter((file) => visibleFiles.some((visible) => visible.path === file.path)).map((file) => {
              const parts = pathParts(file.path);
              const diffFile = structured.files.find((candidate) => candidate.path === file.path);
              return <button type="button" className={clsx("change-file-button", file.path === selectedPath && "is-selected")} aria-pressed={file.path === selectedPath} onClick={() => { clearSelection(); onSelectFile(file.path); }} key={file.path}>
                <span className="change-file-leading"><FileCode2 size={15} /><span className="change-file-status" title={statusLabel(file)}>{statusCode(file)}</span></span>
                <span className="change-file-copy"><span className="change-file-name">{parts.name}</span>{parts.parent && <span className="change-file-path">{parts.parent}</span>}</span>
                <span className="change-file-stats">
                  <span>{file.staged ? "staged" : ""}{file.staged && file.unstaged ? " + " : ""}{file.unstaged ? "unstaged" : ""}</span>
                  <span><span className="file-insertions">+{file.insertions}</span> <span className="file-deletions">−{file.deletions}</span></span>
                  {diffFile && fileReviewed(diffFile) && <Check size={11} aria-label="File reviewed" />}
                </span>
              </button>;
            })}
          </nav>

          <div className="changes-diff" aria-label={selectedFile ? `Diff for ${selectedFile.path}` : "Unified diff"}>
            {loading && !diff ? <div className="panel-loading"><LoadingMark label="Loading diff" /><span>Loading diff…</span></div> : selectedFile ? (
              <div className={clsx("diff-code", wrapLines && "wraps")} role="region" aria-label={`Diff content for ${selectedFile.path}`} tabIndex={0} onKeyDown={(event) => {
                if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
                if (event.key.toLowerCase() === "n") { event.preventDefault(); navigateHunk(1); }
                if (event.key.toLowerCase() === "p") { event.preventDefault(); navigateHunk(-1); }
              }}>
                <div className="diff-file-review-heading">
                  <span><strong>{selectedFile.path}</strong>{fileSummary && <small>{fileSummary.summary}</small>}<ClassificationHints hints={fileSummary?.classifications} /></span>
                  <button type="button" className={clsx(fileReviewed(selectedFile) && "is-reviewed")} onClick={() => void toggleState(selectedFile)}><Check size={12} />{fileReviewed(selectedFile) ? "Reviewed" : "Mark file reviewed"}</button>
                  <button type="button" onClick={() => void createScopedNote(selectedFile)}><StickyNote size={12} />Note</button>
                </div>
                {notes.filter((note) => note.path === selectedFile.path && note.hunkId === null).map((note) => (
                  <div className={clsx("diff-review-note", note.stale && "is-stale")} key={note.id}>
                    <span><StickyNote size={12} /><strong>File note{note.stale ? " · stale" : ""}</strong><small>{note.body}</small></span>
                    <button type="button" onClick={() => onAddTextToPrompt(notePromptText(note))}><MessageSquarePlus size={12} />Prompt</button>
                    <IconButton label="Edit note" onClick={() => void editNote(note)}><Pencil size={12} /></IconButton>
                    <IconButton label="Delete note" onClick={() => { if (window.confirm("Delete this local review note?")) void onDeleteNote(note.id); }}><Trash2 size={12} /></IconButton>
                  </div>
                ))}
                {notes.filter((note) => note.path === selectedFile.path && note.hunkId !== null && note.stale && !selectedFile.hunks.some((hunk) => hunk.id === note.hunkId)).map((note) => (
                  <div className="diff-review-note is-stale" key={note.id}>
                    <span><StickyNote size={12} /><strong>Stale note · target changed</strong><small>{note.body}</small></span>
                    <button type="button" onClick={() => onAddTextToPrompt(notePromptText(note))}><MessageSquarePlus size={12} />Prompt</button>
                    <IconButton label="Edit note" onClick={() => void editNote(note)}><Pencil size={12} /></IconButton>
                    <IconButton label="Delete note" onClick={() => { if (window.confirm("Delete this local review note?")) void onDeleteNote(note.id); }}><Trash2 size={12} /></IconButton>
                  </div>
                ))}
                <p className="diff-selection-help">Select a line, then Shift-click another to review a range.</p>
                {selectedFile.hunks.filter((hunk) => hunkMatchesFilter(selectedFile, hunk)).map((hunk) => {
                  const statusFile = files.find((candidate) => candidate.path === selectedFile.path);
                  const hunkSummary = fileSummary?.hunks.find((item) => item.hunkId === hunk.id)?.summary;
                  const selected = reviewSelection(selectedFile, hunk);
                  const lastSelectedId = selected ? hunk.lines.filter((line) => selected.lineIds.includes(line.id)).at(-1)?.id : null;
                  const changedSelection = selected ? hunk.lines.some((line) => selected.lineIds.includes(line.id) && (line.kind === "addition" || line.kind === "deletion")) : false;
                  const hunkNotes = notes.filter((note) => note.path === selectedFile.path && note.hunkId === hunk.id);
                  return <section className="diff-hunk" id={`review-${hunk.id}`} key={hunk.id}>
                    <div className="diff-hunk-header">
                      <code>{hunk.header}</code>{hunkSummary && <span><Sparkles size={12} />{hunkSummary}<ClassificationHints hints={fileSummary?.hunks.find((item) => item.hunkId === hunk.id)?.classifications} /></span>}
                      <span className="diff-hunk-actions">
                        <button type="button" className={clsx(hunkReviewed(selectedFile, hunk) && "is-reviewed")} onClick={() => void toggleState(selectedFile, hunk)}><Check size={11} />{hunkReviewed(selectedFile, hunk) ? "Reviewed" : "Mark reviewed"}</button>
                        <button type="button" onClick={() => void createScopedNote(selectedFile, hunk)}><StickyNote size={11} />Note</button>
                      </span>
                    </div>
                    {hunkNotes.map((note) => (
                      <div className={clsx("diff-review-note", note.stale && "is-stale")} key={note.id}>
                        <span><StickyNote size={12} /><strong>{note.lineIds.length > 0 ? `${note.lineIds.length}-line note` : "Hunk note"}{note.stale ? " · stale" : ""}</strong><small>{note.body}</small></span>
                        <button type="button" onClick={() => onAddTextToPrompt(notePromptText(note))}><MessageSquarePlus size={12} />Prompt</button>
                        <button type="button" disabled={note.stale} onClick={() => void requestNoteRevision(note, selectedFile, hunk)}><WandSparkles size={12} />Revise</button>
                        <IconButton label="Edit note" onClick={() => void editNote(note)}><Pencil size={12} /></IconButton>
                        <IconButton label="Delete note" onClick={() => { if (window.confirm("Delete this local review note?")) void onDeleteNote(note.id); }}><Trash2 size={12} /></IconButton>
                      </div>
                    ))}
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
                            <button type="button" onClick={() => setReviewAction("revert")} disabled={!changedSelection || diff?.truncated}><RotateCcw size={13} />Revert</button>
                            <button type="button" onClick={() => setReviewAction("note")}><StickyNote size={13} />Note</button>
                            <button type="button" onClick={() => addSelectionToPrompt(selectedFile, hunk, selected)}><MessageSquarePlus size={13} />Add to prompt</button>
                            <IconButton label="Clear selection" onClick={clearSelection}><X size={13} /></IconButton>
                          </div>
                          {reviewAction && (
                            <form onSubmit={(event) => { event.preventDefault(); void submit(selectedFile, hunk); }}>
                              <textarea autoFocus value={comment} maxLength={reviewAction === "note" ? 8_000 : 2_000} placeholder={reviewAction === "ask" ? "What would you like to know?" : reviewAction === "revise" ? "Describe the revision you want…" : reviewAction === "note" ? "Write a local note about this range…" : "Optional note about the revert…"} onChange={(event) => setComment(event.currentTarget.value)} />
                              {reviewAction === "revert" && (
                                <div className="diff-reversal-scope">
                                  <strong>{selectedFile.path}</strong>
                                  <code>{hunk.header}</code>
                                  <span>
                                    {selected.lineIds.length} selected lines · Candidate Git layers: {
                                      statusFile?.staged && statusFile.unstaged
                                        ? "index (staged) and working tree (mixed file)"
                                        : statusFile?.staged
                                          ? "index (staged)"
                                          : "working tree"
                                    }
                                  </span>
                                  <small>A complete, current diff and both Git layers will be revalidated before an immediate reversible backup and atomic file update.</small>
                                </div>
                              )}
                              <div><span>{selected.lineIds.length} selected lines</span><button type="submit" className="primary-button" disabled={submitting || (reviewAction === "note" && !comment.trim())}>{submitting ? <LoadingMark label={actionLabel(reviewAction)} /> : actionLabel(reviewAction)}</button></div>
                            </form>
                          )}
                        </div>
                      )}
                    </div>)}
                  </section>;
                })}
                {selectionError && <p className="panel-notice diff-selection-error">{selectionError}</p>}
              </div>
            ) : <div className="panel-empty changes-empty"><FileCode2 size={22} /><h3>{selectedPath ? "Diff unavailable" : "Select a file"}</h3><p>{selectedPath ? "This file is outside the bounded diff preview. Refresh after reducing the change set." : "Choose a changed file to inspect it."}</p></div>}
            {diff?.truncated && <p className="panel-notice diff-truncated">This diff is truncated to keep the workspace responsive.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
