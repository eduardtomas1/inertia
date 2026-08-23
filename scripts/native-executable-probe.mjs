import { spawn, spawnSync } from "node:child_process";
import { win32 } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 2_000;
const PROCESS_TABLE_TIMEOUT_MS = 500;
const PROCESS_TABLE_OUTPUT_LIMIT = 1024 * 1024;
const PROCESS_GROUP_DISCOVERY_PASSES = 3;
const PROCESS_TRACKING_INTERVAL_MS = 25;

function inheritedWindowsSystemRoot(environment = process.env) {
  const entry = Object.entries(environment).find(([name]) =>
    ["systemroot", "windir"].includes(name.toLowerCase()));
  const candidate = entry?.[1]?.trim();
  return candidate && win32.isAbsolute(candidate) ? win32.normalize(candidate) : null;
}

function readPosixProcessTable() {
  const result = spawnSync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,pgid="],
    {
      encoding: "utf8",
      env: {},
      maxBuffer: PROCESS_TABLE_OUTPUT_LIMIT,
      shell: false,
      timeout: PROCESS_TABLE_TIMEOUT_MS,
    },
  );
  if (result.error || result.status !== 0) return null;
  const processes = [];
  for (const line of result.stdout.split("\n")) {
    const [pidText, parentPidText, groupPidText] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    const groupPid = Number(groupPidText);
    if ([pid, parentPid, groupPid].every(Number.isSafeInteger)) {
      processes.push({ groupPid, parentPid, pid });
    }
  }
  return processes;
}

function extendPosixOwnership(ownedPids, processes) {
  let added = true;
  while (added) {
    added = false;
    for (const processEntry of processes) {
      if (
        !ownedPids.has(processEntry.pid)
        && ownedPids.has(processEntry.parentPid)
      ) {
        ownedPids.add(processEntry.pid);
        added = true;
      }
    }
  }
  return processes.filter(({ pid }) => ownedPids.has(pid));
}

function signalProcess(target, signal, missingIsSuccess = true) {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    return missingIsSuccess
      && Boolean(error && typeof error === "object" && error.code === "ESRCH");
  }
}

function createPosixProcessTracker(rootPid) {
  const ownedPids = new Set([rootPid]);
  let disposed = false;
  const refresh = () => {
    if (disposed) return null;
    const processes = readPosixProcessTable();
    if (processes) extendPosixOwnership(ownedPids, processes);
    return processes;
  };
  refresh();
  const timer = setInterval(refresh, PROCESS_TRACKING_INTERVAL_MS);
  timer.unref();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
    ownedPids,
    refresh,
  };
}

function forceTerminatePosixProcessTree(pid, tracker) {
  // Freeze every process group whose leader has been observed as part of this
  // probe. Tracking begins while the root is alive, so ownership survives a
  // root that exits and reparents a pipe-holding descendant before timeout.
  const ownedPids = tracker?.ownedPids ?? new Set([pid]);
  tracker?.refresh();

  const ownedGroups = new Set();
  const individualPids = new Set();
  let completeTreeSignaled = true;
  let discoveryStable = false;
  for (let pass = 0; pass < PROCESS_GROUP_DISCOVERY_PASSES; pass += 1) {
    const processes = readPosixProcessTable();
    if (!processes) {
      completeTreeSignaled = false;
      break;
    }
    const previousOwnedPidCount = ownedPids.size;
    const descendants = extendPosixOwnership(ownedPids, processes);
    const newGroups = [...new Set(
      descendants
        .map(({ groupPid }) => groupPid)
        .filter((groupPid) => (
          groupPid > 1
          && ownedPids.has(groupPid)
          && !ownedGroups.has(groupPid)
        )),
    )];
    const newIndividuals = descendants
      .filter(({ groupPid, pid: descendantPid }) => (
        !ownedGroups.has(groupPid)
        && !newGroups.includes(groupPid)
        && !individualPids.has(descendantPid)
      ))
      .map(({ pid: descendantPid }) => descendantPid);
    if (
      ownedPids.size === previousOwnedPidCount
      && newGroups.length === 0
      && newIndividuals.length === 0
    ) {
      discoveryStable = true;
      break;
    }
    for (const groupPid of newGroups) {
      ownedGroups.add(groupPid);
      completeTreeSignaled = signalProcess(-groupPid, "SIGSTOP") && completeTreeSignaled;
    }
    for (const descendantPid of newIndividuals) {
      individualPids.add(descendantPid);
      completeTreeSignaled = signalProcess(descendantPid, "SIGSTOP") && completeTreeSignaled;
    }
  }
  completeTreeSignaled = discoveryStable && completeTreeSignaled;
  for (const groupPid of ownedGroups) {
    completeTreeSignaled = signalProcess(-groupPid, "SIGKILL") && completeTreeSignaled;
  }
  for (const descendantPid of individualPids) {
    completeTreeSignaled = signalProcess(descendantPid, "SIGKILL") && completeTreeSignaled;
  }
  completeTreeSignaled = signalProcess(-pid, "SIGKILL") && completeTreeSignaled;
  tracker?.dispose();
  return completeTreeSignaled;
}

