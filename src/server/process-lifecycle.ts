import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { win32 } from "node:path";
import { recordWindowsCleanupFailure, windowsCleanupElapsedMs } from "./windows-cleanup-diagnostics";
import {
  posixCleanupDiagnostic,
  type PosixCleanupDiagnostic,
  type PosixCleanupFailure,
  type PosixCleanupFailureReason,
} from "./posix-cleanup-diagnostics";
import type { WindowsCleanupFailure } from "../shared/lifecycle-diagnostics";

import {
  forceKillPosixProcessTreeWithStatus,
  type PosixProcessTreeKillResult,
} from "../node/posix-process-tree";
import {
  linuxProcessCanExecute,
  linuxProcessGroupCanExecute,
} from "../node/runtime-owned-process-posix";
import {
  awaitRuntimeOwnedProcessStopped,
  confirmRuntimeOwnedProcessStopped,
  requestRuntimeOwnedGuardianStop,
  runtimeOwnedProcessStopConfirmation,
} from "../node/runtime-owned-processes";

const DEFAULT_TERMINATION_WAIT_MS = 2_000;
// The native macOS guardian owns a five-second bounded tree-drain proof; keep
// the caller alive for that complete proof inside the runtime shutdown budget.
const DARWIN_TERMINATION_WAIT_MS = 5_000;
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
  pauseSync?: (ms: number) => void;
  waitMs?: number;
  processCanExecute?: (pid: number) => boolean | null;
  processGroupCanExecute?: (processGroupId: number) => boolean | null;
  onPosixCleanupFailure?: (failure: PosixCleanupFailure) => void;
}

export type WaitForProcessExit = (waitMs: number) => Promise<boolean>;

export type ProcessTreeTerminator = (
  child: ChildProcess,
  force: boolean,
) => Promise<boolean>;

export type OwnedProcessTreeTermination = (
  force: boolean,
) => Promise<void>;

export interface OwnedPidProcessTreeTermination {
  (): Promise<boolean>;
  readonly posixCleanupFailure?: PosixCleanupFailure | null;
}

interface ProcessTreeTerminationErrorOptions extends ErrorOptions {
  priorError?: unknown;
  posixCleanupDiagnostic?: PosixCleanupDiagnostic | null;
}

export class ProcessTreeTerminationError extends Error {
  readonly code = "process-tree-termination-unconfirmed";
  readonly posixCleanupDiagnostic: PosixCleanupDiagnostic | null;

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
    this.posixCleanupDiagnostic = options?.posixCleanupDiagnostic ?? null;
  }
}

const latestPosixCleanupDiagnostics = new WeakMap<ChildProcess, PosixCleanupDiagnostic>();

export function posixCleanupDiagnosticFor(
  child: ChildProcess,
): PosixCleanupDiagnostic | null {
  return latestPosixCleanupDiagnostics.get(child) ?? null;
}

export function posixCleanupDiagnosticOf(error: unknown): PosixCleanupDiagnostic | null {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null || visited.has(current)) return null;
    visited.add(current);
    if (current instanceof ProcessTreeTerminationError && current.posixCleanupDiagnostic) {
      return current.posixCleanupDiagnostic;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return null;
}

