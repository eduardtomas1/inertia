import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

// Git's wire paths use "/" on every platform (see changedFilePathParts).
function pathParts(path: string): { name: string; parent: string } {
  const parts = path.split("/");
  return { name: parts.at(-1) ?? path, parent: parts.slice(0, -1).join("/") };
}

export type ChangesSplitLayoutProps = {
  fileCount: number;
  selectedPath: string | null;
  /** The full changed-file list, shown as an overlay while expanded. */
  fileList: ReactNode;
  /** The diff pane, which keeps the whole panel width in split view. */
  children: ReactNode;
};

/**
 * Split view collapses the changed-file list into a "Files (N)" strip above
 * the diff so both columns get the panel's full width. The list opens as an
 * overlay; choosing a file or pressing Escape closes it again. Nothing here
 * is persisted: switching back to Unified restores the regular list.
 */
export function ChangesSplitLayout({ fileCount, selectedPath, fileList, children }: ChangesSplitLayoutProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const overlayId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const selectedPathRef = useRef(selectedPath);

  useEffect(() => {
    if (selectedPathRef.current === selectedPath) return;
    selectedPathRef.current = selectedPath;
    if (overlayRef.current?.contains(document.activeElement)) toggleRef.current?.focus({ preventScroll: true });
    setOpen(false);
  }, [selectedPath]);

  const parts = selectedPath ? pathParts(selectedPath) : null;
  return (
    <div className="changes-layout is-split-view">
      <div className="changes-split-files">
        <button
          type="button"
          className="changes-split-files-toggle"
          ref={toggleRef}
          aria-expanded={open}
          aria-controls={open ? overlayId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? <PanelLeftClose size={14} aria-hidden="true" /> : <PanelLeftOpen size={14} aria-hidden="true" />}
          Files ({fileCount})
        </button>
        {parts && <span className="changes-split-files-current" title={selectedPath ?? undefined}><strong>{parts.name}</strong>{parts.parent && <small>{parts.parent}</small>}</span>}
      </div>
      <div className="changes-split-body">
        {open && (
          <div
            className="changes-split-files-overlay"
            id={overlayId}
            ref={overlayRef}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              toggleRef.current?.focus({ preventScroll: true });
            }}
          >
            {fileList}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
