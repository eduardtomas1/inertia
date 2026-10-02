import {
  File,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";

import {
  chatAttachmentKind,
  chatAttachmentTypeLabel,
} from "@shared/attachments";
import {
  attachmentPreviewKind,
  attachmentPreviewUrl,
  formatAttachmentSize,
  type AttachmentPreviewSource,
} from "../utils/composerAttachments";
import { observeAttachmentThumbnail, type AttachmentThumbnailState } from "../utils/attachmentThumbnailQueue";
import { AttachmentPreviewDialog } from "./AttachmentPreviewDialog";

function SentAttachment({
  attachment,
  metadataId,
  onPreview,
}: {
  attachment: AttachmentPreviewSource;
  metadataId: string;
  onPreview: (attachment: AttachmentPreviewSource) => void;
}): React.JSX.Element {
  const { id } = attachment;
  const [state, setState] = useState<AttachmentThumbnailState>("loading");
  const observe = useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    return observeAttachmentThumbnail(node, attachmentPreviewUrl({ id }), setState);
  }, [id]);
  const kind = chatAttachmentKind(attachment.mimeType);
  const previewKind = attachmentPreviewKind(attachment);
  const unavailable = state === "unavailable";
  const Icon = kind === "image"
    ? unavailable ? TriangleAlert : ImageIcon
    : previewKind === "spreadsheet" ? FileSpreadsheet : previewKind === "file" ? File : FileText;
  return (
    <li
      className="sent-attachment"
      data-request-context-kind={kind}
      data-attachment-preview={previewKind}
      data-attachment-unavailable={unavailable || undefined}
    >
      <button
        type="button"
        className="sent-attachment-open"
        aria-label={`Preview attachment ${attachment.name}`}
        aria-describedby={metadataId}
        onClick={() => onPreview(attachment)}
      >
        <span
          ref={kind === "image" ? observe : undefined}
          className={`sent-attachment-thumbnail${kind === "image" ? "" : " is-document"}`}
          data-thumbnail-state={kind === "image" ? state : undefined}
          aria-hidden="true"
        >
          {state !== "ready" && <Icon size={18} />}
        </span>
        <span className="sent-attachment-copy">
          <strong title={attachment.snapshot?.windowTitle ?? attachment.name}>{attachment.snapshot?.appName ?? attachment.name}</strong>
          <small id={metadataId}>
            {attachment.snapshot?.windowTitle ?? `${chatAttachmentTypeLabel(attachment.mimeType)} · ${formatAttachmentSize(attachment.size)}`}
            {unavailable && " · no longer stored"}
          </small>
        </span>
      </button>
    </li>
  );
}

export function SentMessageAttachmentList({
  attachments,
  label = "Message attachments",
}: {
  attachments: readonly AttachmentPreviewSource[];
  label?: string;
}): React.JSX.Element | null {
  const [previewAttachment, setPreviewAttachment] =
    useState<AttachmentPreviewSource | null>(null);
  const metadataIdPrefix = useId();
  const closePreview = useCallback(() => setPreviewAttachment(null), []);

  useEffect(() => {
    if (
      previewAttachment
      && !attachments.some(({ id }) => id === previewAttachment.id)
    ) setPreviewAttachment(null);
  }, [attachments, previewAttachment]);

  if (attachments.length === 0) return null;

  return (
    <>
      <ul
        className="message-attachments turn-user-request-context sent-attachments"
        aria-label={label}
      >
        {attachments.map((attachment) => (
          <SentAttachment
            key={attachment.id}
            attachment={attachment}
            metadataId={`${metadataIdPrefix}-${attachment.id}`}
            onPreview={setPreviewAttachment}
          />
        ))}
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
