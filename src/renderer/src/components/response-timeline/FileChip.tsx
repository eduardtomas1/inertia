import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  FileAudio,
  FileCode2,
  FileCog,
  FileImage,
  FileSpreadsheet,
  FileText,
  Film,
  type LucideIcon,
} from "lucide-react";
import { editorLabel, isEditorId } from "@shared/editor-ids";
import {
  middleTruncate,
  type FileChipKind,
  type FileChipReference,
} from "../../utils/fileChipReference";
import type { WorkspaceFileLocation } from "../../utils/workspaceFileReference";
import { useCopiedState } from "../../hooks/useCopiedState";
import { useEditorPreference } from "../../hooks/useAvailableEditors";
import { projectPathContextMenu, showEditorPickMenu } from "../../utils/contextMenu";
import "./FileChip.css";

export const FILE_CHIP_NOT_IN_WORKSPACE = "Not in this workspace";
export const FILE_CHIP_NOTICE_DURATION_MS = 4_000;

const FILE_CHIP_ICONS: Record<FileChipKind, LucideIcon> = {
  code: FileCode2,
  text: FileText,
  image: FileImage,
  video: Film,
  audio: FileAudio,
  pdf: FileText,
  spreadsheet: FileSpreadsheet,
  config: FileCog,
};

export type FileChipOpenResult = void | boolean;

export interface FileChipProps {
  reference: FileChipReference;
  relativePath: string;
  projectRoot: string;
  projectId: string;
  conversationId?: string;
  announceCopyFeedback?: boolean;
  onOpenProjectFile?: (path: string, location?: WorkspaceFileLocation) => FileChipOpenResult;
  onPreviewMedia?: () => void;
}

function wantsCopy(event: MouseEvent<HTMLButtonElement>): boolean {
  return event.button === 1
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || event.altKey;
}

export function FileChip({
  reference,
  relativePath,
  projectRoot,
  projectId,
  conversationId,
  announceCopyFeedback = true,
  onOpenProjectFile,
  onPreviewMedia,
}: FileChipProps): React.JSX.Element {
  const clipboard = useCopiedState();
  const { preferredEditor, detectedEditors } = useEditorPreference();
  const [copyStarted, setCopyStarted] = useState(false);
  const [missing, setMissing] = useState(false);
  const noticeTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);
  const Icon = FILE_CHIP_ICONS[reference.kind];
  const showMissing = (): void => {
    setMissing(true);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setMissing(false);
    }, FILE_CHIP_NOTICE_DURATION_MS);
  };
  const openInFiles = (): void => {
    if (!onOpenProjectFile) {
      onPreviewMedia?.();
      return;
    }
    setMissing(false);
    let opened: FileChipOpenResult;
    try {
      opened = reference.location
        ? onOpenProjectFile(relativePath, reference.location)
        : onOpenProjectFile(relativePath);
    } catch {
      opened = false;
    }
    if (opened === false) showMissing();
  };
  const open = (event?: MouseEvent<HTMLButtonElement>): void => {
    if (onPreviewMedia) {
      setMissing(false);
      onPreviewMedia();
      return;
    }
    if (isEditorId(preferredEditor)) {
      setMissing(false);
      void window.inertia.openProjectPath({
        projectId,
        ...(conversationId ? { conversationId } : {}),
        relativePath,
        action: "open-in-editor",
        editor: preferredEditor,
        ...(reference.location ? {
          line: reference.location.startLine,
          ...(reference.location.startColumn !== undefined ? { column: reference.location.startColumn } : {}),
        } : {}),
      }).catch(() => showMissing());
      return;
    }
    if (preferredEditor === "ask" && detectedEditors.length > 0 && event) {
      showEditorPickMenu(
        { projectId, conversationId, relativePath, location: reference.location, open: openInFiles },
        event.currentTarget,
        event.detail > 0 ? { x: event.clientX, y: event.clientY } : undefined,
      );
      return;
    }
    openInFiles();
  };
  const copy = (): void => {
    setCopyStarted(true);
    void clipboard.copy(reference.token);
  };
  const menu = projectPathContextMenu<HTMLButtonElement>("project-link", {
    projectId,
    conversationId,
    projectRoot,
    relativePath,
    location: reference.location,
    open: onPreviewMedia ?? openInFiles,
  });
  const accessibleOpenTarget = !onPreviewMedia && isEditorId(preferredEditor)
    ? editorLabel(preferredEditor)
    : "Files";
  return (
    <>
      <button
        type="button"
        className="response-file-chip"
        data-file-chip-kind={reference.kind}
        data-file-chip-text={reference.token}
        title={reference.token}
        aria-label={`Open ${reference.token} in ${accessibleOpenTarget}`}
        onClick={(event) => {
          if (wantsCopy(event)) copy();
          else open(event);
        }}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          copy();
        }}
        onContextMenu={menu?.onContextMenu}
        onKeyDown={menu?.onKeyDown}
      >
        <Icon className="response-file-chip-icon" size={14} aria-hidden="true" />
        <span className="response-file-chip-name" aria-hidden="true">{reference.name}</span>
        {reference.locationLabel && (
          <span className="response-file-chip-line" aria-hidden="true">{reference.locationLabel}</span>
        )}
        {reference.folder && (
          <span className="response-file-chip-folder" aria-hidden="true">
            {middleTruncate(reference.folder)}
          </span>
        )}
        <span className="visually-hidden response-file-chip-text">{reference.token}</span>
      </button>
      {missing && (
        <span className="response-copy-error" role="alert">
          {FILE_CHIP_NOT_IN_WORKSPACE}
        </span>
      )}
      {clipboard.error && (
        <span className="response-copy-error" role="alert">
          {clipboard.error}
        </span>
      )}
      {announceCopyFeedback && copyStarted && (
        <span className="visually-hidden" role="status" aria-live="polite">
          {clipboard.copied ? "Path copied to clipboard." : ""}
        </span>
      )}
    </>
  );
}
