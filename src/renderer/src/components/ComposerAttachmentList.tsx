import { File, FileSpreadsheet, FileText, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  ChatAttachment,
} from "@shared/contracts";
import {
  chatAttachmentKind,
  chatAttachmentTypeLabel,
} from "@shared/attachments";
import { previewAnnotationChipLabel } from "@shared/preview-annotation";
import {
  attachmentIconKind,
  attachmentPreviewKind,
  attachmentPreviewUrl,
  formatAttachmentSize,
} from "../utils/composerAttachments";
import "./SnapshotAttachment.css";
import { AttachmentPreviewDialog } from "./AttachmentPreviewDialog";

type ComposerAttachmentListProps = {
  attachments: readonly ChatAttachment[];
  disabled?: boolean;
  pendingAttachmentIds?: ReadonlySet<string>;
  onRemove: (attachment: ChatAttachment) => void;
};

export function ComposerAttachmentList({
  attachments,
  disabled = false,
  pendingAttachmentIds = new Set(),
  onRemove,
}: ComposerAttachmentListProps): React.JSX.Element | null {
  const [previewAttachment, setPreviewAttachment] =
    useState<ChatAttachment | null>(null);

  useEffect(() => {
    if (
      previewAttachment
      && !attachments.some(({ id }) => id === previewAttachment.id)
    ) {
      setPreviewAttachment(null);
    }
  }, [attachments, previewAttachment]);
  const closePreview = useCallback(() => setPreviewAttachment(null), []);

  if (attachments.length === 0) return null;

  return (
    <>
      <ul className="composer-attachments" aria-label="Attachments">
        {attachments.map((attachment) => {
          const kind = chatAttachmentKind(attachment.mimeType);
          const previewKind = attachmentPreviewKind(attachment);
          const previewUrl = attachmentPreviewUrl(attachment);
          const pending = pendingAttachmentIds.has(attachment.id);
          const annotation = attachment.previewAnnotation;
          const annotationLabel = annotation ? previewAnnotationChipLabel(annotation) : null;
          const displayTitle = attachment.snapshot?.appName ?? annotationLabel?.title ?? attachment.name;
          const displayTitleTooltip = attachment.snapshot?.windowTitle
            ?? (annotation ? `${annotation.selector} · ${annotation.pageUrl}` : attachment.name);
          const displaySubtitle = attachment.snapshot
            ? attachment.snapshot.windowTitle
            : annotationLabel
              ? annotationLabel.subtitle
              : `${chatAttachmentTypeLabel(attachment.mimeType)} · ${formatAttachmentSize(attachment.size)}`;
          const openAriaLabel = annotationLabel
            ? `Preview page annotation ${annotationLabel.title}`
            : `Preview attachment ${attachment.name}`;
          const removeAriaLabel = annotationLabel
            ? `Remove page annotation ${annotationLabel.title}`
            : `Remove attachment ${attachment.name}`;
          const content = (
            <>
              <span className="composer-attachment-preview" aria-hidden="true">
                {previewKind === "image" && !pending
                  ? (
                      <img
                        src={previewUrl}
                        alt=""
                      />
                    )
                  : attachmentIconKind(attachment) === "spreadsheet"
                    ? <FileSpreadsheet size={16} />
                    : previewKind === "file"
                      ? <File size={16} />
                      : <FileText size={16} />}
              </span>
              <span className="composer-attachment-copy">
                <strong title={displayTitleTooltip}>{displayTitle}</strong>
                <small>{displaySubtitle}</small>
              </span>
            </>
          );
          return (
            <li
              className="composer-attachment"
              data-attachment-kind={kind}
              data-snapshot={Boolean(attachment.snapshot) || undefined}
              data-preview-annotation={Boolean(annotation) || undefined}
              data-attachment-pending={pending || undefined}
              key={attachment.id}
            >
              <button
                type="button"
                className="composer-attachment-open"
                data-preview-source={pending ? undefined : previewUrl}
                aria-label={openAriaLabel}
                disabled={disabled || pending}
                onClick={() => setPreviewAttachment(attachment)}
              >
                {content}
              </button>
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label={removeAriaLabel}
                disabled={disabled || pending}
                onClick={() => onRemove(attachment)}
              >
                <X size={14} aria-hidden="true" />
                <span>Remove</span>
              </button>
            </li>
          );
        })}
      </ul>
      {previewAttachment && (
        <AttachmentPreviewDialog
          attachment={previewAttachment}
          onClose={closePreview}
        />
      )}
    </>
  );
}
