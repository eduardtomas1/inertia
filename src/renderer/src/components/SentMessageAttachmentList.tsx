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
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
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

/** Optional per-item actions; message transcripts render previews only. */
export interface SentAttachmentItemActions {
  render(attachment: AttachmentPreviewSource): ReactNode;
  /** Opens an item menu at a pointer position or, from the keyboard, beside the item. */
  onContextMenu(
    attachment: AttachmentPreviewSource,
    anchor: { x: number; y: number },
    previewButton: HTMLButtonElement,
  ): void;
}

function SentAttachment({
  attachment,
  metadataId,
  onPreview,
  actions,
}: {
  attachment: AttachmentPreviewSource;
  metadataId: string;
  onPreview: (attachment: AttachmentPreviewSource) => void;
  actions?: SentAttachmentItemActions | undefined;
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
  const previewButton = (node: Element | null): HTMLButtonElement | null =>
    node?.closest(".sent-attachment")?.querySelector<HTMLButtonElement>(".sent-attachment-open") ?? null;
  const openMenu = actions ? (event: MouseEvent<HTMLLIElement>): void => {
    const button = previewButton(event.target as Element);
    if (!button) return;
    event.preventDefault();
    actions.onContextMenu(attachment, { x: event.clientX, y: event.clientY }, button);
  } : undefined;
  const openMenuFromKeyboard = actions ? (event: KeyboardEvent<HTMLLIElement>): void => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    const button = previewButton(event.target as Element);
    if (!button) return;
    event.preventDefault();
    const rect = (event.target as Element).getBoundingClientRect();
    actions.onContextMenu(attachment, { x: rect.left + 8, y: rect.bottom }, button);
  } : undefined;
  return (
    <li
      className="sent-attachment"
      data-request-context-kind={kind}
      data-attachment-preview={previewKind}
      data-attachment-unavailable={unavailable || undefined}
      data-attachment-actions={actions ? true : undefined}
      onContextMenu={openMenu}
      onKeyDown={openMenuFromKeyboard}
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
          {state !== "ready" && <Icon size={16} />}
        </span>
        <span className="sent-attachment-copy">
          <strong title={attachment.snapshot?.windowTitle ?? attachment.name}>{attachment.snapshot?.appName ?? attachment.name}</strong>
          <small id={metadataId}>
            {attachment.snapshot?.windowTitle ?? `${chatAttachmentTypeLabel(attachment.mimeType)} · ${formatAttachmentSize(attachment.size)}`}
            {unavailable && " · no longer stored"}
          </small>
        </span>
      </button>
      {actions?.render(attachment)}
    </li>
  );
}

export function SentMessageAttachmentList({
  attachments,
  label = "Message attachments",
  actions,
}: {
  attachments: readonly AttachmentPreviewSource[];
  label?: string;
  actions?: SentAttachmentItemActions;
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
            actions={actions}
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