export function recordingProcessTreeTermination(
  terminate: ProcessTreeTerminator,
  diagnostics: PosixCleanupDiagnostic[],
): ProcessTreeTerminator {
  const record = (child: ChildProcess): void => {
    const diagnostic = posixCleanupDiagnosticFor(child);
    if (diagnostic) diagnostics.push(diagnostic);
  };
  return async (child, force) => {
    try {
      const confirmed = await terminate(child, force);
      if (!confirmed) record(child);
      return confirmed;
    } catch (error) {
      record(child);
      throw error;
    }
  };
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
    throw new ProcessTreeTerminationError(subject, {
      cause,
      posixCleanupDiagnostic: posixCleanupDiagnosticFor(child),
    });
  }
  if (!confirmed) {
    throw new ProcessTreeTerminationError(subject, {
      posixCleanupDiagnostic: posixCleanupDiagnosticFor(child),
    });
  }
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
      const startedAt = performance.now();
      const confirmOwnership = (): boolean => {
        try {
          if (confirmRuntimeOwnedProcessStopped(child)) return true;
        } catch (error) {
          if (process.platform === "win32") recordWindowsCleanupFailure({
            phase: "ownership-retirement", scope: "child", force: forceRequested,
            elapsedMs: windowsCleanupElapsedMs(startedAt), exitCode: null,
          });
          throw error;
        }
        if (process.platform === "win32") recordWindowsCleanupFailure({
          phase: "ownership-retirement", scope: "child", force: forceRequested,
          elapsedMs: windowsCleanupElapsedMs(startedAt), exitCode: null,
        });
        return false;
      };
      if (!forceRequested) {
        try {
          if (await terminate(child, false)) {
            if (!confirmOwnership()) {
              throw new ProcessTreeTerminationError(subject);
            }
            return;
          }
        } catch {
          // The final force attempt below owns the authoritative result.
        }
      }
      await requireProcessTreeTermination(terminate, child, true, subject);
      if (!confirmOwnership()) {
        throw new ProcessTreeTerminationError(subject);
      }
    })();
    return termination;
  };
}

