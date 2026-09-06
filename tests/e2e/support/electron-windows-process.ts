import type { ChildProcess } from "node:child_process";

import { forceTerminateProcessTreeByPidAndWait,
  type AwaitableProcessLifecycleDependencies } from "../../../src/server/process-lifecycle";

export type WindowsElectronProcessDependencies = Pick<
  AwaitableProcessLifecycleDependencies, "spawnProcess" | "windowsSystemRoot"
>;

export async function forceStopWindowsElectronLauncher(
  child: ChildProcess,
  timeoutMs: number,
  dependencies: WindowsElectronProcessDependencies = {},
): Promise<boolean> {
  const pid = child.pid;
  // Playwright's Windows child is the shell launcher. Signal its exact tree
  // while this retained child is still live; never retarget an exited PID.
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid
    || child.exitCode !== null || child.signalCode !== null
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;

  let closed = false;
  let resolveClose: ((closed: boolean) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onClose = (): void => {
    closed = true;
    if (timer) clearTimeout(timer);
    resolveClose?.(true);
  };
  child.once("close", onClose);
  try {
    return await forceTerminateProcessTreeByPidAndWait(pid, (waitMs) => {
      if (closed) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        resolveClose = resolve;
        timer = setTimeout(() => resolve(false), waitMs);
      });
    }, { ...dependencies, platform: "win32", waitMs: timeoutMs });
  } finally {
    if (timer) clearTimeout(timer);
    child.off("close", onClose);
  }
}
