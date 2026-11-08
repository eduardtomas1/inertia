import { memo, useLayoutEffect, useRef, useState } from "react";
import { ArchiveRestore, ExternalLink, FolderInput, Pencil, Trash2 } from "lucide-react";
import clsx from "clsx";

import { formatFullDateTime, formatRelativeTime } from "../../lib/format";
import { IconButton } from "../ui";
import { TooltipText } from "../TooltipText";
import { anchorFromElement, type LibraryMenuAnchor } from "./LibraryMenu";
import type { SavedAnswerEntry } from "./libraryModel";

export interface LibraryAnswerCardProps {
  entry: SavedAnswerEntry;
  disabled: boolean;
  renaming: boolean;
  menuOpen: boolean;
  opening: boolean;
  onOpen: (entry: SavedAnswerEntry) => void;
  onStartRename: (entry: SavedAnswerEntry) => void;
  onRename: (entry: SavedAnswerEntry, title: string | null) => Promise<string | null>;
  onOpenMoveMenu: (entry: SavedAnswerEntry, anchor: LibraryMenuAnchor, trigger: HTMLElement) => void;
  onRemove: (entry: SavedAnswerEntry) => void;
}

function TitleEditor({
  entry,
  onRename,
}: Pick<LibraryAnswerCardProps, "entry" | "onRename">): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(entry.answer.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = `library-title-error-${entry.answer.id}`;
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);
  const commit = (): void => {
    const next = value.trim();
    if (busy) return;
    if (!next || next === entry.answer.title) {
      void onRename(entry, null);
      return;
    }
    setBusy(true);
    void onRename(entry, next).then((failure) => {
      setBusy(false);
      setError(failure);
      if (failure) inputRef.current?.focus({ preventScroll: true });
    });
  };
  return (
    <div className="library-card-title-editor">
      <input
        ref={inputRef}
        type="text"
        value={value}
        maxLength={120}
        aria-label="Saved answer title"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        disabled={busy}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            void onRename(entry, null);
          }
        }}
        onBlur={() => {
          if (!document.hasFocus() || error) return;
          commit();
        }}
      />
      {error && <p id={errorId} className="library-inline-error" role="alert">{error}</p>}
    </div>
  );
}

export const LibraryAnswerCard = memo(function LibraryAnswerCard({
  entry,
  disabled,
  renaming,
  menuOpen,
  opening,
  onOpen,
  onStartRename,
  onRename,
  onOpenMoveMenu,
  onRemove,
}: LibraryAnswerCardProps): React.JSX.Element {
  const { answer, conversation, projectName, category } = entry;
  const archived = conversation.archivedAt !== null;
  const openLabel = archived ? "Restore and open" : "Open in chat";
  return (
    <li
      className={clsx("library-card", menuOpen && "has-menu", renaming && "is-renaming", opening && "is-opening")}
      data-saved-answer-id={answer.id}
    >
      <div className="library-card-body">
        {renaming ? (
          <TitleEditor entry={entry} onRename={onRename} />
        ) : (
          <h3 className="library-card-title">
            <button
              type="button"
              className="library-card-open"
              data-library-card-open=""
              disabled={opening}
              aria-describedby={`library-card-meta-${answer.id}`}
              onClick={() => onOpen(entry)}
              onKeyDown={(event) => {
                if (event.key === "F2" && !disabled) {
                  event.preventDefault();
                  onStartRename(entry);
                }
              }}
            >
              {answer.title}
            </button>
          </h3>
        )}
        {answer.excerpt && <p className="library-card-excerpt">{answer.excerpt}</p>}
      </div>
      <div className="library-card-footer">
        <p className="library-card-meta" id={`library-card-meta-${answer.id}`}>
          <span className={clsx("library-card-chip", !category && "is-unsorted")}>{category?.name ?? "Unsorted"}</span>
          <span className="library-card-source">
            <span className="library-card-chat">{conversation.title}</span>
            {projectName && <span>{projectName}</span>}
            <TooltipText tooltip={formatFullDateTime(answer.createdAt)}>
              <time dateTime={answer.createdAt}>{formatRelativeTime(answer.createdAt)}</time>
            </TooltipText>
          </span>
          {archived && <span className="library-archived">Archived</span>}
        </p>
        <div className="library-card-actions">
          <button
            type="button"
            className="library-card-action is-primary"
            disabled={opening}
            onClick={() => onOpen(entry)}
          >
            {archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <ExternalLink size={14} aria-hidden="true" />}
            <span>{openLabel}</span>
          </button>
          <IconButton
            label="Rename"
            className="library-card-icon"
            disabled={disabled || renaming}
            onClick={() => onStartRename(entry)}
          >
            <Pencil size={14} aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Move to category"
            className="library-card-icon"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={disabled}
            onClick={(event) => onOpenMoveMenu(entry, anchorFromElement(event.currentTarget), event.currentTarget)}
          >
            <FolderInput size={14} aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Remove from Library"
            className="library-card-icon is-danger"
            disabled={disabled}
            onClick={() => onRemove(entry)}
          >
            <Trash2 size={14} aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </li>
  );
});