function confirmedBefore(
  confirmation: Promise<boolean>,
  deadlineAt: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, deadlineAt - Date.now()));
    void confirmation.then(
      (confirmed) => {
        clearTimeout(timer);
        resolve(confirmed);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function killDirectChild(child: ChildProcess, force: boolean): boolean {
  try {
    return child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    return false;
  }
}

interface WindowsTerminationSequence {
  readonly deadlineAt: number;
  forcedTerminated: boolean;
  fallbackReached: boolean;
  settle: Promise<void> | null;
}

const windowsTerminationSequences = new WeakMap<
  ChildProcess,
  WindowsTerminationSequence
>();

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

function boundedWaitMs(
  value: number | undefined,
  platform: NodeJS.Platform,
): number {
  if (value === undefined) {
    return platform === "darwin"
      ? DARWIN_TERMINATION_WAIT_MS
      : DEFAULT_TERMINATION_WAIT_MS;
  }
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
    if (waitMs <= 0) return Promise.resolve(false);
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

function windowsTerminationSequence(
  child: ChildProcess,
  waitMs: number,
): WindowsTerminationSequence {
  const sequence = windowsTerminationSequences.get(child) ?? {
    deadlineAt: Date.now() + 2 * waitMs + WINDOWS_RESOURCE_SETTLE_MS,
    forcedTerminated: false,
    fallbackReached: false,
    settle: null,
  };
  windowsTerminationSequences.set(child, sequence);
  return sequence;
}

async function confirmClosedWindowsTermination(
  sequence: WindowsTerminationSequence,
  withinDeadline: boolean,
): Promise<boolean> {
  if (sequence.fallbackReached) return false;
  if (!sequence.settle) {
    if (
      withinDeadline
      && sequence.deadlineAt - Date.now() < WINDOWS_RESOURCE_SETTLE_MS
    ) return false;
    sequence.settle = new Promise<void>((resolve) => {
      setTimeout(resolve, WINDOWS_RESOURCE_SETTLE_MS);
    });
  }
  await sequence.settle;
  return true;
}

function waitForPosixProcessGroupExit(
  pid: number,
  killProcess: typeof process.kill,
  waitMs: number,
  processGroupCanExecute:
    ((processGroupId: number) => boolean | null) | null = null,
  resignalWhile: () => boolean = () => false,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  const killGroup = (): boolean => {
    try {
      return killProcess(-pid, "SIGKILL");
    } catch {
      return false;
    }
  };
  return new Promise<boolean>((resolve) => {
    const inspect = (): void => {
      if (resignalWhile()) killGroup();
      try {
        killProcess(-pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          resolve(true);
          return;
        }
      }
      if (processGroupCanExecute?.(pid) === false) {
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
  processCanExecute: ((pid: number) => boolean | null) | null = null,
): Promise<boolean> {
  const remaining = new Set(pids);
  const deadline = Date.now() + waitMs;
  return new Promise<boolean>((resolve) => {
    const inspect = (): void => {
      for (const pid of remaining) {
        if (processCanExecute?.(pid) === false) {
          remaining.delete(pid);
          continue;
        }
        try {
          killProcess(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
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

type PosixTreeEnumeration = "root-authorized" | "root-gone" | "incomplete";

interface PosixTreeTerminationEvidence {
  readonly enumeration: PosixTreeEnumeration;
  readonly groupExited: boolean;
  readonly descendantsExited: boolean;
  readonly rootExited: boolean;
}

function posixTreeEnumeration(
  killed: PosixProcessTreeKillResult,
  rootGoneAccepted: boolean,
): PosixTreeEnumeration {
  if (killed.snapshotConfirmed && killed.rootState === "stopped") {
    return "root-authorized";
  }
  const rootAbsenceObserved = killed.rootStop === "absent"
    || (
      (killed.rootState === "absent" || killed.rootState === "zombie")
      && !killed.rootRunningObserved
    );
  return rootGoneAccepted && rootAbsenceObserved ? "root-gone" : "incomplete";
}

function posixTreeTerminationConfirmed(
  evidence: PosixTreeTerminationEvidence,
): boolean {
  return evidence.enumeration !== "incomplete"
    && evidence.groupExited
    && evidence.descendantsExited
    && evidence.rootExited;
}

function posixCleanupFailure(
  scope: "child" | "pid",
  reason: PosixCleanupFailureReason,
  killed: PosixProcessTreeKillResult | null,
  evidence: PosixTreeTerminationEvidence | null,
): PosixCleanupFailure {
  return {
    scope,
    reason,
    rootStop: killed?.rootStop ?? null,
    rootState: killed?.rootState ?? null,
    rootRunningObserved: killed?.rootRunningObserved ?? null,
    scanStabilized: killed?.scanStabilized ?? null,
    groupExited: evidence?.groupExited ?? null,
    descendantsExited: evidence?.descendantsExited ?? null,
    rootExited: evidence?.rootExited ?? null,
  };
}

function reportPosixTreeTermination(
  report: (failure: PosixCleanupFailure) => void,
  scope: "child" | "pid",
  reason: PosixCleanupFailureReason,
  killed: PosixProcessTreeKillResult | null,
  evidence: PosixTreeTerminationEvidence | null,
): boolean {
  const confirmed = evidence !== null && posixTreeTerminationConfirmed(evidence);
  if (!confirmed) report(posixCleanupFailure(scope, reason, killed, evidence));
  return confirmed;
}

function nativePosixProcessObserver(
  platform: NodeJS.Platform,
  dependencies: AwaitableProcessLifecycleDependencies,
): ((pid: number) => boolean | null) | null {
  if (dependencies.processCanExecute) return dependencies.processCanExecute;
  return platform === "linux"
    && dependencies.platform === undefined
    && dependencies.killProcess === undefined
    ? linuxProcessCanExecute
    : null;
}

function nativePosixProcessGroupObserver(
  platform: NodeJS.Platform,
  dependencies: AwaitableProcessLifecycleDependencies,
): ((processGroupId: number) => boolean | null) | null {
  if (dependencies.processGroupCanExecute) {
    return dependencies.processGroupCanExecute;
  }
  return platform === "linux"
    && dependencies.platform === undefined
    && dependencies.killProcess === undefined
    ? linuxProcessGroupCanExecute
    : null;
}

function terminateWindowsProcessTree(
  pid: number,
  force: boolean,
  spawnProcess: typeof spawn,
  taskkillExecutable: string,
  waitMs: number,
  scope: WindowsCleanupFailure["scope"],
): Promise<boolean> {
  const startedAt = performance.now();
  // Inspect only a bounded prefix of trusted taskkill output. Persist the
  // fixed classification alone; localized/unrecognized text remains "other".
  let output = "";
  let remainingOutputBytes = 4_096;
  const onOutput = (chunk: Buffer | string): void => {
    if (remainingOutputBytes === 0) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const retained = bytes.subarray(0, remainingOutputBytes);
    remainingOutputBytes -= retained.length;
    output += retained.toString("utf8");
  };
  const classifyOutput = (): WindowsCleanupFailure["outputClassification"] => {
    if (!output) return "unavailable";
    if (/^(?:ERROR|Reason): Access is denied\.\s*$/imu.test(output)) {
      return "access-denied";
    }
    if (/^ERROR: The process "\d+" not found\.\s*$/imu.test(output)
      || /^Reason: There is no running instance of the task\.\s*$/imu.test(output)) {
      return "not-found";
    }
    return "other";
  };
  const record = (phase: WindowsCleanupFailure["phase"], exitCode: number | null = null): void => {
    recordWindowsCleanupFailure({ phase, scope, force, exitCode,
      elapsedMs: windowsCleanupElapsedMs(startedAt),
      ...(phase === "taskkill-exit" ? { outputClassification: classifyOutput() } : {}),
    });
  };
  return new Promise<boolean>((resolve) => {
    let taskkill: ReturnType<typeof spawn>;
    try {
      taskkill = spawnProcess(
        taskkillExecutable,
        ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])],
        {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      record("taskkill-spawn");
      resolve(false);
      return;
    }
    taskkill.stdout?.on("data", onOutput);
    taskkill.stderr?.on("data", onOutput);
    let settled = false;
    const finish = (terminated: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      taskkill.off("error", onError);
      taskkill.off("close", onClose);
      output = "";
      remainingOutputBytes = 0;
      resolve(terminated);
    };
    const onError = (): void => { record("taskkill-error"); finish(false); };
    const onClose = (code: number | null): void => {
      if (code !== 0) record("taskkill-exit", code);
      finish(code === 0);
    };
    const timer = setTimeout(() => {
      record("taskkill-timeout");
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
  const waitMs = boundedWaitMs(dependencies.waitMs, platform);
  const processCanExecute = nativePosixProcessObserver(platform, dependencies);
  const processGroupCanExecute = nativePosixProcessGroupObserver(
    platform,
    dependencies,
  );
  let started = false;
  let treeTerminationConfirmed = false;
  let enumeration: PosixTreeEnumeration = "incomplete";
  let observation: PosixProcessTreeKillResult | null = null;
  let descendants: readonly number[] = [];
  const state: { posixCleanupFailure: PosixCleanupFailure | null } = {
    posixCleanupFailure: null,
  };
  const report = (failure: PosixCleanupFailure): void => {
    state.posixCleanupFailure = failure;
    dependencies.onPosixCleanupFailure?.(failure);
  };
  const unconfirmed = (reason: PosixCleanupFailureReason): false => {
    report(posixCleanupFailure("pid", reason, observation, null));
    return false;
  };

  const terminate = async (): Promise<boolean> => {
    state.posixCleanupFailure = null;
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      return platform === "win32" ? false : unconfirmed("invalid-pid");
    }
    const deadlineAt = Date.now() + waitMs;
    const startedAt = performance.now();

    if (platform === "win32") {
      if (!started) {
        started = true;
        treeTerminationConfirmed = await terminateWindowsProcessTree(
          pid,
          true,
          spawnProcess,
          windowsSystemExecutable(windowsSystemRoot, "taskkill.exe"),
          waitMs,
          "pid",
        );
      }
      if (!treeTerminationConfirmed) return false;
      const rootExitWaitMs = Math.trunc(
        deadlineAt - Date.now() - WINDOWS_RESOURCE_SETTLE_MS,
      );
      if (rootExitWaitMs <= 0 || !await waitForRootExit(rootExitWaitMs)) {
        recordWindowsCleanupFailure({ phase: "root-close", scope: "pid", force: true,
          elapsedMs: windowsCleanupElapsedMs(startedAt), exitCode: null });
        return false;
      }
      const settleMs = Math.min(
        WINDOWS_RESOURCE_SETTLE_MS,
        Math.max(0, deadlineAt - Date.now()),
      );
      if (settleMs <= 0) {
        recordWindowsCleanupFailure({ phase: "resource-settle", scope: "pid", force: true,
          elapsedMs: windowsCleanupElapsedMs(startedAt), exitCode: null });
        return false;
      }
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
        pause: dependencies.pauseSync,
        platform,
      });
      enumeration = posixTreeEnumeration(killed, false);
      observation = killed;
      descendants = killed.descendants;
    }
    if (enumeration === "incomplete") return unconfirmed("incomplete-scan");
    const exitWaitMs = Math.trunc(deadlineAt - Date.now());
    if (exitWaitMs <= 0) return unconfirmed("no-exit-budget");
    const [groupExited, descendantsExited, rootExited] = await Promise.all([
      waitForPosixProcessGroupExit(
        pid,
        killProcess,
        exitWaitMs,
        processGroupCanExecute,
      ),
      waitForPosixProcessesExit(
        descendants,
        killProcess,
        exitWaitMs,
        processCanExecute,
      ),
      waitForRootExit(exitWaitMs),
    ]);
    return reportPosixTreeTermination(report, "pid", "exit-unconfirmed", observation, {
      enumeration, groupExited, descendantsExited, rootExited,
    });
  };
  return Object.defineProperty(terminate, "posixCleanupFailure", {
    get: () => state.posixCleanupFailure,
  }) as OwnedPidProcessTreeTermination;
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
  const platform = dependencies.platform ?? process.platform;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const spawnProcessSync = dependencies.spawnProcessSync ?? spawnSync;
  const killProcess = dependencies.killProcess ?? process.kill;
  const windowsSystemRoot = dependencies.windowsSystemRoot === undefined
    ? inheritedWindowsSystemRoot()
    : dependencies.windowsSystemRoot;
  const waitMs = boundedWaitMs(dependencies.waitMs, platform);
  const startedAt = performance.now();
  let killed: PosixProcessTreeKillResult | null = null;
  latestPosixCleanupDiagnostics.delete(child);
  const report = (failure: PosixCleanupFailure): void => {
    latestPosixCleanupDiagnostics.set(
      child,
      posixCleanupDiagnostic(failure, killed, performance.now() - startedAt),
    );
    dependencies.onPosixCleanupFailure?.(failure);
  };
  const reported = (
    confirmed: boolean,
    reason: PosixCleanupFailureReason,
    evidence: PosixTreeTerminationEvidence | null = null,
  ): boolean => {
    if (!confirmed && platform !== "win32") {
      report(posixCleanupFailure("child", reason, null, evidence));
    }
    return confirmed;
  };
  if (!pid) {
    return reported(await confirmedBefore(
      awaitRuntimeOwnedProcessStopped(child),
      Date.now() + waitMs,
    ), "owned-stop-unconfirmed");
  }
  const processCanExecute = nativePosixProcessObserver(platform, dependencies);
  const processGroupCanExecute = nativePosixProcessGroupObserver(
    platform,
    dependencies,
  );

  if (platform === "win32") {
    // Never target a reused Windows PID after Node has already observed the
    // complete owned child close.
    const sequence = windowsTerminationSequence(child, waitMs);
    if (directChildResourcesAreClosed(child)) {
      return await confirmClosedWindowsTermination(sequence, false);
    }
    const waitForObservedDirectChildClose = observeDirectChildClose(child);
    const startedAt = performance.now();
    const closeDeadlineAt = sequence.deadlineAt - WINDOWS_RESOURCE_SETTLE_MS;
    const gracefulDeadlineAt = closeDeadlineAt - waitMs;
    const taskkill = async (
      forced: boolean,
      phaseDeadlineAt: number,
    ): Promise<boolean | null> => {
      const remainingMs = Math.min(waitMs, phaseDeadlineAt - Date.now());
      if (remainingMs <= 0) return null;
      return await terminateWindowsProcessTree(
        pid,
        forced,
        spawnProcess,
        windowsSystemExecutable(windowsSystemRoot, "taskkill.exe"),
        remainingMs,
        "child",
      );
    };
    let gracefulAccepted = false;
    if (!sequence.forcedTerminated && !sequence.fallbackReached) {
      if (force) {
        sequence.forcedTerminated = await taskkill(true, closeDeadlineAt) === true;
      } else if (await taskkill(false, gracefulDeadlineAt) === true) {
        gracefulAccepted = true;
      } else if (child.exitCode === null && child.signalCode === null) {
        const escalated = await taskkill(true, closeDeadlineAt);
        if (escalated === null) return false;
        sequence.forcedTerminated = escalated;
      }
    }
    if (sequence.forcedTerminated || gracefulAccepted) {
      // taskkill confirms that it issued termination for the owned tree, but
      // Windows can keep the direct child's executable image locked until the
      // ChildProcess has emitted close. Do not let callers release temporary
      // executables or other owned resources before that handle is closed.
      const closeDeadline = sequence.forcedTerminated
        ? closeDeadlineAt
        : gracefulDeadlineAt;
      if (!await waitForObservedDirectChildClose(closeDeadline - Date.now())) {
        recordWindowsCleanupFailure({ phase: "root-close", scope: "child", force,
          elapsedMs: windowsCleanupElapsedMs(startedAt), exitCode: null });
        return false;
      }
      const confirmed = await confirmClosedWindowsTermination(sequence, true);
      if (!confirmed) recordWindowsCleanupFailure({ phase: "resource-settle", scope: "child", force,
        elapsedMs: windowsCleanupElapsedMs(startedAt), exitCode: null });
      return confirmed;
    }
    sequence.fallbackReached = true;
    killDirectChild(child, force);
    // Direct-child fallback cannot prove that taskkill's unobserved
    // descendants stopped, even if the child releases its handles.
    await waitForObservedDirectChildClose(closeDeadlineAt - Date.now());
    return false;
  }

  // Once Node has observed both root exit and complete stdio closure, the
  // numeric PID/PGID is no longer an ownership capability. It may already
  // identify an unrelated recycled process group. Callers that must clean up
  // descendants therefore start their memoized owned termination before
  // closing/reaping the provider and await that original attempt afterward.
  if (directChildResourcesAreClosed(child)) {
    const ownedStopConfirmation = runtimeOwnedProcessStopConfirmation(child);
    if (ownedStopConfirmation !== null) {
      // A released runtime-owned claim is an exact, durable cleanup receipt.
      // Conversely, map presence without release must stay fail-closed; never
      // reinterpret the now-reapable numeric PGID as ownership evidence.
      return reported(
        ownedStopConfirmation || await awaitRuntimeOwnedProcessStopped(child),
        "owned-stop-unconfirmed",
      );
    }
    // A no-signal existence probe can still prove that the owned group is
    // already gone for an untracked child. Never signal a group after this
    // point: an extant numeric PGID may have been recycled.
    let groupExited: boolean;
    try {
      killProcess(-pid, 0);
      groupExited = processGroupCanExecute?.(pid) === false;
    } catch (error) {
      // `ESRCH` is the only proof that the group no longer exists. `EPERM`
      // still means an extant group, and unexpected probe failures must remain
      // unconfirmed rather than releasing ownership unsafely.
      groupExited = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    const evidence: PosixTreeTerminationEvidence = {
      enumeration: "root-gone", groupExited,
      descendantsExited: true, rootExited: true,
    };
    return reported(
      posixTreeTerminationConfirmed(evidence),
      "closed-unconfirmed",
      evidence,
    );
  }
  const waitForObservedDirectChildClose = observeDirectChildClose(child);
  const deadlineAt = Date.now() + waitMs;
  const remainingMs = (): number => deadlineAt - Date.now();

  const guardianStopBarrier = requestRuntimeOwnedGuardianStop(child);
  if (guardianStopBarrier) {
    // A failed exact signal can race the guardian's ordinary close. The
    // durable claim, not the helper's boolean, is authoritative: keep the
    // entire bounded close/retirement proof, and never fall through to a raw
    // PID/PGID signal while this guardian owns the request.
    await guardianStopBarrier;
    const childClosed = await waitForObservedDirectChildClose(waitMs);
    if (!childClosed) return reported(false, "owned-stop-unconfirmed");
    const ownershipDeadline = Date.now() + waitMs;
    while (!confirmRuntimeOwnedProcessStopped(child)) {
      const remainingMs = ownershipDeadline - Date.now();
      if (remainingMs <= 0) return reported(false, "owned-stop-unconfirmed");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(PROCESS_GROUP_POLL_MS, remainingMs));
      });
    }
    return true;
  }

  const leaderUnreaped = (): boolean =>
    child.exitCode === null && child.signalCode === null;
  if (force) {
    const leaderSignalable = leaderUnreaped();
    killed = leaderSignalable
      ? forceKillPosixProcessTreeWithStatus(pid, {
        kill: killProcess,
        spawnProcessSync,
        rootProcessGroup: true,
        deadlineAt,
        pause: dependencies.pauseSync,
        platform,
      })
      : {
        descendants: [],
        snapshotConfirmed: false,
        scanStabilized: false,
        rootStop: "absent",
        rootState: "absent",
        rootRunningObserved: false,
        snapshotReads: 0,
        snapshotTimeouts: 0,
      };
    const enumeration = posixTreeEnumeration(killed, true);
    const { descendants } = killed;
    const exitWaitMs = remainingMs();
    const [groupExited, descendantsExited, childClosed] = await Promise.all([
      waitForPosixProcessGroupExit(
        pid,
        killProcess,
        exitWaitMs,
        processGroupCanExecute,
        leaderUnreaped,
      ),
      waitForPosixProcessesExit(
        descendants,
        killProcess,
        exitWaitMs,
        processCanExecute,
      ),
      waitForObservedDirectChildClose(exitWaitMs),
    ]);
    return reportPosixTreeTermination(report, "child", "exit-unconfirmed", killed, {
      enumeration, groupExited, descendantsExited, rootExited: childClosed,
    });
  }
  try {
    if (leaderUnreaped()) killProcess(-pid, "SIGTERM");
    const exitWaitMs = remainingMs();
    const [groupExited, childClosed] = await Promise.all([
      waitForPosixProcessGroupExit(
        pid,
        killProcess,
        exitWaitMs,
        processGroupCanExecute,
      ),
      waitForObservedDirectChildClose(exitWaitMs),
    ]);
    const evidence: PosixTreeTerminationEvidence = {
      enumeration: "root-gone", groupExited,
      descendantsExited: true, rootExited: childClosed,
    };
    return reported(
      posixTreeTerminationConfirmed(evidence),
      "graceful-unconfirmed",
      evidence,
    );
  } catch (error) {
    killDirectChild(child, false);
    const groupExited = (error as NodeJS.ErrnoException).code === "ESRCH"
      || processGroupCanExecute?.(pid) === false;
    const childClosed = await waitForObservedDirectChildClose(remainingMs());
    const evidence: PosixTreeTerminationEvidence = {
      enumeration: "root-gone", groupExited,
      descendantsExited: true, rootExited: childClosed,
    };
    return reported(
      posixTreeTerminationConfirmed(evidence),
      "graceful-unconfirmed",
      evidence,
    );
  }
}
