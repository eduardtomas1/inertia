import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";

import {
  forceKillPosixProcessTreeWithStatus,
  posixDescendantPids,
} from "../node/posix-process-tree.js";

const PROCESS_TREE_TIMEOUT_MS = 2_000;
const PROCESS_TREE_POLL_MS = 10;

interface RuntimeTreeDependencies {
  platform: NodeJS.Platform;
  rootProcessGroup: boolean;
  kill: typeof process.kill;
  spawnProcessSync: typeof spawnSync;
  environment: NodeJS.ProcessEnv;
  readFile: (path: string, encoding: "utf8") => string;
  deadlineAt: number;
  now: () => number;
  setTimer: typeof setTimeout;
}

export const runtimeDescendantPids = posixDescendantPids;

type LinuxProcessState = "live" | "non-executing" | "missing" | "unknown";

function linuxProcessState(
  pid: number,
  readFile: RuntimeTreeDependencies["readFile"],
): LinuxProcessState {
  let stat: string;
  try {
    stat = readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return error
      && typeof error === "object"
      && "code" in error
      && (error.code === "ENOENT" || error.code === "ESRCH")
      ? "missing"
      : "unknown";
  }
  const closingName = stat.lastIndexOf(")");
  if (closingName < 2) return "unknown";
  const state = stat.slice(closingName + 1).trimStart()[0];
  if (state === "Z" || state === "X" || state === "x") {
    return "non-executing";
  }
  return state && /^[A-Za-z]$/u.test(state) ? "live" : "unknown";
}

function processIsMissing(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "ESRCH";
}

async function waitForDescendantsExit(
  descendants: readonly number[],
  platform: NodeJS.Platform,
  kill: typeof process.kill,
  readFile: RuntimeTreeDependencies["readFile"],
  deadlineAt: number,
  now: () => number,
  setTimer: typeof setTimeout,
): Promise<boolean> {
  const remaining = new Set(descendants);
  while (remaining.size > 0) {
    for (const pid of remaining) {
      if (platform === "linux") {
        const state = linuxProcessState(pid, readFile);
        // Linux documents Z as zombie and X/x as dead. None has executable
        // address space or can create or retain descendants, but each may
        // remain signal-visible while an external parent or the kernel reaps
        // it. That must not turn confirmed post-kill cleanup into a reboot.
        if (state === "missing" || state === "non-executing") {
          remaining.delete(pid);
          continue;
        }
      }
      try {
        kill(pid, 0);
      } catch (error) {
        if (processIsMissing(error)) remaining.delete(pid);
      }
    }
    if (remaining.size === 0) return true;
    const remainingMs = Math.trunc(deadlineAt - now());
    if (remainingMs <= 0) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimer(
        resolve,
        Math.max(1, Math.min(PROCESS_TREE_POLL_MS, remainingMs)),
      );
      timer.unref();
    });
  }
  return true;
}

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
export async function forceKillRuntimeProcessTree(
  runtimePid: number,
  dependencies: Partial<RuntimeTreeDependencies> = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(runtimePid) || runtimePid <= 1) return true;
  const platform = dependencies.platform ?? process.platform;
  const kill = dependencies.kill ?? process.kill;
  const spawnProcessSync = dependencies.spawnProcessSync ?? spawnSync;
  const environment = dependencies.environment ?? process.env;
  const readFile = dependencies.readFile
    ?? ((path, encoding) => readFileSync(path, encoding));
  const now = dependencies.now ?? Date.now;
  const deadlineAt = dependencies.deadlineAt
    ?? now() + PROCESS_TREE_TIMEOUT_MS;
  const setTimer = dependencies.setTimer ?? setTimeout;
  if (platform === "win32") {
    const systemRoot = inheritedWindowsSystemRoot(environment);
    let terminated = false;
    const remainingMs = Math.trunc(deadlineAt - now());
    if (systemRoot && remainingMs > 0) {
      try {
        const result = spawnProcessSync(
          win32.join(systemRoot, "System32", "taskkill.exe"),
          ["/pid", String(runtimePid), "/t", "/f"],
          {
            env: environment,
            timeout: Math.max(
              1,
              Math.min(PROCESS_TREE_TIMEOUT_MS, remainingMs),
            ),
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
    rootProcessGroup: dependencies.rootProcessGroup ?? false,
    deadlineAt,
    now,
  });
  return killed.snapshotConfirmed
    && await waitForDescendantsExit(
      [runtimePid, ...killed.descendants],
      platform,
      kill,
      readFile,
      deadlineAt,
      now,
      setTimer,
    );
}
