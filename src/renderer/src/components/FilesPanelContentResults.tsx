import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import clsx from "clsx";
import { ArrowLeft, CircleAlert } from "lucide-react";
import type {
  WorkspaceContentMatch,
  WorkspaceContentSearchPage,
} from "@shared/contracts";
import { isWorkspaceContentSearchQuery } from "@shared/contracts/workspace";
import { contentSnippetParts } from "../utils/filePreviewSelection";
import { workspaceParentPath, workspacePathName } from "../utils/workspaceTree";
import { LoadingMark } from "./ui";

export interface FilesPanelContentResultsProps {
  query: string;
  matches: readonly WorkspaceContentMatch[];
  busy: boolean;
  selectedPath: string | null;
  selectedLine: number | null;
  onOpen: (match: WorkspaceContentMatch) => void;
}

export type FileSearchMode = "names" | "contents";

export interface ContentSearchState {
  matches: WorkspaceContentMatch[] | null;
  truncated: boolean;
  error: string | null;
}

const EMPTY_CONTENT_SEARCH: ContentSearchState = {
  matches: null,
  truncated: false,
  error: null,
};

const CONTENT_SEARCH_DEBOUNCE_MS = 300;
export const CONTENT_SEARCH_REPLACED = "Another search replaced this one. Edit the text to search again.";

/**
 * Debounced content search. Only the newest query may publish results; a
 * reset (new typing or a mode switch) discards any search still in flight.
 */
