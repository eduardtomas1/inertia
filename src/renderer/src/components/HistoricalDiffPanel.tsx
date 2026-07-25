import { ExternalLink, GitCompareArrows, RotateCcw } from "lucide-react";
import clsx from "clsx";

import type {
  DiffFile,
  TurnGitDiffSnapshot,
} from "@shared/contracts";
import { parseUnifiedDiff } from "@shared/diff-review";

export interface HistoricalDiffPanelProps {
  diff: TurnGitDiffSnapshot;
  selectedPath: string | null;
  wrapLines: boolean;
  onSelectFile: (path: string) => void;
  onOpenFile: (path: string) => void;
  onShowCurrentChanges: () => void;
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function HistoricalFileDiff({
  file,
  wrapLines,
}: {
  file: DiffFile;
  wrapLines: boolean;
}): React.JSX.Element {
  return (
    <div className={clsx("diff-code historical-diff-code", wrapLines && "wraps")} role="region" aria-label={`Historical diff for ${file.path}`}>
      {file.hunks.map((hunk) => (
        <section className="diff-hunk" key={hunk.id}>
          <div className="diff-hunk-header"><code>{hunk.header}</code></div>
          {hunk.lines.map((line) => (
            <div className={clsx("diff-line", `is-${line.kind}`)} key={line.id}>
              <span className="diff-line-number" aria-hidden="true">{line.oldLineNumber ?? ""}</span>
              <span className="diff-line-number" aria-hidden="true">{line.newLineNumber ?? ""}</span>
              <span className="diff-line-prefix">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}</span>
              <span className="diff-line-content">{line.content || " "}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function HistoricalDiffPanel({
  diff,
  selectedPath,
  wrapLines,
  onSelectFile,
  onOpenFile,
  onShowCurrentChanges,
}: HistoricalDiffPanelProps): React.JSX.Element {
  const structured = parseUnifiedDiff(diff.patch);
  const selectedFile = selectedPath
    ? structured.files.find(({ path }) => path === selectedPath) ?? null
    : structured.files[0] ?? null;
  const insertions = diff.files.reduce((total, file) => total + file.insertions, 0);
  const deletions = diff.files.reduce((total, file) => total + file.deletions, 0);

  return (
    <section className="changes-panel historical-diff-panel" aria-label="Historical turn changes">
      <header className="panel-toolbar">
        <div className="panel-heading">
          <GitCompareArrows size={17} aria-hidden="true" />
          <div className="panel-heading-copy">
            <h2>{diff.title}</h2>
            <span>Historical snapshot · not current workspace state</span>
          </div>
        </div>
        <div className="panel-stats">
          <span className="stat-additions">+{insertions}</span>
          <span className="stat-deletions">−{deletions}</span>
          <button type="button" className="subtle-button" onClick={onShowCurrentChanges}>
            <RotateCcw size={13} />Current changes
          </button>
        </div>
      </header>

      {diff.completeness !== "complete" && (
        <div className="historical-diff-notice">
          This capture is {diff.completeness}. The visible patch is the retained historical data, not a reconstruction from today’s workspace.
        </div>
      )}

      {diff.files.length === 0 ? (
        <div className="panel-empty changes-empty">
          <GitCompareArrows size={22} />
          <h3>No files changed by this turn</h3>
          <p>The before and after snapshots are identical.</p>
        </div>
      ) : (
        <div className="changes-layout">
          <div className="changes-file-picker">
            <span>Historical file</span>
            <select
              aria-label="Historical changed file"
              value={selectedFile?.path ?? diff.files[0]?.path ?? ""}
              onChange={(event) => onSelectFile(event.target.value)}
            >
              {diff.files.map((file) => (
                <option value={file.path} key={file.path}>{file.status} · {file.path}</option>
              ))}
            </select>
          </div>
          <nav className="changes-file-list" aria-label="Files changed by this turn">
            {diff.files.map((file) => (
              <button
                type="button"
                className={clsx("change-file-button", file.path === selectedFile?.path && "is-selected")}
                aria-pressed={file.path === selectedFile?.path}
                onClick={() => onSelectFile(file.path)}
                key={file.path}
              >
                <span className="change-file-copy">
                  <span className="change-file-name">{fileName(file.path)}</span>
                  <span className="change-file-path">{file.path}</span>
                </span>
                <span className="change-file-stats">
                  <span>{file.status}</span>
                  <span><span className="file-insertions">+{file.insertions}</span> <span className="file-deletions">−{file.deletions}</span></span>
                </span>
              </button>
            ))}
          </nav>
          <div className="diff-review">
            {selectedFile ? (
              <>
                <div className="diff-file-review-heading">
                  <div><strong>{selectedFile.path}</strong><span>Exact turn artifact</span></div>
                  <button type="button" className="subtle-button" onClick={() => onOpenFile(selectedFile.path)}>
                    <ExternalLink size={12} />Open current file
                  </button>
                </div>
                <HistoricalFileDiff file={selectedFile} wrapLines={wrapLines} />
              </>
            ) : (
              <div className="panel-empty"><p>The retained patch does not contain this file’s text diff.</p></div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
