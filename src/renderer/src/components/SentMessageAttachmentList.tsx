import {
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  ImageOff,
} from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import type { ChatAttachment } from "@shared/contracts";
import {
  chatAttachmentKind,
  chatAttachmentTypeLabel,
} from "@shared/attachments";
import {
  attachmentPreviewKind,
  attachmentPreviewUrl,
  formatAttachmentSize,
} from "../utils/composerAttachments";
import { AttachmentPreviewDialog } from "./AttachmentPreviewDialog";

function SentImageThumbnail({
  attachment,
}: {
  attachment: ChatAttachment;
}): React.JSX.Element {
  const [state, setState] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const source = attachmentPreviewUrl(attachment);
  return (
    <span
      className="sent-attachment-thumbnail"
      data-thumbnail-state={state}
      aria-hidden="true"
    >
      {state === "loading" && <ImageIcon size={18} />}
      {state === "unavailable" && <ImageOff size={18} />}
      {source && (
        <img
          src={source}
          alt=""
          onLoad={() => setState("ready")}
          onError={() => setState("unavailable")}
        />
      )}
    </span>
  );
}

export function SentMessageAttachmentList({
  attachments,
  label = "Message attachments",
}: {
  attachments: readonly ChatAttachment[];
  label?: string;
}): React.JSX.Element | null {
  const [previewAttachment, setPreviewAttachment] =
    useState<ChatAttachment | null>(null);
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
        {attachments.map((attachment) => {
          const kind = chatAttachmentKind(attachment.mimeType);
          const previewKind = attachmentPreviewKind(attachment);
          const typeLabel = chatAttachmentTypeLabel(attachment.mimeType);
          const metadataId = `${metadataIdPrefix}-${attachment.id}`;
          const copy = (
            <>
              {kind === "image"
                ? <SentImageThumbnail attachment={attachment} />
                : (
                    <span
                      className="sent-attachment-thumbnail is-document"
                      aria-hidden="true"
                    >
                      {previewKind === "spreadsheet"
                        ? <FileSpreadsheet size={18} />
                        : <FileText size={18} />}
                    </span>
                  )}
              <span className="sent-attachment-copy">
                <strong title={attachment.name}>{attachment.name}</strong>
                <small id={metadataId}>
                  {typeLabel}
                  {" · "}
                  {formatAttachmentSize(attachment.size)}
                </small>
              </span>
            </>
          );
          return (
            <li
              className="sent-attachment"
              data-request-context-kind={kind}
              data-attachment-preview={previewKind ?? "unavailable"}
              key={attachment.id}
            >
              {previewKind
                ? (
                    <button
                      type="button"
                      className="sent-attachment-open"
                      aria-label={`Preview attachment ${attachment.name}`}
                      aria-describedby={metadataId}
                      onClick={() => setPreviewAttachment(attachment)}
                    >
                      {copy}
                    </button>
                  )
                : (
                    <div
                      className="sent-attachment-open is-metadata-only"
                      role="group"
                      aria-label={`Attached file ${attachment.name}`}
                      aria-describedby={metadataId}
                    >
                      {copy}
                    </div>
                  )}
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
