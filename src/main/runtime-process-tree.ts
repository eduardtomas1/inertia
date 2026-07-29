import { spawnSync } from "node:child_process";

import {
  forceKillPosixProcessTree,
  posixDescendantPids,
} from "../node/posix-process-tree.js";

const PROCESS_TREE_TIMEOUT_MS = 2_000;

interface RuntimeTreeDependencies {
  platform: NodeJS.Platform;
  kill: typeof process.kill;
  spawnProcessSync: typeof spawnSync;
}

export const runtimeDescendantPids = posixDescendantPids;

/**
 * Freezes the POSIX utility and repeatedly freezes newly discovered process
 * groups before termination. The rescan closes the snapshot race where an
 * already-running provider creates a child while the utility is stopped.
 * Windows waits synchronously and boundedly for taskkill to finish.
 */
export function forceKillRuntimeProcessTree(
  runtimePid: number,
  dependencies: Partial<RuntimeTreeDependencies> = {},
): void {
  if (!Number.isSafeInteger(runtimePid) || runtimePid <= 1) return;
  const platform = dependencies.platform ?? process.platform;
  const kill = dependencies.kill ?? process.kill;
  const spawnProcessSync = dependencies.spawnProcessSync ?? spawnSync;
  if (platform === "win32") {
    let terminated = false;
    try {
      const result = spawnProcessSync(
        "taskkill.exe",
        ["/pid", String(runtimePid), "/t", "/f"],
        {
          timeout: PROCESS_TREE_TIMEOUT_MS,
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      terminated = result.status === 0 && !result.error;
    } catch {
      // Direct runtime termination remains the bounded fallback.
    }
    if (!terminated) {
      try { kill(runtimePid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    return;
  }

  forceKillPosixProcessTree(runtimePid, {
    kill,
    spawnProcessSync,
    rootProcessGroup: false,
  });
}
