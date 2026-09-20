import { pathToFileURL } from "node:url";
import { utilityProcess } from "electron";

/** GIO may contact a desktop service; isolate native calls and bound its lifetime. */
export async function setLinuxFileIcon(file: string, icon: string, workerPath: string): Promise<boolean> {
  const environment: Record<string, string> = {};
  for (const key of ["HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG"]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  const child = utilityProcess.fork(workerPath, [], {
    env: environment, stdio: "ignore", serviceName: "Inertia File Icon",
  });
  return new Promise((resolveResult) => {
    let finished = false;
    const timeout = setTimeout(fail, 5_000);
    function finish(success: boolean): void {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolveResult(success);
    }
    function fail(): void {
      if (finished) return;
      finish(false);
      try { child.kill(); } catch { /* Optional metadata must not interrupt the app. */ }
    }
    // Fatal utility errors can arrive before exit. Consume them and never turn
    // a failed worker into success because a later exit happens to report zero.
    child.on("error", fail);
    child.once("exit", (code) => finish(code === 0));
    child.once("spawn", () => {
      if (finished) return;
      try { child.postMessage({ file, icon: pathToFileURL(icon).href }); } catch { fail(); }
    });
  });
}
