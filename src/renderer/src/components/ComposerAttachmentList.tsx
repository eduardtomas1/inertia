import { FileText, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  chatAttachmentKind,
  chatAttachmentTypeLabel,
  type ChatAttachment,
} from "@shared/contracts";
import {
  attachmentPreviewKind,
  attachmentPreviewUrl,
  formatAttachmentSize,
} from "../utils/composerAttachments";
import { AttachmentPreviewDialog } from "./AttachmentPreviewDialog";

type ComposerAttachmentListProps = {
  attachments: readonly ChatAttachment[];
  onRemove: (attachment: ChatAttachment) => void;
};

export function ComposerAttachmentList({
  attachments,
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
          const content = (
            <>
              <span className="composer-attachment-preview" aria-hidden="true">
                {previewKind === "image"
                  ? (
                      <img
                        src={previewUrl ?? undefined}
                        alt=""
                      />
                    )
                  : <FileText size={19} />}
              </span>
              <span className="composer-attachment-copy">
                <strong>{attachment.name}</strong>
                <small>
                  {chatAttachmentTypeLabel(attachment.mimeType)}
                  {" · "}
                  {formatAttachmentSize(attachment.size)}
                </small>
              </span>
            </>
          );
          return (
            <li
              className="composer-attachment"
              data-attachment-kind={kind}
              key={attachment.id}
            >
              {previewKind
                ? (
                    <button
                      type="button"
                      className="composer-attachment-open"
                      data-preview-source={previewUrl ?? undefined}
                      aria-label={`Preview attachment ${attachment.name}`}
                      onClick={() => setPreviewAttachment(attachment)}
                    >
                      {content}
                    </button>
                  )
                : (
                    <span className="composer-attachment-open is-unavailable">
                      {content}
                    </span>
                  )}
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label={`Remove attachment ${attachment.name}`}
                onClick={() => onRemove(attachment)}
              >
                <X size={12} aria-hidden="true" />
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
