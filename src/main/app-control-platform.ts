/**
 * The Linux desktop session as App control sees it: Wayland when the session
 * says so, or when a Wayland display is set unless the session says X11
 * (an X11 display beside it is then only XWayland); otherwise X11.
 */
export function appControlLinuxSession(env: NodeJS.ProcessEnv): "wayland" | "x11" {
  if (env.XDG_SESSION_TYPE === "wayland") return "wayland";
  if (env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== "x11") return "wayland";
  return "x11";
}

/** Wayland exposes no window pixels to an accessibility client; X11 needs a display. */
export function appControlScreenshotAvailable(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  if (platform !== "linux") return false;
  return appControlLinuxSession(env) === "x11" && Boolean(env.DISPLAY);
}

/**
 * Synthesized key and wheel input (xa11y `InputSim`): CGEvent on macOS,
 * SendInput on Windows, XTest on X11. Wayland offers an accessibility client
 * no way to inject input into another app's window.
 */
export function appControlInputAvailable(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return appControlScreenshotAvailable(platform, env);
}

/** Why synthesized input is unavailable: Wayland has its own reason; anything else is generic. */
export function appControlInputUnavailableReason(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): "input-wayland" | "input-unavailable" {
  return platform === "linux" && appControlLinuxSession(env) === "wayland" ? "input-wayland" : "input-unavailable";
}
