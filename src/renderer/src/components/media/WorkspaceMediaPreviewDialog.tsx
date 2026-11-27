import { Check, CircleAlert, Copy, ExternalLink, FolderOpen, RotateCw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  classifyWorkspaceMediaPath,
  type WorkspaceMediaPreviewTarget,
} from "@shared/workspace-media-preview";
import { useCopiedState } from "../../hooks/useCopiedState";
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
  readonly onOpenExternally?: (target: WorkspaceMediaPreviewTarget) => void | Promise<void>;
}

function pauseDocumentMediaOutside(container: HTMLElement | null): void {
  for (const element of document.querySelectorAll<HTMLMediaElement>("video, audio")) {
    if (container && container.contains(element)) continue;
    try {
      if (!element.paused && typeof element.pause === "function") element.pause();
    } catch {
      // Ignore media pause failures in non-media DOM environments (e.g. jsdom).
    }
  }
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
  const stageRef = useRef<HTMLDivElement>(null);
  const [metadata, setMetadata] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  const pathClipboard = useCopiedState();
  const documentVisible = useDocumentVisibility();
  const descriptor = useMemo(
    () => classifyWorkspaceMediaPath(target.relativePath),
    [target.relativePath],
  );
  const badgeLabel = descriptor?.label ?? target.kind;

  useEffect(() => {
    setMetadata(null);
    setOpenError(null);
  }, [target.url, reloadNonce]);

  useEffect(() => {
    pauseDocumentMediaOutside(stageRef.current);
  }, [target.url]);

  useEffect(() => {
    const restoreFocus = focusModalOnAnimationFrame(
      () => closeRef.current?.focus(),
    );
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (document.fullscreenElement) return;
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

  const handleOpenExternally = useCallback(async (item: WorkspaceMediaPreviewTarget) => {
    if (!onOpenExternally) return;
    setOpenError(null);
    try {
      await onOpenExternally(item);
    } catch {
      setOpenError(`Could not open ${item.name} externally.`);
    }
  }, [onOpenExternally]);

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
          <span className="workspace-media-dialog-badge" data-media-kind={target.kind}>
            {badgeLabel}
          </span>
          {metadata && <span className="workspace-media-dialog-stat">{metadata}</span>}
          {target.relativePath !== target.name && (
            <span className="workspace-media-dialog-path">{target.relativePath}</span>
          )}
        </span>
      )}
      descriptionId={descriptionId}
      closeLabel={`Close preview of ${target.name}`}
      closeRef={closeRef}
      onClose={onClose}
      onDismiss={onClose}
      footerStart={(
        <div className="workspace-media-dialog-footer-start">
          {onShowInFiles && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onShowInFiles(target.relativePath)}
            >
              <FolderOpen size={14} aria-hidden="true" />
              <span>Show in Files</span>
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void pathClipboard.copy(target.relativePath);
            }}
          >
            {pathClipboard.copied ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Copy size={14} aria-hidden="true" />
            )}
            <span>{pathClipboard.copied ? "Copied path" : "Copy path"}</span>
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setReloadNonce((value) => value + 1)}
          >
            <RotateCw size={14} aria-hidden="true" />
            <span>Reload</span>
          </button>
          {openError && (
            <span className="workspace-media-dialog-error" role="alert" title={openError}>
              <CircleAlert size={14} aria-hidden="true" />
              <span>{openError}</span>
            </span>
          )}
        </div>
      )}
      footer={(
        <div className="workspace-media-dialog-footer-actions">
          {onOpenExternally && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void handleOpenExternally(target);
              }}
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
      <div ref={stageRef} className="attachment-preview-stage">
        <WorkspaceMediaViewer
          key={`${target.url}:${reloadNonce}`}
          target={target}
          onOpenExternally={onOpenExternally ? handleOpenExternally : undefined}
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
