import { useId, useLayoutEffect, useRef, useState } from "react";
import "./ReviewNoteDialog.css";
import { createPortal } from "react-dom";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { captureModalFocus } from "../utils/modalFocus";
import { DialogShell } from "./DialogShell";

export interface ReviewNoteDraft {
  title: string;
  body: string;
  save(body: string): Promise<void>;
}

export function ReviewNoteDialog({ draft, onClose }: {
  draft: ReviewNoteDraft;
  onClose(): void;
}): React.JSX.Element {
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const saving = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  useNativePreviewSuspension(true);
  useLayoutEffect(() => {
    const restore = captureModalFocus();
    textarea.current?.focus();
    return restore;
  }, []);
  useLayoutEffect(() => {
    if (error && !busy) textarea.current?.focus();
  }, [busy, error]);
  const save = async (): Promise<void> => {
    if (saving.current || !body.trim()) return;
    saving.current = true;
    setBusy(true);
    setError(false);
    try {
      await draft.save(body.trim());
      onClose();
    } catch {
      setError(true);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return createPortal(
    <DialogShell
      className="review-note-dialog"
      titleId={titleId}
      title={draft.title}
      closeLabel="Close review note"
      closeDisabled={busy}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void save(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation();
          if (!saving.current) onClose();
        }
      }}
      footer={<>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-button dialog-primary" disabled={busy || !body.trim()}>{busy ? "Saving…" : "Save note"}</button>
      </>}
    >
      <label className="dialog-field">Review note
        <textarea ref={textarea} value={body} maxLength={8_000} rows={6}
          disabled={busy} onChange={(event) => setBody(event.target.value)} />
      </label>
      {error && <p className="dialog-error" role="alert">The note could not be saved. Your text is still here; try again.</p>}
    </DialogShell>, document.body,
  );
}

export default ReviewNoteDialog;
