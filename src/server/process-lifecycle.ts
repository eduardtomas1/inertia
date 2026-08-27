import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { win32 } from "node:path";

import {
  forceKillPosixProcessTree,
  forceKillPosixProcessTreeWithStatus,
} from "../node/posix-process-tree";
import {
  confirmRuntimeOwnedProcessStopped,
  requestRuntimeOwnedGuardianStop,
} from "../node/runtime-owned-processes";

const DEFAULT_TERMINATION_WAIT_MS = 2_000;
const PROCESS_GROUP_POLL_MS = 10;
const WINDOWS_RESOURCE_SETTLE_MS = 100;

export interface ProcessLifecycleDependencies {
  platform: NodeJS.Platform;
  spawnProcess: typeof spawn;
  killProcess: typeof process.kill;
  windowsSystemRoot: string | null;
}

export interface AwaitableProcessLifecycleDependencies
  extends Partial<ProcessLifecycleDependencies> {
  spawnProcessSync?: typeof spawnSync;
  waitMs?: number;
}

export type WaitForProcessExit = (waitMs: number) => Promise<boolean>;

export type ProcessTreeTerminator = (
  child: ChildProcess,
  force: boolean,
) => Promise<boolean>;

export type OwnedProcessTreeTermination = (
  force: boolean,
) => Promise<void>;

export type OwnedPidProcessTreeTermination = () => Promise<boolean>;

interface ProcessTreeTerminationErrorOptions extends ErrorOptions {
  priorError?: unknown;
}

export class ProcessTreeTerminationError extends Error {
  readonly code = "process-tree-termination-unconfirmed";

  constructor(
    subject: string,
    options?: ProcessTreeTerminationErrorOptions,
  ) {
    const cleanupMessage = `${subject} could not be confirmed stopped.`;
    const priorMessage = options?.priorError instanceof Error
      ? options.priorError.message.trim()
      : "";
    super(
      priorMessage
        ? `${priorMessage} Cleanup also failed: ${cleanupMessage}`
        : cleanupMessage,
      options,
    );
    this.name = "ProcessTreeTerminationError";
  }
}

export function isProcessTreeTerminationUnconfirmed(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null || visited.has(current)) {
      return false;
    }
    visited.add(current);
    if (
      "code" in current
      && current.code === "process-tree-termination-unconfirmed"
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
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

/**
 * Owns one process-tree shutdown sequence for one child.
 *
 * Every caller receives the same promise. A graceful request may be upgraded
 * to a force request, but the force attempt never races the graceful attempt.
 * Failure is reported only after the final force attempt cannot be confirmed.
 */
export function createOwnedProcessTreeTermination(
  child: ChildProcess,
  subject: string,
  terminate: ProcessTreeTerminator = terminateProcessTreeAndWait,
): OwnedProcessTreeTermination {
  let forceRequested = false;
  let termination: Promise<void> | undefined;

  return (force) => {
    forceRequested ||= force;
    termination ??= (async () => {
      if (!forceRequested) {
        try {
          if (await terminate(child, false)) {
            if (!confirmRuntimeOwnedProcessStopped(child)) {
              throw new ProcessTreeTerminationError(subject);
            }
            return;
          }
        } catch {
          // The final force attempt below owns the authoritative result.
        }
      }
      await requireProcessTreeTermination(terminate, child, true, subject);
      if (!confirmRuntimeOwnedProcessStopped(child)) {
        throw new ProcessTreeTerminationError(subject);
      }
    })();
    return termination;
  };
}

function killDirectChild(child: ChildProcess, force: boolean): void {
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The child may already have exited.
  }
}

