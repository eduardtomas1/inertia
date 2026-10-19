import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { History } from "lucide-react";
import clsx from "clsx";

import type { WorkspaceFilePreview } from "@shared/contracts";
import { GIT_HISTORY_LIMITS, type GitBlameLine, type GitBlamePage } from "@shared/contracts/git-history";
import { formatRelativeTime } from "../lib/format";
import { TooltipButton } from "./TooltipButton";
import "./git-history.css";

export type FilePreviewBlameLoader = (request: {
  path: string;
  startLine: number;
  endLine: number;
}) => Promise<GitBlamePage>;

const PAGE = GIT_HISTORY_LIMITS.blameLinesPerPage;

interface BlameInputs {
  preview: WorkspaceFilePreview | null;
  load: FilePreviewBlameLoader | undefined;
  /** Rendered Markdown has no source lines to annotate. */
  markdownPreview: boolean;
  /** The preview's path is known to be untracked by the workspace Git status. */
  untracked: boolean;
  /** Line numbers currently rendered (virtualized previews render a window). */
  renderedLines: readonly { lineNumber: number }[];
}

export interface FilePreviewBlame {
  enabled: boolean;
  available: boolean;
  unavailableReason: string | null;
  loading: boolean;
  error: string | null;
  toggle: () => void;
  entry: (line: number) => GitBlameLine | undefined;
  /** True when this line starts a run of lines from the same commit. */
  runStart: (line: number) => boolean;
  rovingLine: number | null;
  setRovingLine: (line: number) => void;
}

function blameUnavailableReason(
  preview: WorkspaceFilePreview | null,
  load: FilePreviewBlameLoader | undefined,
  markdownPreview: boolean,
  untracked: boolean,
  serverState: GitBlamePage["state"] | null,
): string | null {
  if (!preview || !load) return "Blame is unavailable here.";
  if (markdownPreview) return "Switch to Source to show blame.";
  if (untracked || serverState === "untracked") return "Untracked files have no blame.";
  if (serverState === "binary") return "Binary files have no blame.";
  if (serverState === "unsupported") return "Blame is unavailable for this file.";
  return null;
}

/**
 * Loads blame for the visible part of a source preview in 2,000-line pages.
 * Off by default; state resets whenever the previewed file or its content
 * digest changes, and late responses for an older file are ignored.
 */
interface BlameState {
  identity: string;
  on: boolean;
  lines: ReadonlyMap<number, GitBlameLine>;
  pages: ReadonlySet<number>;
  loadingPages: ReadonlySet<number>;
  error: string | null;
  serverState: GitBlamePage["state"] | null;
}

function freshBlameState(identity: string, on: boolean): BlameState {
  return { identity, on, lines: new Map(), pages: new Set(), loadingPages: new Set(), error: null, serverState: null };
}

export function useFilePreviewBlame({
  preview,
  load,
  markdownPreview,
  untracked,
  renderedLines,
}: BlameInputs): FilePreviewBlame {
  const identity = preview ? `${preview.path}\0${preview.contentDigest}` : "";
  const [state, setState] = useState<BlameState>(() => freshBlameState(identity, false));
  const [rovingLine, setRovingLine] = useState<number | null>(null);
  // A new file (or new content) starts from empty blame but keeps the toggle.
  const current = useMemo(
    () => state.identity === identity ? state : freshBlameState(identity, state.on),
    [identity, state],
  );
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const binary = useMemo(() => preview?.content.includes("\0") ?? false, [preview]);
  const unavailableReason = blameUnavailableReason(preview, load, markdownPreview, untracked, binary ? "binary" : current.serverState);
  const enabled = current.on && unavailableReason === null;

  const firstLine = renderedLines[0]?.lineNumber ?? 1;
  const lastLine = renderedLines.at(-1)?.lineNumber ?? firstLine;
  const firstPage = Math.floor((firstLine - 1) / PAGE);
  const lastPage = Math.floor((lastLine - 1) / PAGE);

  const loadPage = useCallback(async (page: number): Promise<void> => {
    if (!preview || !load) return;
    const requestIdentity = identity;
    const pageEnd = (page + 1) * PAGE;
    let startLine = page * PAGE + 1;
    const loaded = new Map<number, GitBlameLine>();
    let serverState: GitBlamePage["state"] = "ready";
    let error: string | null = null;
    try {
      // A page normally arrives whole; a bounded partial page continues.
      for (let attempt = 0; attempt < 4 && startLine <= pageEnd; attempt += 1) {
        const result = await load({ path: preview.path, startLine, endLine: pageEnd });
        serverState = result.state;
        for (const line of result.lines) loaded.set(line.line, line);
        if (result.state !== "ready" || result.nextStartLine === null || result.endLine >= pageEnd) break;
        startLine = result.nextStartLine;
      }
    } catch (reason) {
      error = reason instanceof Error && reason.message ? reason.message : "Blame could not be loaded.";
    }
    if (identityRef.current !== requestIdentity) return;
    setState((previous) => {
      if (previous.identity !== requestIdentity) return previous;
      const lines = new Map(previous.lines);
      for (const [line, entry] of loaded) lines.set(line, entry);
      const loadingPages = new Set(previous.loadingPages);
      loadingPages.delete(page);
      const pages = new Set(previous.pages);
      if (!error) pages.add(page);
      return {
        ...previous,
        lines,
        pages,
        loadingPages,
        error,
        serverState,
        on: serverState === "ready" ? previous.on : false,
      };
    });
  }, [identity, load, preview]);

  useEffect(() => {
    if (!enabled) return;
    const wanted: number[] = [];
    for (let page = firstPage; page <= lastPage; page += 1) {
      if (!current.pages.has(page) && !current.loadingPages.has(page) && current.error === null) wanted.push(page);
    }
    if (wanted.length === 0) return;
    setState((previous) => ({
      ...(previous.identity === identity ? previous : current),
      loadingPages: new Set([...(previous.identity === identity ? previous.loadingPages : []), ...wanted]),
    }));
    for (const page of wanted) void loadPage(page);
  }, [current, enabled, firstPage, identity, lastPage, loadPage]);

  const toggle = useCallback(() => {
    setState((previous) => {
      const base = previous.identity === identity ? previous : freshBlameState(identity, previous.on);
      return { ...base, on: !base.on, error: null };
    });
  }, [identity]);

  const entry = useCallback((line: number) => current.lines.get(line), [current.lines]);
  const runStart = useCallback((line: number) => {
    const value = current.lines.get(line);
    if (!value) return false;
    return current.lines.get(line - 1)?.sha !== value.sha;
  }, [current.lines]);

  const focusLine = useMemo(() => {
    if (rovingLine !== null && current.lines.has(rovingLine)) return rovingLine;
    let first: number | null = null;
    for (const line of current.lines.keys()) if (first === null || line < first) first = line;
    return first;
  }, [current.lines, rovingLine]);

  return {
    enabled,
    available: unavailableReason === null,
    unavailableReason,
    loading: current.loadingPages.size > 0,
    error: current.error,
    toggle,
    entry,
    runStart,
    rovingLine: focusLine,
    setRovingLine,
  };
}

