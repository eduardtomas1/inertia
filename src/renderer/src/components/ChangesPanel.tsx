import { useMemo } from "react";
import clsx from "clsx";
import { FileCode2, GitCompareArrows, RefreshCw } from "lucide-react";
import type { ChangedFile, GitDiffSnapshot } from "@shared/contracts";
import { IconButton, LoadingMark } from "./ui";

export type ChangesPanelProps = {
  files: ChangedFile[];
  diff: GitDiffSnapshot | null;
  selectedPath: string | null;
  loading?: boolean;
  wrapLines?: boolean;
  onSelectFile: (path: string) => void;
  onRefresh?: () => void;
};

function pathParts(path: string): { name: string; parent: string } {
  const parts = path.split(/[\\/]/);
  return {
    name: parts.at(-1) ?? path,
    parent: parts.slice(0, -1).join("/"),
  };
}

function statusLabel(file: ChangedFile): string {
  const status = file.status.trim().toLowerCase();
  if (file.untracked || status === "??" || status === "untracked") return "Untracked";
  if (status === "a" || status === "added") return "Added";
  if (status === "d" || status === "deleted") return "Deleted";
  if (status === "r" || status === "renamed") return "Renamed";
  if (status === "c" || status === "copied") return "Copied";
  if (["u", "aa", "dd", "unmerged", "conflict"].includes(status)) return "Conflict";
  if (status === "t" || status === "type-changed") return "Type changed";
  if (status === "unknown") return "Unknown";
  return "Modified";
}

function statusCode(file: ChangedFile): string {
  const label = statusLabel(file);
  if (label === "Untracked") return "U";
  if (label === "Conflict") return "!";
  if (label === "Type changed") return "T";
  if (label === "Unknown") return "?";
  return label.charAt(0);
}

function patchForPath(patch: string, path: string | null, fileCount: number): string {
  if (!patch || !path || fileCount <= 1) return patch;
  const blocks = patch.split(/(?=^diff --git )/m).filter(Boolean);
  return blocks.find((block) => {
    const header = block.split("\n", 1)[0] ?? "";
    return header.includes(` a/${path} `) || header.endsWith(` b/${path}`);
  }) ?? "";
}

function lineKind(line: string): string {
  if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
    return "is-header";
  }
  if (line.startsWith("@@")) return "is-hunk";
  if (line.startsWith("+")) return "is-addition";
  if (line.startsWith("-")) return "is-deletion";
  return "is-context";
}

export function ChangesPanel({
  files,
  diff,
  selectedPath,
  loading = false,
  wrapLines = true,
  onSelectFile,
  onRefresh,
}: ChangesPanelProps): React.JSX.Element {
  const totals = useMemo(() => files.reduce(
    (result, file) => ({
      insertions: result.insertions + file.insertions,
      deletions: result.deletions + file.deletions,
    }),
    { insertions: 0, deletions: 0 },
  ), [files]);
  const visiblePatch = patchForPath(diff?.patch ?? "", selectedPath, files.length);
  const patchLines = visiblePatch ? visiblePatch.split("\n") : [];

  return (
    <section className="changes-panel" aria-label="Workspace changes" aria-busy={loading}>
      <header className="panel-toolbar">
        <div className="panel-heading">
          <GitCompareArrows size={17} aria-hidden="true" />
          <div className="panel-heading-copy">
            <h2>Changes</h2>
            <span>{files.length} {files.length === 1 ? "file" : "files"}</span>
          </div>
        </div>
        <div className="panel-stats" aria-label={`${totals.insertions} insertions and ${totals.deletions} deletions`}>
          <span className="stat-additions">+{totals.insertions}</span>
          <span className="stat-deletions">−{totals.deletions}</span>
          {onRefresh && (
            <IconButton label="Refresh changes" onClick={onRefresh} disabled={loading}>
              {loading ? <LoadingMark label="Refreshing changes" /> : <RefreshCw size={15} />}
            </IconButton>
          )}
        </div>
      </header>

      {files.length === 0 ? (
        <div className="panel-empty changes-empty">
          <GitCompareArrows size={22} aria-hidden="true" />
          <h3>No local changes</h3>
          <p>Edits made in this workspace will appear here.</p>
        </div>
      ) : (
        <div className="changes-layout">
          <div className="changes-file-picker">
            <span>Reviewing</span>
            <select
              aria-label="Changed file"
              value={selectedPath ?? files[0]?.path ?? ""}
              onChange={(event) => onSelectFile(event.target.value)}
            >
              {files.map((file) => (
                <option value={file.path} key={file.path}>{statusCode(file)} · {file.path}</option>
              ))}
            </select>
          </div>
          <nav className="changes-file-list" aria-label="Changed files">
            {files.map((file) => {
              const parts = pathParts(file.path);
              const selected = file.path === selectedPath;
              return (
                <button
                  type="button"
                  className={clsx("change-file-button", selected && "is-selected")}
                  aria-pressed={selected}
                  onClick={() => onSelectFile(file.path)}
                  key={file.path}
                >
                  <span className="change-file-leading">
                    <FileCode2 size={15} aria-hidden="true" />
                    <span className="change-file-status" title={statusLabel(file)}>{statusCode(file)}</span>
                  </span>
                  <span className="change-file-copy">
                    <span className="change-file-name">{parts.name}</span>
                    {parts.parent && <span className="change-file-path">{parts.parent}</span>}
                  </span>
                  <span className="change-file-stats" aria-label={`${file.insertions} insertions and ${file.deletions} deletions`}>
                    <span className="file-insertions">+{file.insertions}</span>
                    <span className="file-deletions">−{file.deletions}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="changes-diff" aria-label={selectedPath ? `Diff for ${selectedPath}` : "Unified diff"}>
            {loading && !diff ? (
              <div className="panel-loading"><LoadingMark label="Loading diff" /><span>Loading diff…</span></div>
            ) : patchLines.length > 0 ? (
              <pre className={clsx("diff-code", wrapLines && "wraps")} tabIndex={0}>
                <code>
                  {patchLines.map((line, index) => (
                    <span className={clsx("diff-line", lineKind(line))} key={`${index}-${line.slice(0, 24)}`}>
                      <span className="diff-line-number" aria-hidden="true">{index + 1}</span>
                      <span className="diff-line-content">{line || " "}</span>
                    </span>
                  ))}
                </code>
              </pre>
            ) : (
              <div className="panel-empty changes-empty">
                <FileCode2 size={22} aria-hidden="true" />
                <h3>{selectedPath ? "No diff available" : "Select a file"}</h3>
                <p>{selectedPath ? "Refresh the change to load its patch." : "Choose a changed file to inspect it."}</p>
              </div>
            )}
            {diff?.truncated && <p className="panel-notice diff-truncated">This diff is truncated to keep the workspace responsive.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
