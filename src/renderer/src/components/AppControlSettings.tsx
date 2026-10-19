import type { AppControlSettingsState } from "@shared/app-control-settings";
import { SettingActionRow, SettingNoteStatus, SettingsGroup } from "./settings/SettingsLayout";
import type { SettingNotice } from "./settings/useSettingAction";
import { useAppControlSettings } from "./settings/useAppControlSettings";
import "./SnapshotSettings.css";

/** What the agent may reach, in fixed wording; the state comes from main's App control service. */
function accessDescription(state: AppControlSettingsState): React.ReactNode {
  if (!state.available) {
    return state.platform === "unsupported"
      ? "Native window control is not available on this platform. The agent can still read the app's output."
      : "App control is off until Inertia restarts, because one of its helper processes could not be confirmed stopped.";
  }
  switch (state.accessibility) {
    case "granted":
      return "macOS allows Inertia to read and control the windows of apps launched from the App surface.";
    case "required":
      return "Allow Inertia in System Settings → Privacy & Security → Accessibility, then return here.";
    case "helper-denied":
      return "macOS lists Inertia as allowed in Accessibility, but denied access to its App control helper, so native windows cannot be read with this build on this Mac. The agent can still read the app's output.";
    case "available":
      return state.platform === "win32"
        ? "Available. Windows blocks access to an app that runs as administrator: start it without elevation."
        : <>AT-SPI is available. Chromium and Electron apps expose their windows only with <code>--force-renderer-accessibility</code> or <code>ACCESSIBILITY_ENABLED=1</code>; project actions are started with the variable set.</>;
    case "unavailable":
      return "The desktop's AT-SPI accessibility bus did not answer, so native windows cannot be read. Turn on accessibility support for your desktop session (the at-spi2-core service), then restart Inertia.";
  }
}

function screenshotDescription(state: AppControlSettingsState): string {
  if (state.platform === "darwin") {
    return state.screenRecording === "granted"
      ? "Screen Recording is allowed. Screenshots of a launched app's window stay on this device as evidence."
      : "Allow Inertia in Screen Recording to keep screenshots of a launched app's window as local evidence.";
  }
  if (state.screenshots === "unavailable") {
    return state.session === "wayland"
      ? "Unavailable on Wayland: the desktop does not let Inertia read window pixels. The agent can still read the window."
      : "Unavailable: Inertia found no display to capture.";
  }
  return "Screenshots capture the window's area of the screen, so they can include windows overlapping it. They stay on this device as evidence.";
}

export function AppControlSettings(): React.JSX.Element {
  const { available, state, error, pending, openPane } = useAppControlSettings();
  const description = "The agent can inspect and drive the native windows of apps launched from a chat's App surface through the system's accessibility API. It reads only the processes Inertia launched for that chat, never password managers or system prompts, and it never moves your pointer or types on your keyboard. Allow or block it per project with Agent app access.";
  if (!available) {
    return <SettingsGroup title="App control" headingId="app-control-heading" className="snapshot-settings" description={description}>
      <p className="snapshot-settings-note" role="status">App control is available in the desktop app.</p>
    </SettingsGroup>;
  }
  const notice: SettingNotice | null = error
    ? { tone: "error", text: error }
    : !state ? { tone: "info", text: "Checking App control access…" } : null;
  const mac = state?.platform === "darwin";
  return <SettingsGroup title="App control" headingId="app-control-heading" className="snapshot-settings" description={description}>
    <SettingActionRow
      id="app-control-access"
      className="runtime-log-setting"
      title="Native window access"
      description={state ? accessDescription(state) : "Checking…"}
      actions={mac && state.available && state.accessibility !== "granted" ? (
        <button type="button" className="secondary-button" aria-disabled={pending || undefined} onClick={() => openPane("accessibility")}>
          Accessibility settings
        </button>
      ) : undefined}
    />
    <SettingActionRow
      id="app-control-screenshots"
      className="runtime-log-setting"
      title="Window screenshots"
      description={state ? screenshotDescription(state) : "Checking…"}
      actions={mac && state.available && state.screenRecording === "required" ? (
        <button type="button" className="secondary-button" aria-disabled={pending || undefined} onClick={() => openPane("screen-recording")}>
          Screen Recording settings
        </button>
      ) : undefined}
    />
    <div className="snapshot-settings-status">
      <SettingNoteStatus notice={notice} />
    </div>
  </SettingsGroup>;
}
