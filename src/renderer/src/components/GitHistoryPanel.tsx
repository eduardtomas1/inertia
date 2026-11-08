import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CircleAlert, GitCommitHorizontal, GitMerge, RefreshCw } from "lucide-react";
import clsx from "clsx";

import type { DiffFile, DiffLine } from "@shared/contracts";
import type { GitCommitDetail, GitLogCommit } from "@shared/contracts/git-history";
import { diffHunkFingerprint, parseUnifiedDiff } from "@shared/diff-review";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { formatRelativeTime } from "../lib/format";
import { captureModalFocus } from "../utils/modalFocus";
import { diffFileRenders, intralineSegments, type DiffHunkRender } from "../utils/diffHighlighting";
import {
  errorMessage,
  requestGitCommit,
  requestGitLog,
  type GitHistoryRun,
  type GitHistoryScope,
} from "../utils/gitHistoryCommands";
import { DialogShell } from "./DialogShell";
import { IconButton, LoadingMark } from "./ui";
import "./git-history.css";

export interface GitHistoryPanelProps extends GitHistoryScope {
  open: boolean;
  /** Shown in the description, e.g. the current branch. */
  branch?: string | null;
  run: GitHistoryRun;
  onClose: () => void;
}

const FILE_STATUS_LABELS: Record<GitCommitDetail["files"][number]["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  "type-changed": "Type changed",
  unmerged: "Unmerged",
  unknown: "Changed",
};

function linePrefix(line: DiffLine): string {
  return line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " ";
}

/**
 * Same rendering contract as the Changes panel: markup is used only when
 * `markedHighlightHtml` verified it as highlight.js spans around escaped text
 * equal to the line; every other line renders through React text nodes.
 */
function CommitDiffLineText({ line, render, index }: { line: DiffLine; render: DiffHunkRender; index: number }): React.JSX.Element {
  const html = render.html[index] ?? null;
  if (html !== null) return <span className="diff-line-content hljs" dangerouslySetInnerHTML={{ __html: html || " " }} />;
  const ranges = render.ranges[index];
  if (ranges && ranges.length > 0) {
    return (
      <span className="diff-line-content">
        {intralineSegments(line.content, ranges).map((segment, position) => (
          <Fragment key={position}>{segment.changed ? <mark className="diff-intraline">{segment.text}</mark> : segment.text}</Fragment>
        ))}
      </span>
    );
  }
  return <span className="diff-line-content">{line.content || " "}</span>;
}

