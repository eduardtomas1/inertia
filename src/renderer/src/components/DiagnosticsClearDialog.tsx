import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { captureModalFocus } from "../utils/modalFocus";
import { DialogShell } from "./DialogShell";

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
    <DialogShell className="diagnostics-clear-dialog" titleId={titleId} title="Clear diagnostics history?"
      description="Recorded events and incidents on this device are deleted. This cannot be undone." descriptionId={descriptionId}
      closeLabel="Close clear history" onClose={() => { if (!clearing.current) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!clearing.current) onClose();
        }
      }}
      footer={<>
        <button ref={cancel} type="button" className="secondary-button" onClick={() => { if (!clearing.current) onClose(); }}>Cancel</button>
        <button type="button" className="secondary-button is-danger" aria-disabled={busy} onClick={() => void clear()}>
          {busy ? "Clearing…" : "Clear history"}
        </button>
      </>}>
      {failed && <p className="dialog-error" role="alert">The history could not be cleared. Try again.</p>}
    </DialogShell>, document.body,
  );
}
