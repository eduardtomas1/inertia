import { SettingSwitch } from "./settings/SettingControls";
import { SettingDisclosure, SettingRow, SettingsGroup } from "./settings/SettingsLayout";
import { useSnapshotSettings } from "./settings/useSnapshotSettings";
import "./SnapshotSettings.css";

const failureMessage = (cause: unknown): string => cause instanceof Error ? cause.message : "Snapshots unavailable.";

export function SnapshotSettings(): React.JSX.Element {
  const { available, state, error, pending, linux, accelerator, request, configure } = useSnapshotSettings();
  if (!available) return <p role="status">Snapshots is available in the desktop app.</p>;
  return <SettingsGroup title="Snapshots" headingId="snapshot-capture-heading" className="snapshot-settings">
    {linux && <section aria-labelledby="screenshot-reviewed-heading">
      <h4 id="screenshot-reviewed-heading">Reviewed screenshots</h4>
      <p className="settings-card-note">Use Take reviewed screenshot beside the chat attachment button. Choose a window or screen, review it, and crop or mask sensitive areas before attaching.</p>
      <p className="settings-card-note">No accessibility tree or global shortcut is needed. Automatic masking is not verified. The image is attached only after you approve it.</p>
      {state && <p role="status">Capture method: {state.reviewedBackend === "system-picker" ? "Wayland system picker (requires desktop portal and PipeWire support)" : state.reviewedBackend === "window-picker" ? "X11 window and screen picker" : "Unavailable in this session"}.</p>}
    </section>}
    <SettingSwitch
      id="snapshots-enabled"
      title="Window snapshots"
      description="Attach the foreground window and its accessibility context to the selected chat with a global shortcut. Experimental."
      checked={state?.enabled ?? false}
      disabled={pending || !state?.available}
      failure={failureMessage}
      onChange={(enabled) => state ? configure({ type: "configure", enabled, shortcut: state.shortcut }) : undefined}
    />
    {!state && !error && <p role="status">Loading Snapshots settings…</p>}
    {state?.message && <p role="status" className="settings-card-note">{state.message}</p>}
    {error && <p role="alert" className="snapshot-settings-error">{error}</p>}
    <SettingRow id="snapshot-access" title="Capture access" description={<>
      {state?.permission === "required"
        ? "Allow Inertia in macOS Accessibility and Screen Recording, then return here."
        : state?.permission === "granted" ? "macOS capture permissions are granted." : "Capture access depends on the foreground app. Inertia checks that it can locate and mask editable fields before returning an image."}
      {linux && <> On Linux X11, Chromium apps must expose their accessibility tree. If capture reports that it is unavailable, restart the target app with <code>--force-renderer-accessibility</code> or <code>ACCESSIBILITY_ENABLED=1</code>. On Wayland, use Take reviewed screenshot in the chat instead.</>}
    </>}>
      {state?.permission === "required" && <div className="snapshot-permission-actions">
        <button type="button" className="secondary-button" disabled={pending} onClick={() => void request({ type: "permission", permission: "accessibility" })}>Accessibility settings</button>
        <button type="button" className="secondary-button" disabled={pending} onClick={() => void request({ type: "permission", permission: "screen" })}>Screen Recording settings</button>
      </div>}
    </SettingRow>
    <SettingDisclosure summary="How to take a snapshot">
      <ol className="snapshot-instructions">
        <li>Focus the message box of the chat that should receive it.</li>
        <li>Switch to the window you want to share, then press <kbd>{state?.shortcut === "both-shift" ? "both Shift keys together" : accelerator}</kbd>.</li>
        <li>Review the image and accessibility details before sending.</li>
      </ol>
      <p className="settings-card-note">Detected editable fields are masked. Screenshots may still contain sensitive information, including overlapping windows.</p>
    </SettingDisclosure>
  </SettingsGroup>;
}
