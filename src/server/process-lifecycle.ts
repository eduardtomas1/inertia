import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface ProcessLifecycleDependencies {
  platform: NodeJS.Platform;
  spawnProcess: typeof spawn;
  killProcess: typeof process.kill;
}

function killDirectChild(child: ChildProcessWithoutNullStreams, force: boolean): void {
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The child may already have exited.
  }
}

/**
 * Stops the whole provider process group when possible, then falls back to the
 * direct child. Supervision policy intentionally lives with the caller.
 */
export function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  dependencies: Partial<ProcessLifecycleDependencies> = {},
): void {
  const platform = dependencies.platform ?? process.platform;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const killProcess = dependencies.killProcess ?? process.kill;
  const pid = child.pid;
  if (!pid) return;
  if (platform === "win32") {
    try {
      const taskkill = spawnProcess("taskkill.exe", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      let fellBack = false;
      const fallback = (): void => {
        if (fellBack) return;
        fellBack = true;
        killDirectChild(child, force);
      };
      taskkill.once("error", fallback);
      taskkill.once("close", (code) => { if (code !== 0) fallback(); });
      taskkill.unref();
      return;
    } catch {
      // Fall through to the direct child signal.
    }
  } else {
    try {
      killProcess(-pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      // The process group may already be gone.
    }
  }
  killDirectChild(child, force);
}