function inheritedWindowsSystemRoot(
  environment: NodeJS.ProcessEnv = process.env,
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

function windowsSystemExecutable(
  systemRoot: string | null,
  ...segments: string[]
): string {
  return systemRoot
    ? win32.join(systemRoot, "System32", ...segments)
    : segments.at(-1) ?? "";
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
  const windowsSystemRoot = dependencies.windowsSystemRoot === undefined
    ? inheritedWindowsSystemRoot()
    : dependencies.windowsSystemRoot;
  const pid = child.pid;
  if (!pid) return;
  if (platform === "win32") {
    try {
      const taskkill = spawnProcess(
        windowsSystemExecutable(windowsSystemRoot, "taskkill.exe"),
        ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        },
      );
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

async function confirmWindowsChildResourcesClosed(
  waitForObservedClose: (waitMs: number) => Promise<boolean>,
  waitMs: number,
): Promise<boolean> {
  if (!await waitForObservedClose(waitMs)) return false;
  // Windows can report ChildProcess `close` just before the executable image
  // becomes deletable. Give the kernel one short, bounded quiescence window
  // before callers release temporary executables or other owned resources.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(waitMs, WINDOWS_RESOURCE_SETTLE_MS));
  });
  return true;
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
      setTimeout(
        inspect,
        Math.max(1, Math.min(PROCESS_GROUP_POLL_MS, deadline - Date.now())),
      );
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
      setTimeout(
        inspect,
        Math.max(1, Math.min(PROCESS_GROUP_POLL_MS, deadline - Date.now())),
      );
    };
    inspect();
  });
}

