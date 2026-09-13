import { useId, useLayoutEffect, useRef, useState } from "react";
import "./ReviewNoteDialog.css";
import { createPortal } from "react-dom";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../utils/modalFocus";

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
    <div className="dialog-backdrop">
      <form className="commit-dialog review-note-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onSubmit={(event) => { event.preventDefault(); void save(); }}
        onKeyDown={(event) => {
          trapModalFocus(event, event.currentTarget);
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation();
            if (!saving.current) onClose();
          }
        }}>
        <h2 id={titleId}>{draft.title}</h2>
        <label>Review note
          <textarea ref={textarea} value={body} maxLength={8_000} rows={6}
            disabled={busy} onChange={(event) => setBody(event.target.value)} />
        </label>
        {error && <p role="alert">The note could not be saved. Your text is still here; try again.</p>}
        <footer>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button dialog-primary" disabled={busy || !body.trim()}>{busy ? "Saving…" : "Save note"}</button>
        </footer>
      </form>
    </div>, document.body,
  );
}

export default ReviewNoteDialog;
