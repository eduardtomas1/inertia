import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../utils/modalFocus";

export function DiagnosticsClearDialog({ onClear, onClose }: {
  onClear(): Promise<boolean>;
  onClose(): void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const clearing = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useNativePreviewSuspension(true);
  useLayoutEffect(() => {
    const restore = captureModalFocus();
    cancel.current?.focus();
    return restore;
  }, []);
  const clear = async (): Promise<void> => {
    if (clearing.current) return;
    clearing.current = true;
    setBusy(true);
    setFailed(false);
    const cleared = await onClear();
    clearing.current = false;
    setBusy(false);
    if (cleared) onClose();
    else setFailed(true);
  };
  return createPortal(
    <div className="dialog-backdrop">
      <div className="commit-dialog diagnostics-clear-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId}
        onKeyDown={(event) => {
          trapModalFocus(event, event.currentTarget);
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!clearing.current) onClose();
          }
        }}>
        <header><div><h2 id={titleId}>Clear diagnostics history?</h2>
          <p id={descriptionId}>Recorded events and incidents on this device are deleted. This cannot be undone.</p></div></header>
        {failed && <p className="diagnostics-clear-error" role="alert">The history could not be cleared. Try again.</p>}
        <footer>
          <button ref={cancel} type="button" className="secondary-button" onClick={() => { if (!clearing.current) onClose(); }}>Cancel</button>
          <button type="button" className="secondary-button is-danger" aria-disabled={busy} onClick={() => void clear()}>
            {busy ? "Clearing…" : "Clear history"}
          </button>
        </footer>
      </div>
    </div>, document.body,
  );
}
