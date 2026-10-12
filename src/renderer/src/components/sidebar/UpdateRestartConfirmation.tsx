import { useId, useLayoutEffect, useRef } from "react";
import { DialogHeader } from "../DialogShell";

export function UpdateRestartConfirmation({ version, ready, onClose, onConfirm, restoreFocus }: {
  version: string; ready: boolean; onClose: () => void; onConfirm: () => void;
  restoreFocus: () => void;
}): React.JSX.Element {
  const root = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  const description = useId();
  useLayoutEffect(() => {
    const dialog = root.current;
    dialog?.showModal?.();
    cancel.current?.focus();
    return () => { dialog?.close?.(); restoreFocus(); };
  }, [restoreFocus]);
  return <dialog ref={root} className="dialog-shell update-restart-dialog" aria-labelledby={title} aria-describedby={description}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <DialogHeader titleId={title} title={`Restart to install Inertia ${version}?`} closeLabel="Close restart confirmation" onClose={onClose} />
    <div className="dialog-shell-body">
      <p id={description}>Save your work before continuing. Inertia will check for active agents, terminals and other operations before restarting safely.</p>
      {!ready && <p role="status">The update changed. Close this confirmation and review its current status.</p>}
    </div>
    <footer className="dialog-shell-footer">
      <button ref={cancel} type="button" className="secondary-button" onClick={onClose}>Not now</button>
      <button type="button" className="primary-button" disabled={!ready} onClick={onConfirm}>Restart to update</button>
    </footer>
  </dialog>;
}
