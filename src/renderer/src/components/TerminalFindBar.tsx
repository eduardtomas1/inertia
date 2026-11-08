import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { IconButton } from "./ui";

export type TerminalFindDirection = "next" | "previous";

export interface TerminalFindBarProps {
  /** Runs one search step; returns whether a match was found and selected. */
  find: (query: string, direction: TerminalFindDirection, incremental: boolean) => boolean;
  /** Removes match highlights and the selected match once the query is empty. */
  onClearMatches: () => void;
  onClose: () => void;
  /** Bumped by the find shortcut so an open bar takes focus again. */
  focusRequest: number;
}

export const MAX_TERMINAL_FIND_QUERY_LENGTH = 200;

export function TerminalFindBar({
  find,
  onClearMatches,
  onClose,
  focusRequest,
}: TerminalFindBarProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<"idle" | "found" | "missing">("idle");

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const search = (value: string, direction: TerminalFindDirection, incremental: boolean): void => {
    if (!value) {
      setResult("idle");
      onClearMatches();
      return;
    }
    setResult(find(value, direction, incremental) ? "found" : "missing");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      search(query, event.shiftKey ? "previous" : "next", false);
    }
  };

  return (
    <div className="terminal-find-bar" role="search" aria-label="Terminal find" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        type="text"
        className="terminal-find-input"
        aria-label="Find in terminal"
        aria-describedby={statusId}
        placeholder="Find"
        spellCheck={false}
        autoComplete="off"
        maxLength={MAX_TERMINAL_FIND_QUERY_LENGTH}
        value={query}
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          search(value, "next", true);
        }}
      />
      <span id={statusId} className="terminal-find-status" role="status" aria-live="polite">
        {result === "missing" ? "No matches" : ""}
      </span>
      <IconButton label="Previous match" disabled={!query} onClick={() => search(query, "previous", false)}>
        <ChevronUp size={14} />
      </IconButton>
      <IconButton label="Next match" disabled={!query} onClick={() => search(query, "next", false)}>
        <ChevronDown size={14} />
      </IconButton>
      <IconButton label="Close find" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </div>
  );
}
