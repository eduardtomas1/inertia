import { GitCommitHorizontal, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GitStatusSnapshot } from "@shared/contracts";
import { IconButton, LoadingMark } from "./ui";

type CommitDialogProps = {
  open: boolean;
  status: GitStatusSnapshot | null;
  busy: boolean;
  onClose: () => void;
  onCommit: (message: string, push: boolean) => Promise<void>;
};

export function CommitDialog({ open, status, busy, onClose, onCommit }: CommitDialogProps): React.JSX.Element | null {
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) window.setTimeout(() => inputRef.current?.focus(), 0); }, [open]);
  if (!open) return null;
  const submit = async (push: boolean) => {
    if (!message.trim() || busy) return;
    try {
      await onCommit(message.trim(), push);
      setMessage("");
    } catch {
      // The application toast keeps the dialog open and presents the Git error.
    }
  };
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="commit-dialog" role="dialog" aria-modal="true" aria-labelledby="commit-dialog-title">
        <header><span className="dialog-icon"><GitCommitHorizontal size={18} /></span><div><h2 id="commit-dialog-title">Commit changes</h2><p>{status?.files.length ?? 0} files · <span className="stat-additions">+{status?.insertions ?? 0}</span> <span className="stat-deletions">−{status?.deletions ?? 0}</span></p></div><IconButton label="Close commit dialog" onClick={onClose} disabled={busy}><X size={16} /></IconButton></header>
        <label><span>Commit message</span><input ref={inputRef} value={message} maxLength={10_000} placeholder="Describe this change" onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(false); }} /></label>
        <footer>
          <button type="button" className="secondary-button" disabled={!message.trim() || busy} onClick={() => void submit(false)}>{busy ? <LoadingMark label="Committing" /> : <GitCommitHorizontal size={15} />}<span>Commit</span></button>
          <button type="button" className="primary-button dialog-primary" disabled={!message.trim() || busy} onClick={() => void submit(true)}>{busy ? <LoadingMark label="Committing and pushing" /> : <Upload size={15} />}<span>Commit & push</span></button>
        </footer>
      </section>
    </div>
  );
}
