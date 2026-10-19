/** Wayland exposes no window pixels to an accessibility client; X11 needs a display. */
export function appControlScreenshotAvailable(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  if (platform !== "linux") return false;
  return env.XDG_SESSION_TYPE !== "wayland" && Boolean(env.DISPLAY);
}