export function useFilesContentSearch(
  enabled: boolean,
  query: string,
  onSearchContent?: (query: string) => Promise<WorkspaceContentSearchPage>,
): { state: ContentSearchState; reset: () => void } {
  const [state, setState] = useState<ContentSearchState>(EMPTY_CONTENT_SEARCH);
  const generation = useRef(0);
  const reset = useCallback((): void => {
    ++generation.current;
    setState(EMPTY_CONTENT_SEARCH);
  }, []);

  useEffect(() => () => {
    ++generation.current;
  }, []);

  useEffect(() => {
    if (!enabled || !onSearchContent || !query.trim()) return;
    const current = ++generation.current;
    if (!isWorkspaceContentSearchQuery(query)) {
      setState({
        matches: [],
        truncated: false,
        error: "Search text must be 1 to 200 characters.",
      });
      return;
    }
    setState(EMPTY_CONTENT_SEARCH);
    const timer = window.setTimeout(() => {
      void onSearchContent(query).then(
        (page) => {
          if (generation.current !== current) return;
          if (page.cancelled) {
            // Only another search from this window replaces a current one.
            setState({ matches: [], truncated: false, error: CONTENT_SEARCH_REPLACED });
            return;
          }
          setState({ matches: page.matches, truncated: page.truncated, error: null });
        },
        (error: unknown) => {
          if (generation.current !== current) return;
          setState({
            matches: [],
            truncated: false,
            error: error instanceof Error && error.message.trim()
              ? error.message
              : "Search failed.",
          });
        },
      );
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, onSearchContent, query]);

  return { state, reset };
}

export function FilesSearchModeToggle({
  contentMode,
  onChoose,
}: {
  contentMode: boolean;
  onChoose: (mode: FileSearchMode) => void;
}): React.JSX.Element {
  return (
    <div className="file-search-mode" role="group" aria-label="Search in">
      <button
        type="button"
        aria-pressed={!contentMode}
        onClick={() => onChoose("names")}
      >
        Names
      </button>
      <button
        type="button"
        aria-pressed={contentMode}
        onClick={() => onChoose("contents")}
      >
        Contents
      </button>
    </div>
  );
}

function matchKey(match: WorkspaceContentMatch): string {
  return `${match.projectPath}\0${match.line}`;
}

export function FilesPanelContentResults({
  query,
  matches,
  busy,
  selectedPath,
  selectedLine,
  onOpen,
}: FilesPanelContentResultsProps): React.JSX.Element {
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const keys = matches.map(matchKey);
  const selectedKey = selectedPath && selectedLine !== null
    ? `${selectedPath}\0${selectedLine}`
    : null;
  const rovingKey = focusedKey && keys.includes(focusedKey)
    ? focusedKey
    : selectedKey && keys.includes(selectedKey)
      ? selectedKey
      : keys[0] ?? null;

  const focusIndex = (index: number): void => {
    const key = keys[Math.min(Math.max(0, index), keys.length - 1)];
    if (key === undefined) return;
    setFocusedKey(key);
    buttons.current.get(key)?.focus();
  };

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    const target = event.key === "ArrowDown"
      ? index + 1
      : event.key === "ArrowUp"
        ? index - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? keys.length - 1
            : null;
    if (target === null) return;
    event.preventDefault();
    focusIndex(target);
  };

  return (
    <ul
      className="file-content-results"
      aria-label="Content search results"
      aria-busy={busy}
    >
      {matches.map((match, index) => {
        const key = keys[index] ?? "";
        const parts = contentSnippetParts(match.snippet, query);
        const parent = workspaceParentPath(match.projectPath);
        return (
          <li key={key}>
            <button
              type="button"
              ref={(node) => {
                if (node) buttons.current.set(key, node);
                else buttons.current.delete(key);
              }}
              className={clsx(
                "file-content-result",
                key === selectedKey && "is-selected",
              )}
              tabIndex={key === rovingKey ? 0 : -1}
              aria-current={key === selectedKey ? "location" : undefined}
              aria-label={`${match.projectPath}, line ${match.line}: ${match.snippet}`}
              title={`${match.projectPath}:${match.line}`}
              onFocus={() => setFocusedKey(key)}
              onClick={() => onOpen(match)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span className="file-content-result-location" aria-hidden="true">
                <strong>{workspacePathName(match.projectPath)}</strong>
                {parent && <small>{parent}</small>}
                <span className="file-content-result-line">Line {match.line}</span>
              </span>
              <code className="file-content-result-snippet" aria-hidden="true">
                {parts
                  ? <>{parts[0]}<mark>{parts[1]}</mark>{parts[2]}</>
                  : match.snippet || " "}
              </code>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function contentMatchCountLabel(count: number): string {
  return `${count} ${count === 1 ? "match" : "matches"}`;
}

export interface FilesContentResultsViewProps {
  query: string;
  state: ContentSearchState;
  selectedPath: string | null;
  selectedLine: number | null;
  onOpen: (match: WorkspaceContentMatch) => void;
}

/** Content search results shown in the Files panel's main (preview) area. */
export function FilesContentResultsView({
  query,
  state,
  selectedPath,
  selectedLine,
  onOpen,
}: FilesContentResultsViewProps): React.JSX.Element {
  const term = `\u201c${query}\u201d`;
  if (state.error) {
    return (
      <div className="panel-empty file-panel-error" role="alert">
        <CircleAlert size={16} aria-hidden="true" />
        <p>{state.error}</p>
      </div>
    );
  }
  if (state.matches === null) {
    return (
      <div className="panel-loading" role="status">
        <LoadingMark label="Searching" />
        <span>Searching for {term}…</span>
      </div>
    );
  }
  return (
    <div className="file-content-results-view">
      <div className="file-content-results-header" role="status">
        <strong>
          {state.matches.length === 0
            ? `No matches for ${term}`
            : `${contentMatchCountLabel(state.matches.length)} for ${term}`}
        </strong>
        {state.truncated && <span>Partial results. Refine for more.</span>}
      </div>
      <FilesPanelContentResults
        query={query}
        matches={state.matches}
        busy={false}
        selectedPath={selectedPath}
        selectedLine={selectedLine}
        onOpen={onOpen}
      />
    </div>
  );
}

/** Returns from an opened match to the content results and focuses the list. */
export function BackToResultsButton({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="file-back-to-results"
      onClick={(event) => {
        const panel = event.currentTarget.closest(".files-panel");
        onBack();
        window.requestAnimationFrame(() => panel
          ?.querySelector<HTMLElement>(".file-content-result[tabindex='0']")
          ?.focus());
      }}
    >
      <ArrowLeft size={14} aria-hidden="true" />
      <span>Back to results</span>
    </button>
  );
}
