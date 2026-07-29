import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";

import { forceKillPosixProcessTree } from "../node/posix-process-tree";

const DEFAULT_TERMINATION_WAIT_MS = 2_000;
const PROCESS_GROUP_POLL_MS = 10;

export interface ProcessLifecycleDependencies {
  platform: NodeJS.Platform;
  spawnProcess: typeof spawn;
  killProcess: typeof process.kill;
}

export interface AwaitableProcessLifecycleDependencies
  extends Partial<ProcessLifecycleDependencies> {
  spawnProcessSync?: typeof spawnSync;
  waitMs?: number;
}

export type ProcessTreeTerminator = (
  child: ChildProcess,
  force: boolean,
) => Promise<boolean>;

export class ProcessTreeTerminationError extends Error {
  readonly code = "process-tree-termination-unconfirmed";

  constructor(subject: string, options?: ErrorOptions) {
    super(`${subject} could not be confirmed stopped.`, options);
    this.name = "ProcessTreeTerminationError";
  }
}

export async function requireProcessTreeTermination(
  terminate: ProcessTreeTerminator,
  child: ChildProcess,
  force: boolean,
  subject: string,
): Promise<void> {
  let confirmed: boolean;
  try {
    confirmed = await terminate(child, force);
  } catch (cause) {
    throw new ProcessTreeTerminationError(subject, { cause });
  }
  if (!confirmed) throw new ProcessTreeTerminationError(subject);
}

function killDirectChild(child: ChildProcess, force: boolean): void {
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
  child: ChildProcess,
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

function boundedWaitMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TERMINATION_WAIT_MS;
  return Math.max(1, Math.min(Math.trunc(value), 30_000));
}

function directChildResourcesAreClosed(child: ChildProcess): boolean {
  if (child.exitCode === null && child.signalCode === null) return false;
  return child.stdio.every((stream) =>
    stream === null || stream === undefined || stream.closed
  );
}

function observeDirectChildClose(
  child: ChildProcess,
): (waitMs: number) => Promise<boolean> {
  // An exit code alone is not enough: Node may set it before child stdio and
  // executable resources have closed. Preserve the settled-child fast path
  // only when every public stdio stream is already closed.
  let closed = directChildResourcesAreClosed(child);
  let finishWait: ((closed: boolean) => void) | undefined;
  const onClose = (): void => {
    closed = true;
    finishWait?.(true);
  };
  if (!closed) child.once("close", onClose);

  return (waitMs) => {
    if (closed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (didClose: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finishWait = undefined;
        child.off("close", onClose);
        resolve(didClose);
      };
      finishWait = finish;
      const timer = setTimeout(() => finish(false), waitMs);
    });
  };
}

function waitForDirectChildExit(
  child: ChildProcess,
  waitMs: number,
): Promise<boolean> {
  return observeDirectChildClose(child)(waitMs);
}

function waitForPosixProcessGroupExit(
  pid: number,
  killProcess: typeof process.kill,
  waitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  return new Promise<boolean>((resolve) => {
    const inspect = (): void => {
      try {
        killProcess(-pid, 0);
      } catch {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(inspect, PROCESS_GROUP_POLL_MS);
    };
    inspect();
  });
}

function waitForPosixProcessesExit(
  pids: readonly number[],
  killProcess: typeof process.kill,
  waitMs: number,
): Promise<boolean> {
  const remaining = new Set(pids);
  const deadline = Date.now() + waitMs;
  return new Promise<boolean>((resolve) => {
    const inspect = (): void => {
      for (const pid of remaining) {
        try {
          killProcess(pid, 0);
        } catch {
          remaining.delete(pid);
        }
      }
      if (remaining.size === 0) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(inspect, PROCESS_GROUP_POLL_MS);
    };
    inspect();
  });
}

function terminateWindowsProcessTree(
  pid: number,
  force: boolean,
  spawnProcess: typeof spawn,
  waitMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let taskkill: ReturnType<typeof spawn>;
    try {
      taskkill = spawnProcess(
        "taskkill.exe",
        ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        },
      );
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (terminated: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      taskkill.off("error", onError);
      taskkill.off("close", onClose);
      resolve(terminated);
    };
    const onError = (): void => finish(false);
    const onClose = (code: number | null): void => finish(code === 0);
    const timer = setTimeout(() => {
      try {
        taskkill.kill("SIGKILL");
      } catch {
        // The taskkill process may already have exited.
      }
      finish(false);
    }, waitMs);
    taskkill.once("error", onError);
    taskkill.once("close", onClose);
  });
}

/**
 * Terminates an owned process tree and waits for bounded confirmation.
 *
 * POSIX callers must spawn the direct child with `detached: true`, making its
 * PID the process-group ID. Windows callers require both successful taskkill
 * completion and the direct child's `close` event.
 */
export async function terminateProcessTreeAndWait(
  child: ChildProcess,
  force: boolean,
  dependencies: AwaitableProcessLifecycleDependencies = {},
): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return true;
  const platform = dependencies.platform ?? process.platform;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const spawnProcessSync = dependencies.spawnProcessSync ?? spawnSync;
  const killProcess = dependencies.killProcess ?? process.kill;
  const waitMs = boundedWaitMs(dependencies.waitMs);

  if (platform === "win32") {
    const waitForObservedDirectChildClose = observeDirectChildClose(child);
    const treeTerminated = await terminateWindowsProcessTree(
      pid,
      force,
      spawnProcess,
      waitMs,
    );
    if (treeTerminated) {
      // taskkill confirms that it issued termination for the owned tree, but
      // Windows can keep the direct child's executable image locked until the
      // ChildProcess has emitted close. Do not let callers release temporary
      // executables or other owned resources before that handle is closed.
      return await waitForObservedDirectChildClose(waitMs);
    }
    killDirectChild(child, force);
    return await waitForObservedDirectChildClose(waitMs);
  }

  if (force) {
    const descendants = forceKillPosixProcessTree(pid, {
      kill: killProcess,
      spawnProcessSync,
      rootProcessGroup: true,
    });
    const [groupExited, descendantsExited] = await Promise.all([
      waitForPosixProcessGroupExit(pid, killProcess, waitMs),
      waitForPosixProcessesExit(descendants, killProcess, waitMs),
    ]);
    return groupExited && descendantsExited;
  }
  try {
    killProcess(-pid, "SIGTERM");
    return await waitForPosixProcessGroupExit(pid, killProcess, waitMs);
  } catch {
    killDirectChild(child, false);
    return await waitForDirectChildExit(child, waitMs);
  }
}
