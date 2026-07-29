import { ExternalLink, FileText, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  chatAttachmentTypeLabel,
  type ChatAttachment,
} from "@shared/contracts";
import {
  attachmentPreviewKind,
  attachmentPreviewUrl,
  formatAttachmentSize,
} from "../utils/composerAttachments";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";

type AttachmentPreviewDialogProps = {
  attachment: ChatAttachment;
  onClose: () => void;
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "iframe",
  "[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function AttachmentPreviewDialog({
  attachment,
  onClose,
}: AttachmentPreviewDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const previewKind = attachmentPreviewKind(attachment);
  const previewUrl = attachmentPreviewUrl(attachment);
  useNativePreviewSuspension(Boolean(previewKind && previewUrl));

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [onClose]);

  if (!previewKind || !previewUrl) return null;

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") return;
    const focusable = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="attachment-preview-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="attachment-preview-dialog"
        data-preview-kind={previewKind}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={trapFocus}
      >
        <header className="attachment-preview-header">
          <span className="attachment-preview-identity">
            {previewKind === "pdf" && <FileText size={16} aria-hidden="true" />}
            <span>
              <strong id={titleId}>{attachment.name}</strong>
              <small id={descriptionId}>
                {chatAttachmentTypeLabel(attachment.mimeType)}
                {" · "}
                {formatAttachmentSize(attachment.size)}
              </small>
            </span>
          </span>
          <button
            ref={closeRef}
            type="button"
            className="attachment-preview-close"
            aria-label={`Close preview of ${attachment.name}`}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="attachment-preview-stage" data-load-failed={loadFailed}>
          {loadFailed
            ? (
                <div className="attachment-preview-unavailable" role="alert">
                  <FileText size={28} aria-hidden="true" />
                  <strong>Preview unavailable</strong>
                  <span>
                    The secure preview could not be displayed. Re-add the file
                    if it changed after upload.
                  </span>
                </div>
              )
            : previewKind === "image"
              ? (
                  <img
                    src={previewUrl}
                    alt={attachment.name}
                    onError={() => setLoadFailed(true)}
                  />
                )
              : (
                  <iframe
                    src={previewUrl}
                    title={`PDF preview: ${attachment.name}`}
                    onError={() => setLoadFailed(true)}
                  />
                )}
        </div>
        {previewKind === "pdf" && (
          <footer className="attachment-preview-footer">
            <span>
              If the embedded viewer is unavailable, open this validated copy
              in your default PDF app.
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={opening}
              onClick={() => {
                if (opening) return;
                setOpenFailed(false);
                setOpening(true);
                void window.inertia.openAttachmentExternally(attachment.id)
                  .catch(() => setOpenFailed(true))
                  .finally(() => setOpening(false));
              }}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <span>{opening ? "Opening…" : "Open in PDF app"}</span>
            </button>
            {openFailed && (
              <span className="attachment-preview-open-error" role="alert">
                The validated copy could not be opened.
              </span>
            )}
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}