function terminateWindowsProcessTree(
  pid: number,
  force: boolean,
  spawnProcess: typeof spawn,
  taskkillExecutable: string,
  waitMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let taskkill: ReturnType<typeof spawn>;
    try {
      taskkill = spawnProcess(
        taskkillExecutable,
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
 * Force-terminates a process tree when the owner exposes a PID and an
 * awaitable exit signal rather than a Node ChildProcess. The caller must
 * observe exit before invoking this function so a fast termination cannot be
 * missed.
 */
export async function forceTerminateProcessTreeByPidAndWait(
  pid: number,
  waitForRootExit: WaitForProcessExit,
  dependencies: AwaitableProcessLifecycleDependencies = {},
): Promise<boolean> {
  return await createOwnedPidProcessTreeTermination(
    pid,
    waitForRootExit,
    dependencies,
  )();
}

/**
 * Owns one PID-backed process-tree termination attempt for its full lifetime.
 *
 * The first call snapshots and signals the tree while the root PID is still
 * known to belong to the caller. Later calls only repeat confirmation for
 * that original attempt. They never re-snapshot or re-signal numeric PIDs,
 * which may have been recycled after a delayed root or descendant exit.
 */
export function createOwnedPidProcessTreeTermination(
  pid: number,
  waitForRootExit: WaitForProcessExit,
  dependencies: AwaitableProcessLifecycleDependencies = {},
): OwnedPidProcessTreeTermination {
  const platform = dependencies.platform ?? process.platform;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const spawnProcessSync = dependencies.spawnProcessSync ?? spawnSync;
  const killProcess = dependencies.killProcess ?? process.kill;
  const windowsSystemRoot = dependencies.windowsSystemRoot === undefined
    ? inheritedWindowsSystemRoot()
    : dependencies.windowsSystemRoot;
  const waitMs = boundedWaitMs(dependencies.waitMs);
  let started = false;
  let treeTerminationConfirmed = false;
  let snapshotConfirmed = false;
  let descendants: readonly number[] = [];

  return async () => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    const deadlineAt = Date.now() + waitMs;

    if (platform === "win32") {
      if (!started) {
        started = true;
        treeTerminationConfirmed = await terminateWindowsProcessTree(
          pid,
          true,
          spawnProcess,
          windowsSystemExecutable(windowsSystemRoot, "taskkill.exe"),
          waitMs,
        );
      }
      if (!treeTerminationConfirmed) return false;
      const rootExitWaitMs = Math.trunc(
        deadlineAt - Date.now() - WINDOWS_RESOURCE_SETTLE_MS,
      );
      if (rootExitWaitMs <= 0 || !await waitForRootExit(rootExitWaitMs)) {
        return false;
      }
      const settleMs = Math.min(
        WINDOWS_RESOURCE_SETTLE_MS,
        Math.max(0, deadlineAt - Date.now()),
      );
      if (settleMs <= 0) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, settleMs);
      });
      return true;
    }

    if (!started) {
      started = true;
      // node-pty creates POSIX terminals with forkpty, making the shell root
      // the process-group leader. A stabilized descendant snapshot also
      // catches children that created their own groups before the root froze.
      const killed = forceKillPosixProcessTreeWithStatus(pid, {
        kill: killProcess,
        spawnProcessSync,
        rootProcessGroup: true,
        deadlineAt,
      });
      snapshotConfirmed = killed.snapshotConfirmed;
      descendants = killed.descendants;
    }
    if (!snapshotConfirmed) return false;
    const exitWaitMs = Math.trunc(deadlineAt - Date.now());
    if (exitWaitMs <= 0) return false;
    const [groupExited, descendantsExited, rootExited] = await Promise.all([
      waitForPosixProcessGroupExit(pid, killProcess, exitWaitMs),
      waitForPosixProcessesExit(descendants, killProcess, exitWaitMs),
      waitForRootExit(exitWaitMs),
    ]);
    return groupExited && descendantsExited && rootExited;
  };
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
  const windowsSystemRoot = dependencies.windowsSystemRoot === undefined
    ? inheritedWindowsSystemRoot()
    : dependencies.windowsSystemRoot;
  const waitMs = boundedWaitMs(dependencies.waitMs);

  if (platform === "win32") {
    // Never target a reused Windows PID after Node has already observed the
    // complete owned child close.
    if (directChildResourcesAreClosed(child)) return true;
    const waitForObservedDirectChildClose = observeDirectChildClose(child);
    const treeTerminated = await terminateWindowsProcessTree(
      pid,
      force,
      spawnProcess,
      windowsSystemExecutable(windowsSystemRoot, "taskkill.exe"),
      waitMs,
    );
    if (treeTerminated) {
      // taskkill confirms that it issued termination for the owned tree, but
      // Windows can keep the direct child's executable image locked until the
      // ChildProcess has emitted close. Do not let callers release temporary
      // executables or other owned resources before that handle is closed.
      return await confirmWindowsChildResourcesClosed(
        waitForObservedDirectChildClose,
        waitMs,
      );
    }
    killDirectChild(child, force);
    // Direct-child fallback cannot prove that taskkill's unobserved
    // descendants stopped, even if the child releases its handles.
    await confirmWindowsChildResourcesClosed(
      waitForObservedDirectChildClose,
      waitMs,
    );
    return false;
  }

  // Once Node has observed both root exit and complete stdio closure, the
  // numeric PID/PGID is no longer an ownership capability. It may already
  // identify an unrelated recycled process group. Callers that must clean up
  // descendants therefore start their memoized owned termination before
  // closing/reaping the provider and await that original attempt afterward.
  if (directChildResourcesAreClosed(child)) {
    // A no-signal existence probe can still prove that the owned group is
    // already gone. Never signal a group after this point: an extant numeric
    // PGID may have been recycled and therefore remains unconfirmed.
    try {
      killProcess(-pid, 0);
      return false;
    } catch (error) {
      // `ESRCH` is the only proof that the group no longer exists. `EPERM`
      // still means an extant group, and unexpected probe failures must remain
      // unconfirmed rather than releasing ownership unsafely.
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
  const waitForObservedDirectChildClose = observeDirectChildClose(child);

  if (requestRuntimeOwnedGuardianStop(child)) {
    const childClosed = await waitForObservedDirectChildClose(waitMs);
    if (!childClosed) return false;
    const ownershipDeadline = Date.now() + waitMs;
    while (!confirmRuntimeOwnedProcessStopped(child)) {
      const remainingMs = ownershipDeadline - Date.now();
      if (remainingMs <= 0) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(PROCESS_GROUP_POLL_MS, remainingMs));
      });
    }
    return true;
  }

  if (force) {
    const descendants = forceKillPosixProcessTree(pid, {
      kill: killProcess,
      spawnProcessSync,
      rootProcessGroup: true,
    });
    const [groupExited, descendantsExited, childClosed] = await Promise.all([
      waitForPosixProcessGroupExit(pid, killProcess, waitMs),
      waitForPosixProcessesExit(descendants, killProcess, waitMs),
      waitForObservedDirectChildClose(waitMs),
    ]);
    return groupExited && descendantsExited && childClosed;
  }
  try {
    killProcess(-pid, "SIGTERM");
    const [groupExited, childClosed] = await Promise.all([
      waitForPosixProcessGroupExit(pid, killProcess, waitMs),
      waitForObservedDirectChildClose(waitMs),
    ]);
    return groupExited && childClosed;
  } catch {
    killDirectChild(child, false);
    return await waitForObservedDirectChildClose(waitMs);
  }
}