function forceTerminateProcessTree(child, tracker) {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  if (process.platform === "win32") {
    const systemRoot = inheritedWindowsSystemRoot();
    if (systemRoot) {
      try {
        const result = spawnSync(
          win32.join(systemRoot, "System32", "taskkill.exe"),
          ["/pid", String(pid), "/t", "/f"],
          {
            env: { SystemRoot: systemRoot },
            shell: false,
            stdio: "ignore",
            timeout: CLEANUP_TIMEOUT_MS,
            windowsHide: true,
          },
        );
        if (!result.error && result.status === 0) return true;
      } catch {
        // The direct-child fallback below is intentionally not confirmation
        // that taskkill stopped every descendant.
      }
    }
  } else {
    return forceTerminatePosixProcessTree(pid, tracker);
  }
  try { child.kill("SIGKILL"); } catch { /* The direct child may already be gone. */ }
  return false;
}

export function probeNativeExecutable(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  return new Promise((resolveProbe, rejectProbe) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      env: options.environment ?? {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const processTracker = process.platform === "win32" || !child.pid
      ? null
      : createPosixProcessTracker(child.pid);
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure;
    let settled = false;
    let cleanupTimer;
    let deadlineTimer;

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(cleanupTimer);
      processTracker?.dispose();
      callback();
    };
    const stopTree = (error) => {
      if (failure || settled) return;
      failure = error;
      clearTimeout(deadlineTimer);
      const treeTerminationConfirmed = forceTerminateProcessTree(child, processTracker);
      if (!treeTerminationConfirmed) {
        failure = new Error(`${error.message} The provider process tree could not be confirmed stopped.`);
      }
      cleanupTimer = setTimeout(() => {
        settle(() => rejectProbe(new Error(
          `${failure.message} The provider process did not close within the cleanup deadline.`,
        )));
      }, CLEANUP_TIMEOUT_MS);
    };
    const capture = (stream) => (chunk) => {
      if (failure || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const previousOutputBytes = outputBytes;
      outputBytes += buffer.length;
      const remaining = Math.max(0, outputLimit - previousOutputBytes);
      if (remaining > 0) {
        const text = buffer.subarray(0, remaining).toString("utf8");
        if (stream === "stdout") stdout += text;
        else stderr += text;
      }
      if (outputBytes > outputLimit) {
        stopTree(new Error(`The native executable exceeded its ${outputLimit} byte output limit.`));
      }
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.once("error", (error) => settle(() => rejectProbe(error)));
    child.once("close", (status, signal) => {
      if (failure) {
        settle(() => rejectProbe(failure));
        return;
      }
      if (processTracker && processTracker.ownedPids.size > 1) {
        const treeTerminationConfirmed = forceTerminateProcessTree(child, processTracker);
        if (!treeTerminationConfirmed) {
          settle(() => rejectProbe(new Error(
            "The native executable exited with an unconfirmed descendant process tree.",
          )));
          return;
        }
      }
      settle(() => resolveProbe({ signal, status, stderr, stdout }));
    });
    deadlineTimer = setTimeout(() => {
      stopTree(new Error(`The native executable exceeded its ${timeoutMs}ms deadline.`));
    }, Math.max(0, timeoutMs - (Date.now() - startedAt)));
  });
}
