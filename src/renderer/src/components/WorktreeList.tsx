import { useId } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import type { WorktreeEntry } from "@shared/worktrees";

export function worktreeChangeLabel(entry: WorktreeEntry): string {
  if (entry.prunable) return "Folder missing";
  if (entry.dirty === null) return "Status unknown";
  if (entry.dirty) {
    const count = entry.changeCount ?? 0;
    return `${count}${entry.changeCountTruncated ? "+" : ""} ${count === 1 ? "change" : "changes"}`;
  }
  return entry.ignoredFiles ? "Clean, ignored files" : "Clean";
}

/** The last segment of a folder path, for showing a checkout without its location. */
export function folderName(path: string): string {
  return path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? "";
}

function WorktreeRow({ entry, mainFolderName, disabled, onOpenConversation, onRemove }: {
  entry: WorktreeEntry;
  mainFolderName: string;
  disabled: boolean;
  onOpenConversation?: (conversationId: string) => boolean;
  onRemove: (entry: WorktreeEntry, trigger: HTMLButtonElement) => void;
}): React.JSX.Element {
  const reasonId = useId();
  const refused = !entry.removal.allowed;
  const changeState = entry.prunable || entry.dirty === null
    ? "unknown"
    : entry.dirty ? "dirty" : "clean";
  const branch = entry.branch ?? "Detached HEAD";
  return <li className="worktree-list-item">
    <div className="worktree-list-copy">
      {entry.isMain
        ? <span className="worktree-list-title" title={mainFolderName || undefined}>
            <strong>Main checkout</strong>
            {mainFolderName && <span className="worktree-list-folder">{mainFolderName}</span>}
          </span>
        : <code className="worktree-list-path" title={entry.path}>{entry.path}</code>}
      <span className="worktree-list-meta">
        <span>{branch}</span>
        <span className="worktree-badge" data-state={changeState}>{worktreeChangeLabel(entry)}</span>
        {entry.locked && <span className="worktree-badge" data-state="unknown">Locked</span>}
        {!entry.owned && !entry.isMain && <span className="worktree-badge">Not created by Inertia</span>}
      </span>
      {entry.conversationId && entry.title !== null && (onOpenConversation
        ? <button type="button" className="worktree-chat-link" onClick={() => onOpenConversation(entry.conversationId!)}>
            <MessageSquare size={14} aria-hidden="true" />Open chat “{entry.title}”
          </button>
        : <span className="worktree-list-meta">Chat “{entry.title}”</span>)}
      {!entry.isMain && entry.removal.allowed === false && <small id={reasonId} className="worktree-list-reason">{entry.removal.reason}</small>}
    </div>
    {!entry.isMain && <button type="button" className="secondary-button is-danger"
      aria-label={`Remove worktree ${entry.path}`}
      aria-disabled={refused || disabled || undefined}
      aria-describedby={refused ? reasonId : undefined}
      onClick={(event) => { if (!refused && !disabled) onRemove(entry, event.currentTarget); }}>
      <Trash2 size={14} aria-hidden="true" />Remove
    </button>}
  </li>;
}

/** Presents one repository's worktrees; the caller owns loading and confirmation. */
export function WorktreeList({ worktrees, mainFolderName, disabled, onOpenConversation, onRemove }: {
  worktrees: readonly WorktreeEntry[];
  /** Folder name of the main checkout only; its absolute path is never shown. */
  mainFolderName: string;
  disabled: boolean;
  onOpenConversation?: (conversationId: string) => boolean;
  onRemove: (entry: WorktreeEntry, trigger: HTMLButtonElement) => void;
}): React.JSX.Element {
  return <ul className="worktree-list" aria-label="Worktrees">
    {worktrees.map((entry, index) => <WorktreeRow key={`${index}:${entry.location}:${entry.path}`} entry={entry} mainFolderName={mainFolderName} disabled={disabled}
      onOpenConversation={onOpenConversation} onRemove={onRemove} />)}
  </ul>;
}
