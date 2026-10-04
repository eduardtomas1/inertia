import { ReviewedScreenshotControl } from "./ReviewedScreenshotControl";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import "./SnapshotControl.css";

/** Capture failures stay with their destination chat; configuration lives in Settings. */
export function SnapshotControl({ conversationId, disabled }: { conversationId: string; disabled?: boolean }): React.JSX.Element | null {
  const [error, setError] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  useNativePreviewSuspension(error !== null);
  useEffect(() => {
    setError(null);
    const onError = (event: Event): void => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (detail && typeof detail === "object" && "conversationId" in detail && detail.conversationId === conversationId
        && "message" in detail && typeof detail.message === "string") setError(detail.message);
    };
    window.addEventListener("inertia:snapshot-error", onError);
    return () => window.removeEventListener("inertia:snapshot-error", onError);
  }, [conversationId]);
  const open = error !== null;
  useEffect(() => {
    if (!open) return;
    const restore = captureModalFocus(false);
    close.current?.focus();
    return restore;
  }, [open]);
  return <><ReviewedScreenshotControl conversationId={conversationId} disabled={disabled} />{open && createPortal(<div className="snapshot-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setError(null); }}>
    <section className="snapshot-dialog" role="dialog" aria-modal="true" aria-labelledby="snapshot-title" onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); setError(null); }
      else trapModalFocus(event, event.currentTarget);
    }}>
      <header><h2 id="snapshot-title">Snapshots</h2><button ref={close} aria-label="Close Snapshots" onClick={() => setError(null)}><X size={18} /></button></header>
      <p role="alert" className="snapshot-alert">{error.split(/`([^`]+)`/u).map((part, index) => index % 2 ? <code key={index}>{part}</code> : part)}</p>
      <p className="snapshot-note">Capture options and access guidance are in Settings → Devices & integrations in the main window.</p>
    </section>
  </div>, document.body)}</>;
}
