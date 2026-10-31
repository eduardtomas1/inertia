import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import clsx from "clsx";

// Git's wire paths use "/" on every platform (see changedFilePathParts).
function pathParts(path: string): { name: string; parent: string } {
  const parts = path.split("/");
  return { name: parts.at(-1) ?? path, parent: parts.slice(0, -1).join("/") };
}

const TRANSPARENT: CSSProperties = { display: "contents" };
const COLLAPSED: CSSProperties = { display: "none" };

export type ChangesSplitLayoutProps = {
  /** Split view: the file list collapses into a strip above the diff. */
  split: boolean;
  fileCount: number;
  selectedPath: string | null;
  /** The compact file picker shown above the list in unified view. */
  picker: ReactNode;
  /** The full changed-file list: a column in unified view, an overlay in split view. */
  fileList: ReactNode;
  /** The diff pane, which keeps the whole panel width in split view. */
  children: ReactNode;
};

/**
 * Lays out the changed-file list and the diff. Split view collapses the list
 * into a "Files (N)" strip above the diff so both columns get the panel's full
 * width; the list opens as an overlay, and choosing a file or pressing Escape
 * closes it again. Both views keep the list and the diff pane at the same
 * place in the tree and change only class names, so switching views or
 * crossing the split-view width keeps their focus and scroll position.
 */
export function ChangesSplitLayout({
  split,
  fileCount,
  selectedPath,
  picker,
  fileList,
  children,
}: ChangesSplitLayoutProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const overlayId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const selectedPathRef = useRef(selectedPath);
  const overlayOpen = split && open;

  useEffect(() => {
    if (selectedPathRef.current === selectedPath) return;
    selectedPathRef.current = selectedPath;
    if (overlayRef.current?.contains(document.activeElement)) toggleRef.current?.focus({ preventScroll: true });
    setOpen(false);
  }, [selectedPath]);

  useEffect(() => {
    if (!split) setOpen(false);
  }, [split]);

  const parts = selectedPath ? pathParts(selectedPath) : null;
  return (
    <div className={clsx("changes-layout", split && "is-split-view")}>
      {split ? (
        <div className="changes-split-files" key="split-files">
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
      ) : <div className="changes-layout-picker" key="picker" style={TRANSPARENT}>{picker}</div>}
      <div className={split ? "changes-split-body" : undefined} key="body" style={split ? undefined : TRANSPARENT}>
        <div
          className={overlayOpen ? "changes-split-files-overlay" : undefined}
          id={overlayOpen ? overlayId : undefined}
          ref={overlayRef}
          style={split ? overlayOpen ? undefined : COLLAPSED : TRANSPARENT}
          onKeyDown={overlayOpen ? (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            toggleRef.current?.focus({ preventScroll: true });
          } : undefined}
        >
          {fileList}
        </div>
        {children}
      </div>
    </div>
  );
}