export function FilePreviewBlameToggle({ blame }: { blame: FilePreviewBlame }): React.JSX.Element {
  const hint = blame.unavailableReason
    ?? blame.error
    ?? (blame.loading ? "Loading blame…" : blame.enabled ? "Hide blame" : "Show blame");
  return (
    <TooltipButton
      type="button"
      className={clsx("file-preview-blame-toggle", blame.error && "has-error")}
      aria-pressed={blame.enabled}
      aria-busy={blame.loading || undefined}
      disabled={!blame.available}
      tooltip={hint}
      describeTooltip={false}
      onClick={blame.toggle}
    >
      <History size={14} aria-hidden="true" />
      <span>Blame</span>
    </TooltipButton>
  );
}

function blameLabel(entry: GitBlameLine): string {
  return entry.uncommitted
    ? "Not committed"
    : `${entry.shortSha} · ${entry.authorName} · ${formatRelativeTime(entry.authorDate)}`;
}

/**
 * One gutter cell; only the first line of a same-commit run shows text. The
 * cell holds the short SHA and author (the author drops out in a narrow
 * preview); the date and summary live in the popover and the accessible name.
 */
export function FilePreviewBlameGutter({
  blame,
  line,
}: {
  blame: FilePreviewBlame;
  line: number;
}): React.JSX.Element {
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const entry = blame.entry(line);
  const start = blame.runStart(line);
  const label = useMemo(() => entry ? blameLabel(entry) : "", [entry]);
  if (!entry || !start) {
    return <span className="file-preview-blame" aria-hidden="true" />;
  }
  const move = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    const buttons = [...(event.currentTarget.closest("code")?.querySelectorAll<HTMLButtonElement>("button[data-blame-line]") ?? [])];
    const index = buttons.indexOf(event.currentTarget);
    const next = buttons[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      blame.setRovingLine(Number(next.dataset.blameLine));
      next.focus();
    }
  };
  return (
    <span className="file-preview-blame">
      <button
        type="button"
        data-blame-line={line}
        tabIndex={blame.rovingLine === line ? 0 : -1}
        aria-label={`Line ${line}: ${label}. ${entry.uncommitted ? "Uncommitted change" : entry.summary}`}
        aria-describedby={open ? popoverId : undefined}
        onFocus={() => { blame.setRovingLine(line); setOpen(true); }}
        onBlur={() => setOpen(false)}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onKeyDown={move}
      >
        {entry.uncommitted ? (
          <span className="file-preview-blame-author">Not committed</span>
        ) : (
          <>
            <code className="file-preview-blame-sha">{entry.shortSha}</code>
            <span className="file-preview-blame-author">{entry.authorName}</span>
          </>
        )}
      </button>
      {open && (
        <span className="file-preview-blame-popover" role="tooltip" id={popoverId}>
          <strong>{entry.uncommitted ? "Uncommitted change" : entry.summary || "(no subject)"}</strong>
          <span>{entry.uncommitted ? "Not committed yet" : entry.authorName}</span>
          {!entry.uncommitted && (
            <time dateTime={entry.authorDate} title={new Date(entry.authorDate).toLocaleString()}>
              {formatRelativeTime(entry.authorDate)} · {new Date(entry.authorDate).toLocaleString()}
            </time>
          )}
          {!entry.uncommitted && <code>{entry.sha.slice(0, 12)}</code>}
        </span>
      )}
    </span>
  );
}
