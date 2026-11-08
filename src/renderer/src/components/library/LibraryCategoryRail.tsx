import { useLayoutEffect, useRef, useState } from "react";
import { Ellipsis, Plus } from "lucide-react";
import clsx from "clsx";
import type { LibraryCategory } from "@shared/library";

import { IconButton } from "../ui";
import { anchorFromElement, anchorFromPoint, type LibraryMenuAnchor } from "./LibraryMenu";
import type { LibraryCounts, LibraryFilter } from "./libraryModel";

export interface LibraryCategoryRailProps {
  categories: readonly LibraryCategory[];
  counts: LibraryCounts;
  filter: LibraryFilter;
  disabled: boolean;
  renamingId: string | null;
  menuCategoryId: string | null;
  onFilter: (filter: LibraryFilter) => void;
  onCreate: (name: string) => Promise<string | null>;
  onRename: (category: LibraryCategory, name: string) => Promise<string | null>;
  onStartRename: (category: LibraryCategory) => void;
  onRenameDone: () => void;
  onOpenMenu: (category: LibraryCategory, anchor: LibraryMenuAnchor, trigger: HTMLElement | null) => void;
}

function sameFilter(left: LibraryFilter, right: LibraryFilter): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind !== "category" || right.kind !== "category" || left.id === right.id;
}

function NameInput({
  label,
  initial,
  error,
  busy,
  commitOnBlur = false,
  onSubmit,
  onCancel,
  onClearError,
}: {
  label: string;
  initial: string;
  error: string | null;
  busy: boolean;
  commitOnBlur?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  onClearError: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const errorId = `${label.replace(/\W+/gu, "-").toLowerCase()}-error`;
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);
  return (
    <div className="library-category-input">
      <input
        ref={inputRef}
        type="text"
        value={value}
        maxLength={60}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        placeholder="Category name"
        disabled={busy}
        onChange={(event) => {
          setValue(event.target.value);
          onClearError();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            if (value.trim()) onSubmit(value.trim());
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => {
          if (busy || !document.hasFocus()) return;
          const next = value.trim();
          if (!next || next === initial) onCancel();
          else if (commitOnBlur && !error) onSubmit(next);
        }}
      />
      {error && <p id={errorId} className="library-inline-error" role="alert">{error}</p>}
    </div>
  );
}

export function LibraryCategoryRail({
  categories,
  counts,
  filter,
  disabled,
  renamingId,
  menuCategoryId,
  onFilter,
  onCreate,
  onRename,
  onStartRename,
  onRenameDone,
  onOpenMenu,
}: LibraryCategoryRailProps): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const finishRename = (categoryId: string): void => {
    onRenameDone();
    window.requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      railRef.current?.querySelector<HTMLElement>(`[data-library-category="${categoryId}"]`)?.focus({ preventScroll: true });
    });
  };

  const row = (
    key: string,
    label: string,
    count: number,
    target: LibraryFilter,
    category: LibraryCategory | null,
  ): React.JSX.Element => {
    const active = sameFilter(filter, target);
    if (category && renamingId === category.id) {
      return (
        <li key={key} className="library-category-row is-renaming">
          <NameInput
            label={`Rename ${category.name}`}
            initial={category.name}
            error={renameError}
            busy={busy}
            commitOnBlur
            onClearError={() => setRenameError(null)}
            onCancel={() => {
              setRenameError(null);
              finishRename(category.id);
            }}
            onSubmit={(name) => {
              if (name === category.name) {
                finishRename(category.id);
                return;
              }
              setBusy(true);
              void onRename(category, name).then((failure) => {
                setBusy(false);
                setRenameError(failure);
                if (!failure) finishRename(category.id);
              });
            }}
          />
        </li>
      );
    }
    return (
      <li
        key={key}
        className={clsx("library-category-row", active && "is-active", menuCategoryId === category?.id && "has-menu")}
        onContextMenu={category ? (event) => {
          event.preventDefault();
          onOpenMenu(category, anchorFromPoint(event.clientX, event.clientY), event.currentTarget.querySelector("button"));
        } : undefined}
      >
        <button
          type="button"
          className="library-category"
          aria-current={active ? "true" : undefined}
          data-library-category={category?.id ?? target.kind}
          onClick={() => onFilter(target)}
          onKeyDown={category ? (event) => {
            if (event.key === "F2" && !disabled) {
              event.preventDefault();
              onStartRename(category);
            } else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
              event.preventDefault();
              onOpenMenu(category, anchorFromElement(event.currentTarget), event.currentTarget);
            }
          } : undefined}
        >
          <span className="library-category-name">{label}</span>
          <span className="library-category-count" aria-label={`${count} saved`}>{count}</span>
        </button>
        {category && (
          <IconButton
            label={`Actions for ${category.name}`}
            className="library-category-more"
            aria-haspopup="menu"
            aria-expanded={menuCategoryId === category.id}
            disabled={disabled}
            onClick={(event) => onOpenMenu(category, anchorFromElement(event.currentTarget), event.currentTarget)}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </IconButton>
        )}
      </li>
    );
  };

  return (
    <nav ref={railRef} className="library-rail" aria-label="Categories">
      <ul className="library-category-list">
        {row("all", "All", counts.all, { kind: "all" }, null)}
        {categories.map((category) => row(
          category.id,
          category.name,
          counts.byCategory.get(category.id) ?? 0,
          { kind: "category", id: category.id },
          category,
        ))}
        {counts.unsorted > 0 && row("unsorted", "Unsorted", counts.unsorted, { kind: "unsorted" }, null)}
      </ul>
      {creating ? (
        <NameInput
          label="New category name"
          initial=""
          error={createError}
          busy={busy}
          onClearError={() => setCreateError(null)}
          onCancel={() => {
            setCreating(false);
            setCreateError(null);
            window.requestAnimationFrame(() => createButtonRef.current?.focus({ preventScroll: true }));
          }}
          onSubmit={(name) => {
            setBusy(true);
            void onCreate(name).then((failure) => {
              setBusy(false);
              setCreateError(failure);
              if (!failure) {
                setCreating(false);
                window.requestAnimationFrame(() => createButtonRef.current?.focus({ preventScroll: true }));
              }
            });
          }}
        />
      ) : (
        <button
          ref={createButtonRef}
          type="button"
          className="library-category-create"
          disabled={disabled}
          onClick={() => {
            setCreateError(null);
            setCreating(true);
          }}
        >
          <Plus size={14} aria-hidden="true" />
          <span>New category</span>
        </button>
      )}
    </nav>
  );
}
