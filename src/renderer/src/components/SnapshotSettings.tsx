import { useEffect, useRef, useState } from "react";
import type { SnapshotRequest, SnapshotState } from "@shared/snapshots";
import { Switch } from "./ui";
import { SettingRow } from "./settings/SettingsLayout";
import "./SnapshotSettings.css";

export function SnapshotSettings(): React.JSX.Element {
  const [state, setState] = useState<SnapshotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const revision = useRef(0);
  const configuring = useRef(false);
  const linux = navigator.platform.toLowerCase().includes("linux");
  const accelerator = navigator.platform.includes("Mac") ? "⌘⌥S" : "Ctrl+Alt+S";

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      if (configuring.current || !window.inertia?.snapshot) return;
      const requested = ++revision.current;
      void window.inertia.snapshot({ type: "state" }).then((value) => {
        if (active && revision.current === requested) { setState(value); setError(null); }
      }).catch(() => {
        if (active && revision.current === requested) setError("Could not load Snapshots settings. Reopen this page to try again.");
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; revision.current += 1; window.removeEventListener("focus", refresh); };
  }, []);

  const request = async (input: SnapshotRequest): Promise<void> => {
    const requested = ++revision.current;
    configuring.current = true;
    setPending(true); setError(null);
    try {
      const value = await window.inertia.snapshot(input);
      if (revision.current === requested) setState(value);
    } catch (cause) {
      if (revision.current === requested) setError(cause instanceof Error ? cause.message : "Snapshots unavailable.");
      // A failed configuration can disable capture; show the authoritative state.
      const value = await window.inertia.snapshot({ type: "state" }).catch(() => null);
      if (value && revision.current === requested) setState(value);
    } finally {
      configuring.current = false;
      if (revision.current === requested) setPending(false);
    }
  };

  if (!window.inertia?.snapshot) return <p role="status">Snapshots is available in the desktop app.</p>;
  return <div className="snapshot-settings">
    {linux && <section className="settings-card" aria-labelledby="screenshot-reviewed-heading">
      <h3 id="screenshot-reviewed-heading">Reviewed screenshots</h3>
      <p className="settings-card-note">Use Take reviewed screenshot beside the chat attachment button. Choose a window or screen, review it, and crop or mask sensitive areas before attaching.</p>
      <p className="settings-card-note">No accessibility tree or global shortcut is needed. Automatic masking is not verified. The image is attached only after you approve it.</p>
      {state && <p role="status">Capture method: {state.reviewedBackend === "system-picker" ? "Wayland system picker (requires desktop portal and PipeWire support)" : state.reviewedBackend === "window-picker" ? "X11 window and screen picker" : "Unavailable in this session"}.</p>}
    </section>}
    <section className="settings-card" aria-labelledby="snapshot-capture-heading">
      <h3 id="snapshot-capture-heading">Protected foreground capture</h3>
      <p className="settings-card-note">Experimental capture of the foreground window and its accessibility context. Review the attachment before sending.</p>
      <SettingRow id="snapshots-enabled" title="Enable Snapshots" description="Use a global shortcut to attach the window you are working in to your selected chat.">
        <Switch label="Enable Snapshots" checked={state?.enabled ?? false} disabled={pending || !state?.available}
          onChange={(enabled) => { if (state) void request({ type: "configure", enabled, shortcut: state.shortcut }); }} />
      </SettingRow>
      <SettingRow id="snapshot-shortcut" title="Capture shortcut" description="Works while another app is in front.">
        <select className="setting-select" aria-label="Capture shortcut" value={state?.shortcut ?? "accelerator"} disabled={pending || !state?.available}
          onChange={(event) => { if (state) void request({ type: "configure", enabled: state.enabled, shortcut: event.target.value as SnapshotState["shortcut"] }); }}>
          {!linux && <option value="both-shift">Both Shift keys</option>}
          <option value="accelerator">{accelerator}</option>
        </select>
      </SettingRow>
      {!state && !error && <p role="status">Loading Snapshots settings…</p>}
      {state?.message && <p role="status" className="settings-card-note">{state.message}</p>}
      {error && <p role="alert" className="snapshot-settings-error">{error}</p>}
    </section>
    <section className="settings-card" aria-labelledby="snapshot-use-heading">
      <h3 id="snapshot-use-heading">Take a snapshot</h3>
      <ol className="snapshot-instructions">
        <li>Return to your chat and focus its message box to choose the destination.</li>
        <li>Switch to the window you want to share, then press <kbd>{state?.shortcut === "both-shift" ? "both Shift keys together" : accelerator}</kbd>.</li>
        <li>Inertia brings you back to that chat. Review the image and accessibility details before sending.</li>
      </ol>
      <p className="settings-card-note">Detected editable fields are masked. Screenshots and accessibility context may still contain sensitive information, including overlapping windows. Review before sending.</p>
    </section>
    <section className="settings-card" aria-labelledby="snapshot-access-heading" data-setting-id="snapshot-access">
      <h3 id="snapshot-access-heading">Capture access</h3>
      {state?.permission === "required" ? <>
        <p>Allow Inertia in macOS Accessibility and Screen Recording, then return here.</p>
        <div className="snapshot-permission-actions">
          <button type="button" className="secondary-button" disabled={pending} onClick={() => void request({ type: "permission", permission: "accessibility" })}>Accessibility settings</button>
          <button type="button" className="secondary-button" disabled={pending} onClick={() => void request({ type: "permission", permission: "screen" })}>Screen Recording settings</button>
        </div>
      </> : <p className="settings-card-note">{state?.permission === "granted" ? "macOS capture permissions are granted." : "Capture access depends on the foreground app. Inertia checks that it can locate and mask editable fields before returning an image."}</p>}
      {linux && <p className="settings-card-note">On Linux X11, Chromium apps must expose their accessibility tree. If capture reports that it is unavailable, restart the target app with <code>--force-renderer-accessibility</code> or <code>ACCESSIBILITY_ENABLED=1</code>. On Wayland, use Take reviewed screenshot in the chat instead.</p>}
    </section>
  </div>;
}
