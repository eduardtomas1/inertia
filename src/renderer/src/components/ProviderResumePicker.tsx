import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MessagesSquare, Search } from "lucide-react";

import type { ProviderTerminalResumeOption } from "./providerResumeOptions";

export interface ProviderResumePickerProps {
  options: readonly ProviderTerminalResumeOption[];
  selectedConversationId: string | null;
  blockedConversationIds?: ReadonlySet<string>;
  busy?: boolean;
  autoFocus?: boolean;
  onSelect: (conversationId: string) => void;
  onCancel?: () => void;
}

interface ResumeRow {
  option: ProviderTerminalResumeOption;
  providerLabel: string | null;
  sessionId: string | null;
  blocked: boolean;
  selectable: boolean;
  note: string | null;
}

function describe(
  option: ProviderTerminalResumeOption,
  blocked: boolean,
): ResumeRow {
  const { availability } = option;
  const descriptor = availability.resume;
  const blockedNote = "Already resumed in another terminal tab.";
  return {
    option,
    providerLabel: descriptor?.providerLabel ?? null,
    sessionId: descriptor?.sessionId ?? null,
    blocked,
    selectable: availability.kind === "available" && !blocked,
    note: blocked
      ? blockedNote
      : availability.kind === "unavailable"
        ? availability.reason
        : null,
  };
}

/**
 * Every token has to match somewhere in the row so that narrowing terms
 * compose ("claude inertia") instead of the later term widening the result set.
 */
export function filterResumeRows(
  rows: readonly ResumeRow[],
  query: string,
): readonly ResumeRow[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = [
      row.option.conversationTitle,
      row.option.projectName,
      row.providerLabel ?? "",
      row.sessionId ?? "",
    ].join(" ").toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function preferredActiveIndex(
  rows: readonly ResumeRow[],
  selectedConversationId: string | null,
): number {
  const selected = rows.findIndex((row) =>
    row.selectable && row.option.conversationId === selectedConversationId);
  return selected >= 0 ? selected : rows.findIndex((row) => row.selectable);
}

export function ProviderResumePicker({
  options,
  selectedConversationId,
  blockedConversationIds,
  busy = false,
  autoFocus = false,
  onSelect,
  onCancel,
}: ProviderResumePickerProps): React.JSX.Element {
  const reactId = useId();
  const listId = `${reactId}-resume-list`;
  const searchId = `${reactId}-resume-search`;
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => options.map((option) =>
      describe(option, blockedConversationIds?.has(option.conversationId) ?? false)),
    [blockedConversationIds, options],
  );
  const visible = useMemo(() => filterResumeRows(rows, query), [query, rows]);
  const [activeIndex, setActiveIndex] = useState(() =>
    preferredActiveIndex(visible, selectedConversationId));

  // The active descendant follows the selected row when possible. Otherwise
  // it starts at the first action Enter can actually perform.
  useEffect(() => {
    setActiveIndex(preferredActiveIndex(visible, selectedConversationId));
  }, [selectedConversationId, visible]);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visible.length]);

  const commit = (index: number): void => {
    const row = visible[index];
    if (!row || !row.selectable || busy) return;
    onSelect(row.option.conversationId);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit(activeIndex);
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const selectable = visible.flatMap((row, index) =>
      row.selectable ? [index] : []);
    if (selectable.length === 0) return;
    setActiveIndex((current) => {
      if (event.key === "Home") return selectable[0]!;
      if (event.key === "End") return selectable.at(-1)!;
      const position = selectable.indexOf(current);
      if (event.key === "ArrowUp") {
        return selectable[position <= 0 ? selectable.length - 1 : position - 1]!;
      }
      return selectable[position < 0 || position === selectable.length - 1
        ? 0
        : position + 1]!;
    });
  };

  return (
    <div className="resume-picker" onKeyDown={onKeyDown}>
      <div className="resume-picker-search">
        <label htmlFor={searchId}>
          <Search size={14} aria-hidden="true" />
          <span className="visually-hidden">Search resumable chats</span>
        </label>
        <input
          ref={searchRef}
          id={searchId}
          name="resume-search"
          type="search"
          value={query}
          autoComplete="off"
          spellCheck="false"
          placeholder="Search chats, projects, or sessions…"
          aria-controls={listId}
          aria-activedescendant={visible[activeIndex]
            ? `${reactId}-resume-option-${visible[activeIndex]!.option.conversationId}`
            : undefined}
          disabled={busy}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {visible.length === 0 ? (
        <div className="resume-picker-empty" role="status">
          <MessagesSquare size={16} aria-hidden="true" />
          <span>
            <strong>
              {rows.length === 0 ? "No resumable chats" : "No matching chats"}
            </strong>
            <small>
              {rows.length === 0
                ? "Provider sessions from this folder appear here once a chat has run."
                : "Try a different chat, project, or session id."}
            </small>
          </span>
        </div>
      ) : (
        <ul
          ref={listRef}
          id={listId}
          className="resume-picker-list"
          role="listbox"
          aria-label="Resumable provider chats"
        >
          {visible.map((row, index) => {
            const optionId =
              `${reactId}-resume-option-${row.option.conversationId}`;
            const selected =
              row.option.conversationId === selectedConversationId;
            return (
              <li key={row.option.conversationId} role="presentation">
                <button
                  type="button"
                  id={optionId}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={!row.selectable}
                  data-active={index === activeIndex ? "true" : undefined}
                  data-selected={selected ? "true" : undefined}
                  data-unavailable={row.selectable ? undefined : "true"}
                  disabled={busy}
                  tabIndex={-1}
                  onPointerEnter={() => {
                    if (row.selectable) setActiveIndex(index);
                  }}
                  onClick={() => commit(index)}
                >
                  <MessagesSquare
                    className="resume-picker-option-icon"
                    size={14}
                    aria-hidden="true"
                  />
                  <span className="resume-picker-option-copy">
                    <strong>{row.option.conversationTitle}</strong>
                    <small>
                      {row.providerLabel
                        ? `${row.option.projectName} · ${row.providerLabel}`
                        : row.option.projectName}
                    </small>
                    {row.note && (
                      <em className="resume-picker-option-note">{row.note}</em>
                    )}
                  </span>
                  {row.sessionId && (
                    <code title={row.sessionId}>{row.sessionId}</code>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="resume-picker-footer">
        <span><kbd>↑↓</kbd> navigate</span>
        <span><kbd>↵</kbd> resume</span>
        {onCancel && <span><kbd>Esc</kbd> close</span>}
      </div>
    </div>
  );
}
