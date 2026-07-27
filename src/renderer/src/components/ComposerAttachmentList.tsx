import { FileText, X } from "lucide-react";

import {
  chatAttachmentKind,
  chatAttachmentTypeLabel,
  type ChatAttachment,
} from "@shared/contracts";
import {
  attachmentPreviewUrl,
  formatAttachmentSize,
} from "../utils/composerAttachments";

type ComposerAttachmentListProps = {
  attachments: readonly ChatAttachment[];
  onRemove: (attachment: ChatAttachment) => void;
};

export function ComposerAttachmentList({
  attachments,
  onRemove,
}: ComposerAttachmentListProps): React.JSX.Element | null {
  if (attachments.length === 0) return null;

  return (
    <ul className="composer-attachments" aria-label="Attachments">
      {attachments.map((attachment) => {
        const kind = chatAttachmentKind(attachment.mimeType);
        const previewUrl = attachmentPreviewUrl(attachment);
        return (
          <li
            className="composer-attachment"
            data-attachment-kind={kind}
            key={attachment.id}
          >
            <span className="composer-attachment-preview" aria-hidden="true">
              {previewUrl
                ? <img src={previewUrl} alt="" />
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
  );
}
