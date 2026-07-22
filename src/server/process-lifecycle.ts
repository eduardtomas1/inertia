import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Stops the whole provider process group when possible, then falls back to the
 * direct child. Supervision policy intentionally lives with the caller.
 */
export function terminateProcessTree(child: ChildProcessWithoutNullStreams, force: boolean): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill.exe", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      }).unref();
      return;
    } catch {
      // Fall through to the direct child signal.
    }
  } else {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      // The process group may already be gone.
    }
  }
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The child may already have exited.
  }
}
