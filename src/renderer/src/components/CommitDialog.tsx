import { GitCommitHorizontal, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffReviewState, GitStatusSnapshot, StructuredDiff } from "@shared/contracts";
import { diffFileFingerprint, diffHunkFingerprint } from "@shared/diff-review";
import { IconButton, LoadingMark } from "./ui";

type CommitDialogProps = {
  open: boolean;
  status: GitStatusSnapshot | null;
  diff: StructuredDiff;
  reviewStates: DiffReviewState[];
  busy: boolean;
  onClose: () => void;
  onCommit: (message: string, push: boolean, paths: string[]) => Promise<void>;
};

export function CommitDialog({ open, status, diff, reviewStates, busy, onClose, onCommit }: CommitDialogProps): React.JSX.Element | null {
  const [message, setMessage] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setSelectedPaths(status?.files.map((file) => file.path) ?? []);
  }, [open, status?.files]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  const unreviewedHunks = useMemo(() => diff.files
    .filter((file) => selectedPaths.includes(file.path))
    .flatMap((file) => file.hunks.filter((hunk) => {
      const fileFingerprint = diffFileFingerprint(file);
      const fingerprint = diffHunkFingerprint(file, hunk);
      return !reviewStates.some((state) => {
        if (state.path !== file.path || !state.reviewed || state.stale) return false;
        if (state.scope === "file") return state.targetFingerprint === fileFingerprint;
        return state.hunkId === hunk.id && state.targetFingerprint === fingerprint;
      });
    })), [diff.files, reviewStates, selectedPaths]);
  if (!open) return null;
  const submit = async (push: boolean) => {
    if (!message.trim() || busy || selectedPaths.length === 0) return;
    try {
      await onCommit(message.trim(), push, selectedPaths);
      setMessage("");
    } catch {
      // The application toast keeps the dialog open and presents the Git error.
    }
  };
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section
        className="commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="commit-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header><span className="dialog-icon"><GitCommitHorizontal size={18} /></span><div><h2 id="commit-dialog-title">Commit changes</h2><p>{status?.files.length ?? 0} files · <span className="stat-additions">+{status?.insertions ?? 0}</span> <span className="stat-deletions">−{status?.deletions ?? 0}</span></p></div><IconButton label="Close commit dialog" onClick={onClose} disabled={busy}><X size={16} /></IconButton></header>
        <div className="commit-path-heading">
          <span>Paths to stage and commit</span>
          <button type="button" onClick={() => setSelectedPaths(status?.files.map((file) => file.path) ?? [])}>All</button>
          <button type="button" onClick={() => setSelectedPaths([])}>None</button>
        </div>
        <div className="commit-path-list">
          {status?.files.map((file) => (
            <label key={file.path}>
              <input
                type="checkbox"
                checked={selectedPaths.includes(file.path)}
                disabled={busy}
                onChange={(event) => setSelectedPaths((current) => event.target.checked
                  ? [...new Set([...current, file.path])]
                  : current.filter((path) => path !== file.path))}
              />
              <span><strong>{file.path}</strong><small>{file.untracked ? "Untracked" : `${file.staged ? "Staged" : ""}${file.staged && file.unstaged ? " + " : ""}${file.unstaged ? "Unstaged" : ""}`}</small></span>
            </label>
          ))}
        </div>
        <p className="commit-stage-note">Only checked paths will be staged and committed. Review marks never stage files.</p>
        {unreviewedHunks.length > 0 && <p className="commit-review-warning">{unreviewedHunks.length} selected {unreviewedHunks.length === 1 ? "hunk is" : "hunks are"} unreviewed.</p>}
        <label><span>Commit message</span><input ref={inputRef} value={message} maxLength={10_000} placeholder="Describe this change" onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(false); }} /></label>
        <footer>
          <button type="button" className="secondary-button" disabled={!message.trim() || busy || selectedPaths.length === 0} onClick={() => void submit(false)}>{busy ? <LoadingMark label="Committing" /> : <GitCommitHorizontal size={15} />}<span>Commit</span></button>
          <button type="button" className="primary-button dialog-primary" disabled={!message.trim() || busy || selectedPaths.length === 0} onClick={() => void submit(true)}>{busy ? <LoadingMark label="Committing and pushing" /> : <Upload size={15} />}<span>Commit & push</span></button>
        </footer>
      </section>
    </div>
  );
}
