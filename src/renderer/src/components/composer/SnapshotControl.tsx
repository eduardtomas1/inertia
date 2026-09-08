import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, X } from "lucide-react";
import type { SnapshotRequest, SnapshotState } from "@shared/snapshots";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import { IconButton } from "../ui";
import "./SnapshotControl.css";

export function SnapshotControl({ conversationId }: { conversationId: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SnapshotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const request = async (input: SnapshotRequest): Promise<void> => {
    setPending(true); setError(null);
    try { setState(await window.inertia.snapshot(input)); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "Snapshots unavailable.");
      try { setState(await window.inertia.snapshot({ type: "state" })); } catch { /* Keep the last known state and the visible error. */ }
    }
    finally { setPending(false); }
  };
  useEffect(() => {
    const onError = (event: Event): void => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (detail && typeof detail === "object" && "conversationId" in detail && detail.conversationId === conversationId
        && "message" in detail && typeof detail.message === "string") { setError(detail.message); setOpen(true); }
    };
    window.addEventListener("inertia:snapshot-error", onError);
    return () => window.removeEventListener("inertia:snapshot-error", onError);
  }, [conversationId]);
  useEffect(() => {
    if (!open) return;
    const restore = captureModalFocus(false);
    close.current?.focus();
    let active = true;
    const refresh = (): void => { void window.inertia.snapshot({ type: "state" }).then((value) => { if (active) setState(value); }).catch(() => { if (active) setError("Snapshots unavailable."); }); };
    refresh(); window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); restore(); };
  }, [open]);
  if (!window.inertia?.snapshot) return null;
  return <>
    <IconButton label="Snapshots" onClick={() => setOpen(true)}><Camera size={16} /></IconButton>
    {open && createPortal(<div className="snapshot-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="snapshot-dialog" role="dialog" aria-modal="true" aria-labelledby="snapshot-title" onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
        else trapModalFocus(event, event.currentTarget);
      }}>
        <header><h2 id="snapshot-title">Snapshots</h2><button ref={close} aria-label="Close Snapshots" onClick={() => setOpen(false)}><X size={18} /></button></header>
        <p>Experimental capture of the foreground window and its accessibility context. Review the attachment before sending.</p>
        {state && <>
          <label className="snapshot-setting"><span>Enable Snapshots</span><input type="checkbox" checked={state.enabled} disabled={pending || !state.available} onChange={(event) => void request({ type: "configure", enabled: event.target.checked, shortcut: state.shortcut })} /></label>
          <label className="snapshot-setting"><span>Capture shortcut</span><select aria-label="Capture shortcut" value={state.shortcut} disabled={pending || !state.available} onChange={(event) => void request({ type: "configure", enabled: state.enabled, shortcut: event.target.value as SnapshotState["shortcut"] })}>
            {!navigator.platform.toLowerCase().includes("linux") && <option value="both-shift">Both Shift keys</option>}<option value="accelerator">{navigator.platform.includes("Mac") ? "⌘⌥S" : "Ctrl+Alt+S"}</option>
          </select></label>
          <p className="snapshot-note">Detected editable fields are masked. Screenshots and accessibility context may still contain sensitive information, including overlapping windows. Review before sending.</p>
          {state.permission === "required" && <div className="snapshot-permissions"><p>Allow Inertia in macOS Accessibility and Screen Recording.</p><button disabled={pending} onClick={() => void request({ type: "permission", permission: "accessibility" })}>Accessibility settings</button><button disabled={pending} onClick={() => void request({ type: "permission", permission: "screen" })}>Screen Recording settings</button></div>}
          {state.message && <p role="status">{state.message}</p>}
          {state.enabled && <p>Switch to the window you want to share and press {state.shortcut === "both-shift" ? "both Shift keys together" : navigator.platform.includes("Mac") ? "⌘⌥S" : "Ctrl+Alt+S"}. Inertia will bring you back to this chat.</p>}
        </>}
        {error && <p role="alert">{error}</p>}
      </section>
    </div>, document.body)}
  </>;
}