function CommitDiff({ file }: { file: DiffFile }): React.JSX.Element {
  // Files over 4,000 lines or with a line over 2,000 characters fall back to
  // plain text without intraline emphasis, as in the Changes panel.
  const renders = useMemo(() => diffFileRenders(file, (hunk) => diffHunkFingerprint(file, hunk)), [file]);
  return (
    <div className="diff-code git-history-diff" role="region" aria-label={`Diff for ${file.path}`} tabIndex={0}>
      {file.hunks.map((hunk, hunkIndex) => (
        <section className="diff-hunk" key={hunk.id}>
          <div className="diff-hunk-header"><code>{hunk.header}</code></div>
          {hunk.lines.map((line, index) => (
            <div className={clsx("diff-line", `is-${line.kind}`)} key={line.id}>
              <span className="diff-line-number" aria-hidden="true">{line.oldLineNumber ?? ""}</span>
              <span className="diff-line-number" aria-hidden="true">{line.newLineNumber ?? ""}</span>
              <span className="diff-line-prefix" aria-hidden="true">{linePrefix(line)}</span>
              <CommitDiffLineText line={line} render={renders[hunkIndex]!} index={index} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function CommitDetailView({
  commit,
  selectedPath,
  onSelectPath,
}: {
  commit: GitCommitDetail;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}): React.JSX.Element {
  // Cut a truncated patch at its last complete line before parsing.
  const patch = commit.diffTruncated
    ? commit.diff.slice(0, commit.diff.lastIndexOf("\n") + 1)
    : commit.diff;
  const structured = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const activePath = selectedPath ?? commit.files[0]?.path ?? null;
  const diffFile = structured.files.find((file) =>
    file.path === activePath || file.newPath === activePath || file.oldPath === activePath) ?? null;
  return (
    <div className="git-history-detail">
      <header className="git-history-detail-heading">
        <h3>{commit.subject || "(no subject)"}</h3>
        <p>
          <code title={commit.sha}>{commit.shortSha}</code>
          <span>{commit.authorName}</span>
          <time dateTime={commit.authorDate} title={new Date(commit.authorDate).toLocaleString()}>
            {formatRelativeTime(commit.authorDate)}
          </time>
          {commit.isMerge && <span className="git-history-badge">Merge · compared with first parent</span>}
          {commit.parents.length === 0 && <span className="git-history-badge">Root commit</span>}
        </p>
        {commit.body && <pre className="git-history-body">{commit.body}</pre>}
        {commit.bodyTruncated && <p className="git-history-caution">The message is truncated.</p>}
      </header>
      {commit.files.length === 0 ? (
        <p className="git-history-empty">No file changes compared with the first parent.</p>
      ) : (
        <ul className="git-history-files" aria-label={`Files changed in ${commit.shortSha}`}>
          {commit.files.map((file) => (
            <li key={`${file.previousPath ?? ""}\0${file.path}`}>
              <button
                type="button"
                aria-pressed={file.path === activePath}
                onClick={() => onSelectPath(file.path)}
              >
                <span className="git-history-file-status">{FILE_STATUS_LABELS[file.status]}</span>
                <span className="git-history-file-path" title={file.path}>
                  {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                </span>
                <span className="git-history-file-stats">
                  {file.additions === null
                    ? "Binary"
                    : <><span className="file-insertions">+{file.additions}</span> <span className="file-deletions">−{file.deletions}</span></>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {commit.filesTruncated && <p className="git-history-caution">Only the first {commit.files.length} files are listed.</p>}
      {activePath && (diffFile && diffFile.hunks.length > 0
        ? <CommitDiff file={diffFile} />
        : <p className="git-history-empty">No text diff is shown for {activePath}{commit.diffTruncated ? " (the diff is truncated)" : ""}.</p>)}
      {commit.diffTruncated && diffFile && (
        <p className="git-history-caution">The diff is truncated at 256 KiB. Use the terminal for the complete diff.</p>
      )}
    </div>
  );
}

/**
 * Read-only commit history for the active checkout (or one nested
 * repository). It never checks out, resets, reverts or cherry-picks.
 */
export function GitHistoryPanel({
  open,
  projectId,
  conversationId,
  repositoryPath,
  authorityRef,
  branch = null,
  run,
  onClose,
}: GitHistoryPanelProps): React.JSX.Element | null {
  // A status refresh issues a new authorityRef for the same nested
  // repository, so requests read the latest one while the list, selection
  // and focus stay keyed on the repository itself.
  const hasAuthority = Boolean(repositoryPath && authorityRef);
  const latestRequest = useRef({ run, authorityRef });
  useLayoutEffect(() => {
    latestRequest.current = { run, authorityRef };
  }, [authorityRef, run]);
  const requestScope = useCallback((): GitHistoryScope => {
    const latestAuthority = hasAuthority ? latestRequest.current.authorityRef : undefined;
    return {
      projectId,
      ...(conversationId ? { conversationId } : {}),
      ...(repositoryPath && latestAuthority ? { repositoryPath, authorityRef: latestAuthority } : {}),
    };
  }, [conversationId, hasAuthority, projectId, repositoryPath]);
  const [commits, setCommits] = useState<GitLogCommit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const listRevision = useRef(0);
  const detailRevision = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useNativePreviewSuspension(open);

  const loadPage = useCallback(async (cursor: string | null): Promise<void> => {
    const revision = ++listRevision.current;
    setLoading(true);
    setListError(null);
    try {
      const page = await requestGitLog(latestRequest.current.run, requestScope(), { cursor });
      if (revision !== listRevision.current) return;
      setCommits((current) => cursor ? [...current, ...page.commits] : page.commits);
      setNextCursor(page.nextCursor);
      if (!cursor) {
        setSelectedSha((current) => current && page.commits.some(({ sha }) => sha === current)
          ? current
          : page.commits[0]?.sha ?? null);
      }
    } catch (error) {
      if (revision === listRevision.current) setListError(errorMessage(error, "History could not be loaded."));
    } finally {
      if (revision === listRevision.current) setLoading(false);
    }
  }, [requestScope]);

  useEffect(() => {
    if (!open) return;
    const restoreFocus = captureModalFocus(false);
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      restoreFocus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setCommits([]);
    setNextCursor(null);
    setSelectedSha(null);
    void loadPage(null);
    return () => {
      listRevision.current += 1;
      detailRevision.current += 1;
    };
  }, [loadPage, open]);

  useEffect(() => {
    if (!open || !selectedSha) {
      setDetail(null);
      return;
    }
    const revision = ++detailRevision.current;
    setDetailLoading(true);
    setDetailError(null);
    setSelectedPath(null);
    void requestGitCommit(latestRequest.current.run, requestScope(), selectedSha).then((commit) => {
      if (revision === detailRevision.current) setDetail(commit);
    }).catch((error: unknown) => {
      if (revision !== detailRevision.current) return;
      setDetail(null);
      setDetailError(errorMessage(error, "This commit could not be loaded."));
    }).finally(() => {
      if (revision === detailRevision.current) setDetailLoading(false);
    });
  }, [open, requestScope, selectedSha]);

  const selectAt = (index: number): void => {
    const target = commits[Math.max(0, Math.min(commits.length - 1, index))];
    if (!target) return;
    setSelectedSha(target.sha);
    window.requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-sha="${target.sha}"]`)?.focus();
    });
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const index = commits.findIndex(({ sha }) => sha === selectedSha);
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: commits.length - 1,
      PageDown: index + 10,
      PageUp: index - 10,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectAt(next);
  };

  if (!open) return null;
  const description = branch
    ? `Read-only commits on ${branch}${repositoryPath && repositoryPath !== "." ? ` in ${repositoryPath}` : ""}.`
    : "Read-only commit history.";
  return (
    <DialogShell
      className="git-history-dialog"
      backdropClassName="git-history-backdrop"
      bodyClassName="git-history-body-layout is-flush"
      titleId="git-history-title"
      title="History"
      description={description}
      descriptionId="git-history-description"
      closeLabel="Close history"
      closeRef={closeRef}
      onClose={onClose}
      onDismiss={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      headerActions={(
        <IconButton label="Reload history" onClick={() => void loadPage(null)} disabled={loading}>
          {loading && commits.length === 0 ? <LoadingMark label="Loading history" size={16} /> : <RefreshCw size={16} />}
        </IconButton>
      )}
      footerStart={<>{commits.length} {commits.length === 1 ? "commit" : "commits"} loaded{nextCursor ? "" : commits.length > 0 ? " · end of history" : ""}</>}
      footer={<button type="button" className="primary-button" onClick={onClose}>Done</button>}
    >
      <div className="git-history-columns">
        <div className="git-history-list-column">
          {listError && (
            <div className="git-history-alert" role="alert">
              <CircleAlert size={14} aria-hidden="true" /><span>{listError}</span>
            </div>
          )}
          {commits.length === 0 && loading && (
            <div className="git-history-empty" role="status"><LoadingMark label="Loading history" /> Loading commits…</div>
          )}
          {commits.length === 0 && !loading && !listError && (
            <p className="git-history-empty">This branch has no commits yet.</p>
          )}
          {commits.length > 0 && (
            <ul
              ref={listRef}
              className="git-history-list"
              role="listbox"
              aria-label="Commits"
              onKeyDown={onListKeyDown}
            >
              {commits.map((commit) => {
                const selected = commit.sha === selectedSha;
                return (
                  <li
                    key={commit.sha}
                    role="option"
                    data-sha={commit.sha}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className={clsx("git-history-row", selected && "is-selected")}
                    onClick={() => setSelectedSha(commit.sha)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedSha(commit.sha);
                      }
                    }}
                  >
                    {commit.isMerge
                      ? <GitMerge size={14} aria-label="Merge commit" />
                      : <GitCommitHorizontal size={14} aria-hidden="true" />}
                    <span className="git-history-row-subject">{commit.subject || "(no subject)"}</span>
                    <span className="git-history-row-meta">
                      <code>{commit.shortSha}</code>
                      <span>{commit.authorName}</span>
                      <time dateTime={commit.authorDate}>{formatRelativeTime(commit.authorDate)}</time>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {nextCursor && (
            <button
              type="button"
              className="secondary-button git-history-more"
              disabled={loading}
              onClick={() => void loadPage(nextCursor)}
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
        <div className="git-history-detail-column" aria-live="polite" aria-busy={detailLoading}>
          {detailError ? (
            <div className="git-history-alert" role="alert">
              <CircleAlert size={14} aria-hidden="true" /><span>{detailError}</span>
            </div>
          ) : detail && detail.sha === selectedSha ? (
            <CommitDetailView commit={detail} selectedPath={selectedPath} onSelectPath={setSelectedPath} />
          ) : selectedSha ? (
            <div className="git-history-empty" role="status"><LoadingMark label="Loading commit" /> Loading commit…</div>
          ) : (
            <p className="git-history-empty">Select a commit to see its files and diff.</p>
          )}
        </div>
      </div>
    </DialogShell>
  );
}

export default GitHistoryPanel;
