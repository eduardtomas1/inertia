/**
 * What the Settings → Devices & integrations → App control card may know
 * about native window control: fixed categories from main's App control
 * service, never a window, process, path or native message.
 */

export const APP_CONTROL_SETTINGS_PLATFORMS = ["darwin", "win32", "linux", "unsupported"] as const;
export type AppControlSettingsPlatform = (typeof APP_CONTROL_SETTINGS_PLATFORMS)[number];

/**
 * - `granted`: macOS allows Inertia in Accessibility and its helper can read windows.
 * - `required`: macOS has not allowed Inertia in Accessibility.
 * - `helper-denied`: macOS lists Inertia as allowed but denied its App control helper.
 * - `available` / `unavailable`: Windows, or whether the Linux AT-SPI bus answered.
 */
export const APP_CONTROL_ACCESSIBILITY_STATES = ["granted", "required", "helper-denied", "available", "unavailable"] as const;
export type AppControlAccessibilityState = (typeof APP_CONTROL_ACCESSIBILITY_STATES)[number];

export const APP_CONTROL_SCREEN_RECORDING_STATES = ["granted", "required", "not-needed"] as const;
export type AppControlScreenRecordingState = (typeof APP_CONTROL_SCREEN_RECORDING_STATES)[number];

/**
 * Synthesized keyboard and wheel input to an activated native window:
 * macOS needs Accessibility (`required` until it is granted), Windows and
 * X11 have it, Wayland and an unsupported platform do not.
 */
export const APP_CONTROL_INPUT_STATES = ["available", "required", "unavailable"] as const;
export type AppControlInputState = (typeof APP_CONTROL_INPUT_STATES)[number];

export interface AppControlSettingsState {
  platform: AppControlSettingsPlatform;
  /** False after a helper's exit could not be confirmed, until Inertia restarts. */
  available: boolean;
  accessibility: AppControlAccessibilityState;
  screenRecording: AppControlScreenRecordingState;
  /** Wayland and a missing X11 display have no window capture. */
  screenshots: "available" | "unavailable";
  /** Linux only: the desktop session type; null elsewhere. */
  session: "x11" | "wayland" | null;
  input: AppControlInputState;
}

/** Opening a macOS privacy pane happens only on an explicit click in the card. */
export type AppControlSettingsRequest =
  | { type: "state" }
  | { type: "open-settings"; pane: "accessibility" | "screen-recording" };

const KEYS = ["platform", "available", "accessibility", "screenRecording", "screenshots", "session", "input"] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict parse of a state crossing the preload boundary; null when anything is off. */
export function parseAppControlSettingsState(value: unknown): AppControlSettingsState | null {
  if (!plainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  const { platform, available, accessibility, screenRecording, screenshots, session, input } = value;
  if (!APP_CONTROL_SETTINGS_PLATFORMS.includes(platform as AppControlSettingsPlatform)
    || typeof available !== "boolean"
    || !APP_CONTROL_ACCESSIBILITY_STATES.includes(accessibility as AppControlAccessibilityState)
    || !APP_CONTROL_SCREEN_RECORDING_STATES.includes(screenRecording as AppControlScreenRecordingState)
    || (screenshots !== "available" && screenshots !== "unavailable")
    || (session !== null && session !== "x11" && session !== "wayland")
    || !APP_CONTROL_INPUT_STATES.includes(input as AppControlInputState)) return null;
  return {
    platform: platform as AppControlSettingsPlatform,
    available,
    accessibility: accessibility as AppControlAccessibilityState,
    screenRecording: screenRecording as AppControlScreenRecordingState,
    screenshots,
    session,
    input: input as AppControlInputState,
  };
}
