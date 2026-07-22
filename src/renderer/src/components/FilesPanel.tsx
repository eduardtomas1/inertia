import { useMemo, useState } from "react";
import clsx from "clsx";
import { ExternalLink, File, FileSearch, Folder, RefreshCw, Search, X } from "lucide-react";
import type { WorkspaceEntry, WorkspaceFilePreview } from "@shared/contracts";
import { IconButton, LoadingMark } from "./ui";

export type FilesPanelProps = {
  entries: WorkspaceEntry[];
  preview: WorkspaceFilePreview | null;
  selectedPath: string | null;
  loading?: boolean;
  entriesTruncated?: boolean;
  onSelectFile: (path: string) => void;
  onRefresh?: () => void;
  onSearchChange?: (query: string) => void;
  onOpenFile?: (path: string) => void;
};

function pathParts(path: string): { name: string; parent: string } {
  const parts = path.split(/[\\/]/);
  return {
    name: parts.at(-1) ?? path,
    parent: parts.slice(0, -1).join("/"),
  };
}

export function FilesPanel({
  entries,
  preview,
  selectedPath,
  loading = false,
  entriesTruncated = false,
  onSelectFile,
  onRefresh,
  onSearchChange,
  onOpenFile,
}: FilesPanelProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return entries;
    return entries.filter((entry) => entry.path.toLocaleLowerCase().includes(normalized));
  }, [entries, query]);

  const updateQuery = (value: string) => {
    setQuery(value);
    onSearchChange?.(value);
  };

  return (
    <section className="files-panel" aria-label="Project files" aria-busy={loading}>
      <header className="panel-toolbar files-toolbar">
        <div className="panel-heading">
          <Folder size={17} aria-hidden="true" />
          <div className="panel-heading-copy">
            <h2>Files</h2>
            <span>{entries.length} indexed</span>
          </div>
        </div>
        {onRefresh && (
          <IconButton label="Refresh files" onClick={onRefresh} disabled={loading}>
            {loading ? <LoadingMark label="Refreshing files" /> : <RefreshCw size={15} />}
          </IconButton>
        )}
      </header>

      <div className="file-search-wrap">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          value={query}
          aria-label="Search project files"
          placeholder="Search files"
          onChange={(event) => updateQuery(event.currentTarget.value)}
        />
        {query && (
          <IconButton label="Clear file search" onClick={() => updateQuery("")}>
            <X size={14} />
          </IconButton>
        )}
      </div>

      <div className="files-layout">
        <div className="file-entry-list" role="list" aria-label="Workspace entries">
          {loading && entries.length === 0 ? (
            <div className="panel-loading"><LoadingMark label="Loading files" /><span>Indexing files…</span></div>
          ) : visibleEntries.length === 0 ? (
            <div className="panel-empty compact">
              <FileSearch size={20} aria-hidden="true" />
              <p>{query ? "No files match this search." : "No files found in this workspace."}</p>
            </div>
          ) : visibleEntries.map((entry) => {
            const parts = pathParts(entry.path);
            if (entry.kind === "directory") {
              return (
                <div className="file-entry is-directory" role="listitem" key={entry.path} title={entry.path}>
                  <Folder size={15} aria-hidden="true" />
                  <span className="file-entry-copy">
                    <span className="file-entry-name">{parts.name}</span>
                    {parts.parent && <span className="file-entry-path">{parts.parent}</span>}
                  </span>
                </div>
              );
            }
            return (
              <button
                type="button"
                role="listitem"
                className={clsx("file-entry", "is-file", selectedPath === entry.path && "is-selected")}
                aria-pressed={selectedPath === entry.path}
                onClick={() => onSelectFile(entry.path)}
                key={entry.path}
                title={entry.path}
              >
                <File size={15} aria-hidden="true" />
                <span className="file-entry-copy">
                  <span className="file-entry-name">{parts.name}</span>
                  {parts.parent && <span className="file-entry-path">{parts.parent}</span>}
                </span>
              </button>
            );
          })}
          {entriesTruncated && <p className="panel-notice file-list-truncated">Refine your search to see entries beyond this result limit.</p>}
        </div>

        <div className="file-preview" aria-live="polite">
          {loading && selectedPath && !preview ? (
            <div className="panel-loading"><LoadingMark label="Loading file" /><span>Loading file…</span></div>
          ) : preview ? (
            <>
              <header className="file-preview-header">
                <div>
                  <strong>{pathParts(preview.path).name}</strong>
                  <span>{preview.path}</span>
                </div>
                <span className="file-language">{preview.language || "text"}</span>
                {onOpenFile && <IconButton label="Open file in default editor" onClick={() => onOpenFile(preview.path)}><ExternalLink size={14} /></IconButton>}
              </header>
              <pre className="file-preview-code" tabIndex={0} aria-label={`Contents of ${preview.path}`}>
                <code>
                  {preview.content.split("\n").map((line, index) => (
                    <span className="file-preview-line" key={index}>
                      <span className="file-preview-line-number" aria-hidden="true">{index + 1}</span>
                      <span>{line || " "}</span>
                    </span>
                  ))}
                </code>
              </pre>
              {preview.truncated && <p className="panel-notice file-preview-truncated">This preview shows only the beginning of the file.</p>}
            </>
          ) : (
            <div className="panel-empty">
              <FileSearch size={22} aria-hidden="true" />
              <h3>Select a file</h3>
              <p>Choose a file to preview its contents without leaving the workspace.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
