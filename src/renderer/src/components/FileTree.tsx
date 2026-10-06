import { memo, useId, type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";
import { ChevronRight, File, Folder } from "lucide-react";
import { sourceLanguageForFile } from "@shared/source-language";
import {
  workspaceParentPath,
  workspacePathName,
  type WorkspaceTreeRow,
} from "../utils/workspaceTree";
import type { FileTreeGitIndex } from "../utils/fileTreeGit";
import type { DirectoryPage } from "../utils/workspaceDirectoryPages";
import { FileGitBadge } from "./FileGitBadge";
import type { ContextMenuHandlers } from "../utils/contextMenu";

export type FileTreeProps = {
  label: string;
  busy: boolean;
  rows: WorkspaceTreeRow[];
  searchActive: boolean;
  selectedPath: string | null;
  rovingPath: string | null;
  gitIndex: FileTreeGitIndex;
  directoryPages: ReadonlyMap<string, DirectoryPage>;
  loadingDirectories: ReadonlySet<string>;
  directoryErrors: ReadonlyMap<string, string>;
  itemRefs: RefObject<Map<string, HTMLButtonElement>>;
  treeRef: RefObject<HTMLDivElement | null>;
  onActivate: (row: WorkspaceTreeRow) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, row: WorkspaceTreeRow) => void;
  contextMenuFor?: (row: WorkspaceTreeRow) => ContextMenuHandlers<HTMLButtonElement> | undefined;
};

export const FileTree = memo(function FileTree({
  label,
  busy,
  rows,
  searchActive,
  selectedPath,
  rovingPath,
  gitIndex,
  directoryPages,
  loadingDirectories,
  directoryErrors,
  itemRefs,
  treeRef,
  onActivate,
  onKeyDown,
  contextMenuFor,
}: FileTreeProps): React.JSX.Element {
  const baseId = useId();
  const statuses: { id: string; path: string; text: string; error: boolean }[] = [];
  const items = rows.map((row, index) => {
    const { entry } = row;
    const name = workspacePathName(entry.path);
    const entryLanguage = entry.kind === "file"
      ? sourceLanguageForFile(entry.path)
      : null;
    const parent = searchActive ? workspaceParentPath(entry.path) : "";
    const gitDescription = entry.kind === "directory"
      ? gitIndex.directories.has(entry.path) ? "Contains Git changes" : undefined
      : gitIndex.files.has(entry.path) ? `Git: ${gitIndex.files.get(entry.path)!.label}` : undefined;
    const directoryPage = entry.kind === "directory"
      ? directoryPages.get(entry.path)
      : undefined;
    const directoryLoading = loadingDirectories.has(entry.path);
    const directoryError = directoryErrors.get(entry.path);
    const showDirectoryStatus = !searchActive
      && entry.kind === "directory"
      && row.expanded
      && (
        directoryLoading
        || Boolean(directoryError)
        || (directoryPage !== undefined && directoryPage.entries.length === 0)
        || directoryPage?.truncated
      );
    const menu = contextMenuFor?.(row);
    const statusId = `${baseId}-status-${index}`;
    const gitDescriptionId = `${baseId}-git-${index}`;
    const statusText = directoryLoading
      ? `Loading ${name}…`
      : directoryError
        ? `${directoryError} Enter retries.`
        : directoryPage?.truncated
          ? `More in ${name}.`
          : `${name} is empty.`;
    if (showDirectoryStatus) {
      statuses.push({ id: statusId, path: entry.path, text: statusText, error: Boolean(directoryError) });
    }
    return (
      <div className="file-tree-row-group" role="none" key={`${searchActive ? "search" : "tree"}:${entry.path}`}>
        <button
          type="button"
          role="treeitem"
          aria-label={parent ? `${name} ${parent}` : name}
          aria-description={showDirectoryStatus ? undefined : gitDescription}
          aria-describedby={showDirectoryStatus
            ? gitDescription ? `${statusId} ${gitDescriptionId}` : statusId
            : undefined}
          aria-busy={showDirectoryStatus && directoryLoading ? true : undefined}
          className={clsx(
            "file-entry",
            `is-${entry.kind}`,
            selectedPath === entry.path && "is-selected",
          )}
          aria-level={row.depth}
          aria-expanded={entry.kind === "directory" && !searchActive ? row.expanded : undefined}
          aria-selected={entry.kind === "file" && selectedPath === entry.path}
          aria-current={entry.kind === "file" && selectedPath === entry.path ? "true" : undefined}
          onClick={() => onActivate(row)}
          onContextMenu={menu?.onContextMenu}
          onKeyDown={(event) => {
            menu?.onKeyDown(event);
            if (!event.isDefaultPrevented()) onKeyDown(event, row);
          }}
          ref={(node) => {
            if (node) itemRefs.current.set(entry.path, node);
            else itemRefs.current.delete(entry.path);
          }}
          tabIndex={entry.path === rovingPath ? 0 : -1}
          style={{
            "--file-tree-indent": `${Math.min((row.depth - 1) * 13, 91)}px`,
          } as React.CSSProperties}
          title={entry.path}
          data-language-family={entryLanguage?.family}
        >
          {entry.kind === "directory" && !searchActive ? (
            <ChevronRight
              className="file-tree-chevron"
              size={13}
              aria-hidden="true"
            />
          ) : (
            <span className="file-tree-chevron-spacer" aria-hidden="true" />
          )}
          {entry.kind === "directory"
            ? <Folder size={15} aria-hidden="true" />
            : (
                <File
                  className="file-language-icon"
                  size={15}
                  aria-hidden="true"
                />
              )}
          <span className="file-entry-copy">
            <span className="file-entry-name">{name}</span>
            {parent && <span className="file-entry-path">{parent}</span>}
          </span>
          <FileGitBadge index={gitIndex} path={entry.path} directory={entry.kind === "directory"} />
          {showDirectoryStatus && gitDescription && <span id={gitDescriptionId} hidden>{gitDescription}</span>}
        </button>
        {showDirectoryStatus && (
          <div
            className={clsx("file-tree-status", directoryError && "is-error")}
            aria-hidden="true"
            style={{
              "--file-tree-indent": `${Math.min(row.depth * 13, 104)}px`,
            } as React.CSSProperties}
          >
            {statusText}
          </div>
        )}
      </div>
    );
  });
  return (
    <>
      <div role="tree" aria-label={label} aria-busy={busy} ref={treeRef}>
        {items}
      </div>
      <div className="visually-hidden">
        {statuses.map((status) => (
          <p id={status.id} role={status.error ? "alert" : "status"} key={status.path}>
            {status.text}
          </p>
        ))}
      </div>
    </>
  );
});
