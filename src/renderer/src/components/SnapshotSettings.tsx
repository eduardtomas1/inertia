import { SettingSwitch } from "./settings/SettingControls";
import { SettingActionRow, SettingDisclosure, SettingNoteStatus, SettingsGroup } from "./settings/SettingsLayout";
import type { SettingNotice } from "./settings/useSettingAction";
import { useSnapshotSettings } from "./settings/useSnapshotSettings";
import "./SnapshotSettings.css";

const failureMessage = (cause: unknown): string => cause instanceof Error ? cause.message : "Snapshots unavailable.";

const REVIEWED_BACKENDS = {
  "system-picker": "Wayland system picker (needs the desktop portal and PipeWire)",
  "window-picker": "X11 window and screen picker",
} as const;

export function SnapshotSettings(): React.JSX.Element {
  const { available, state, error, pending, linux, accelerator, request, configure } = useSnapshotSettings();
  if (!available) {
    return <SettingsGroup title="Snapshots" headingId="snapshot-capture-heading" className="snapshot-settings">
      <p className="snapshot-settings-note" role="status">Snapshots is available in the desktop app.</p>
    </SettingsGroup>;
  }
  const notice: SettingNotice | null = error
    ? { tone: "error", text: error }
    : !state ? { tone: "info", text: "Loading Snapshots settings…" }
      : state.message ? { tone: "info", text: state.message } : null;
  const requestPermission = (permission: "accessibility" | "screen"): void => {
    if (!pending) void request({ type: "permission", permission });
  };
  return <SettingsGroup title="Snapshots" headingId="snapshot-capture-heading" className="snapshot-settings">
    {linux && <SettingActionRow
      className="runtime-log-setting"
      title="Reviewed screenshots"
      description="Use Take reviewed screenshot beside the attachment button to choose a window or screen, then crop or mask it before attaching. Automatic masking is not verified."
      details={state && <small role="status">Capture method: {state.reviewedBackend ? REVIEWED_BACKENDS[state.reviewedBackend] : "unavailable in this session"}</small>}
    />}
    <SettingSwitch
      id="snapshots-enabled"
      title="Window snapshots"
      description="Attach the foreground window and its accessibility context to the selected chat with a global shortcut. Screenshots may still contain sensitive information, including overlapping windows. Experimental."
      checked={state?.enabled ?? false}
      inactive={pending || !state?.available}
      failure={failureMessage}
      onChange={async (enabled) => {
        if (!state) return;
        const result = await configure({ type: "configure", enabled, shortcut: state.shortcut });
        if (result.enabled !== enabled) throw new Error(`Window snapshots could not be turned ${enabled ? "on" : "off"}.`);
      }}
    />
    <SettingActionRow
      id="snapshot-access"
      className="runtime-log-setting"
      title="Capture access"
      description={<>
        {state?.permission === "required"
          ? "Allow Inertia in macOS Accessibility and Screen Recording, then return here."
          : state?.permission === "granted" ? "macOS capture permissions are granted." : "Depends on the foreground app. Inertia must find and mask its editable fields before it returns an image."}
        {linux && <> On X11, restart Chromium apps with <code>--force-renderer-accessibility</code> if capture is unavailable. On Wayland, use Take reviewed screenshot instead.</>}
      </>}
      actions={state?.permission === "required" ? <>
        <button type="button" className="secondary-button" aria-disabled={pending || undefined} onClick={() => requestPermission("accessibility")}>Accessibility settings</button>
        <button type="button" className="secondary-button" aria-disabled={pending || undefined} onClick={() => requestPermission("screen")}>Screen Recording settings</button>
      </> : undefined}
    />
    <div className="snapshot-settings-status">
      <SettingNoteStatus notice={notice} />
    </div>
    <SettingDisclosure summary="How to take a snapshot" className="snapshot-settings-guide">
      <ol className="snapshot-instructions">
        <li>Focus the message box of the chat that should receive it.</li>
        <li>Switch to the window you want to share, then press <kbd>{state?.shortcut === "both-shift" ? "both Shift keys together" : accelerator}</kbd>.</li>
        <li>Review the image and accessibility details before sending.</li>
      </ol>
      <p className="snapshot-settings-note">Detected editable fields are masked.</p>
    </SettingDisclosure>
  </SettingsGroup>;
}
