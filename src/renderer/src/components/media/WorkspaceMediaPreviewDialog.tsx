import { ExternalLink, FolderOpen } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  classifyWorkspaceMediaPath,
  type WorkspaceMediaPreviewTarget,
} from "@shared/workspace-media-preview";
import { useDocumentVisibility } from "../../hooks/useDocumentPresence";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { focusModalOnAnimationFrame } from "../../utils/modalFocus";
import { DialogShell } from "../DialogShell";
import { WorkspaceMediaViewer } from "./WorkspaceMediaViewer";
import "./WorkspaceMediaPreview.css";

export interface WorkspaceMediaPreviewDialogProps {
  readonly target: WorkspaceMediaPreviewTarget | null;
  readonly onClose: () => void;
  readonly onShowInFiles?: (relativePath: string) => void;
  readonly onOpenExternally?: (target: WorkspaceMediaPreviewTarget) => void;
}

function WorkspaceMediaPreviewDialogContent({
  target,
  onClose,
  onShowInFiles,
  onOpenExternally,
}: Omit<WorkspaceMediaPreviewDialogProps, "target"> & {
  readonly target: WorkspaceMediaPreviewTarget;
}): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [metadata, setMetadata] = useState<string | null>(null);
  const documentVisible = useDocumentVisibility();
  const descriptor = useMemo(
    () => classifyWorkspaceMediaPath(target.relativePath),
    [target.relativePath],
  );
  const badgeLabel = descriptor?.label ?? target.kind;

  useEffect(() => {
    setMetadata(null);
  }, [target.url]);

  useEffect(() => {
    const restoreFocus = focusModalOnAnimationFrame(
      () => closeRef.current?.focus(),
    );
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("keydown", closeOnEscape, true);
      restoreFocus();
    };
  }, [onClose]);

  return createPortal(
    <DialogShell
      className="attachment-preview-dialog workspace-media-preview-dialog"
      backdropClassName="attachment-preview-backdrop"
      backdropData={{ "data-document-visible": documentVisible }}
      bodyClassName="attachment-preview-body is-flush"
      data-preview-kind={target.kind}
      titleId={titleId}
      title={target.name}
      description={(
        <span className="workspace-media-dialog-meta" title={target.relativePath}>
          <span className="workspace-media-dialog-badge">{badgeLabel}</span>
          {metadata && <span>{metadata}</span>}
          {target.relativePath !== target.name && <span>{target.relativePath}</span>}
        </span>
      )}
      descriptionId={descriptionId}
      closeLabel={`Close preview of ${target.name}`}
      closeRef={closeRef}
      onClose={onClose}
      onDismiss={onClose}
      footerStart={onShowInFiles && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => onShowInFiles(target.relativePath)}
        >
          <FolderOpen size={14} aria-hidden="true" />
          <span>Show in Files</span>
        </button>
      )}
      footer={(
        <div className="workspace-media-dialog-footer-actions">
          {onOpenExternally && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onOpenExternally(target)}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <span>Open externally</span>
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      )}
    >
      <div className="attachment-preview-stage">
        <WorkspaceMediaViewer
          target={target}
          onOpenExternally={onOpenExternally}
          onMetadata={setMetadata}
        />
      </div>
    </DialogShell>,
    document.body,
  );
}

export function WorkspaceMediaPreviewDialog({
  target,
  onClose,
  onShowInFiles,
  onOpenExternally,
}: WorkspaceMediaPreviewDialogProps): React.JSX.Element | null {
  useNativePreviewSuspension(Boolean(target));
  if (!target) return null;
  return (
    <WorkspaceMediaPreviewDialogContent
      key={target.url}
      target={target}
      onClose={onClose}
      onShowInFiles={onShowInFiles}
      onOpenExternally={onOpenExternally}
    />
  );
}

export default WorkspaceMediaPreviewDialog;
