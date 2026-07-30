import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

import {
  forceKillPosixProcessTreeWithStatus,
  posixDescendantPids,
} from "../node/posix-process-tree.js";

const PROCESS_TREE_TIMEOUT_MS = 2_000;

interface RuntimeTreeDependencies {
  platform: NodeJS.Platform;
  kill: typeof process.kill;
  spawnProcessSync: typeof spawnSync;
  environment: NodeJS.ProcessEnv;
}

export const runtimeDescendantPids = posixDescendantPids;

function inheritedWindowsSystemRoot(
  environment: NodeJS.ProcessEnv,
): string | null {
  const value = (name: string): string | undefined =>
    Object.entries(environment).find(([key]) =>
      key.toLowerCase() === name
    )?.[1];
  const candidate = (value("systemroot") ?? value("windir"))?.trim();
  return candidate && win32.isAbsolute(candidate)
    ? win32.normalize(candidate)
    : null;
}

/**
 * Freezes the POSIX utility and repeatedly freezes newly discovered process
 * groups before termination. The rescan closes the snapshot race where an
 * already-running provider creates a child while the utility is stopped.
 * Windows waits synchronously and boundedly for the trusted System32 taskkill
 * to finish. A direct-child fallback is best effort only and is never reported
 * as confirmed process-tree cleanup.
 */
export function forceKillRuntimeProcessTree(
  runtimePid: number,
  dependencies: Partial<RuntimeTreeDependencies> = {},
): boolean {
  if (!Number.isSafeInteger(runtimePid) || runtimePid <= 1) return true;
  const platform = dependencies.platform ?? process.platform;
  const kill = dependencies.kill ?? process.kill;
  const spawnProcessSync = dependencies.spawnProcessSync ?? spawnSync;
  const environment = dependencies.environment ?? process.env;
  if (platform === "win32") {
    const systemRoot = inheritedWindowsSystemRoot(environment);
    let terminated = false;
    if (systemRoot) {
      try {
        const result = spawnProcessSync(
          win32.join(systemRoot, "System32", "taskkill.exe"),
          ["/pid", String(runtimePid), "/t", "/f"],
          {
            env: environment,
            timeout: PROCESS_TREE_TIMEOUT_MS,
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          },
        );
        terminated = result.status === 0 && !result.error;
      } catch {
        // Direct runtime termination below remains bounded best effort.
      }
    }
    if (!terminated) {
      try { kill(runtimePid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    return terminated;
  }

  const killed = forceKillPosixProcessTreeWithStatus(runtimePid, {
    kill,
    spawnProcessSync,
    rootProcessGroup: false,
  });
  return killed.snapshotConfirmed;
}
