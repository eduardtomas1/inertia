import { spawn, spawnSync } from "node:child_process";
import { win32 } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 2_000;
const PROCESS_TABLE_TIMEOUT_MS = 500;
const PROCESS_TABLE_OUTPUT_LIMIT = 1024 * 1024;
const PROCESS_GROUP_DISCOVERY_PASSES = 3;
const POSIX_OWNERSHIP_TOKEN_PASSES = 3;
const POSIX_OWNERSHIP_RECOVERY_PASSES = 3;
const POSIX_OWNERSHIP_RECOVERY_DELAY_MS = 25;
const POSIX_START_MARKER = "inertia-native-probe-start\n";
const POSIX_LSOF_PATH = process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";

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

function readLsofRecords(args) {
  const result = spawnSync(
    POSIX_LSOF_PATH,
    [
      "-n",
      "-P",
      ...(process.platform === "linux" ? ["-E"] : []),
      ...args,
      "-F",
      "pfdin",
    ],
    {
      encoding: "utf8",
      env: {},
      maxBuffer: PROCESS_TABLE_OUTPUT_LIMIT,
      shell: false,
      timeout: PROCESS_TABLE_TIMEOUT_MS,
    },
  );
  if (result.error || result.status !== 0) return null;
  return parseLsofRecords(result.stdout);
}

export function parseLsofRecords(output) {
  if (
    typeof output !== "string"
    || Buffer.byteLength(output) > PROCESS_TABLE_OUTPUT_LIMIT
  ) return null;
  const records = [];
  let pid = 0;
  let device = "";
  let inode = "";
  for (const line of output.split("\n")) {
    const field = line.slice(0, 1);
    const value = line.slice(1);
    if (field === "p") pid = Number(value);
    else if (field === "f") {
      device = "";
      inode = "";
    } else if (field === "d") device = value;
    else if (field === "i") inode = value;
    else if (field === "n" && Number.isSafeInteger(pid) && pid > 1) {
      records.push({ device, inode, name: value, pid });
    }
  }
  return records;
}

export function lsofPipeIdentity({ device, inode, name }, platform = process.platform) {
  if (platform === "linux" && name.startsWith("type=STREAM")) {
    const peer = /^type=STREAM ->INO=(\d+)(?:\s|$)/u.exec(name)?.[1];
    if (!inode || !peer) return null;
    return `socket:${[inode, peer].sort().join(":")}`;
  }
  if (inode) return `inode:${device}:${inode}`;
  if (!device || !name.startsWith("->")) return null;
  return `endpoints:${[device, name.slice(2)].sort().join(":")}`;
}

function lsofPipePeerPid({ name }, platform = process.platform) {
  if (platform !== "linux") return null;
  const peerPid = Number(/^type=STREAM ->INO=\d+\s+(\d+),/u.exec(name)?.[1]);
  return Number.isSafeInteger(peerPid) && peerPid > 1 ? peerPid : null;
}

function childPipeDescriptor(stream) {
  const descriptor = stream?._handle?.fd;
  return Number.isSafeInteger(descriptor) && descriptor >= 0 ? descriptor : null;
}

export function readPosixProbePipeIdentities(
  child,
  readRecords = readLsofRecords,
  platform = process.platform,
) {
  const descriptors = [
    childPipeDescriptor(child.stdout),
    childPipeDescriptor(child.stderr),
  ];
  if (descriptors.some((descriptor) => descriptor === null)) return null;
  for (let pass = 0; pass < POSIX_OWNERSHIP_TOKEN_PASSES; pass += 1) {
    const records = readRecords([
      "-a",
      "-p", String(process.pid),
      "-d", descriptors.join(","),
    ]);
    if (!records) continue;
    const identities = new Set(
      records.map((record) => lsofPipeIdentity(record, platform)).filter(Boolean),
    );
    if (identities.size !== descriptors.length) continue;
    return {
      identities,
      ownerPids: new Set(records.map((record) => lsofPipePeerPid(record, platform)).filter(Boolean)),
    };
  }
  return null;
}

function readPosixProbePipeOwners(pipeIdentities) {
  const userId = process.getuid?.();
  if (!Number.isSafeInteger(userId) || userId < 0) return null;
  const records = readLsofRecords([
    "-a",
    "-u", String(userId),
    "-d", "1,2",
  ]);
  if (!records) return null;
  return new Set(
    records
      .filter((record) => pipeIdentities.has(lsofPipeIdentity(record)))
      .map(({ pid }) => pid),
  );
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

export function createPosixProcessTracker(rootPid, child, dependencies = {}) {
  // The parent-side pipe handles outlive the provider root. Their kernel
  // identities therefore provide an ownership token for a detached child that
  // inherits stdout or stderr and reparents before any process-table snapshot.
  const readPipeToken = dependencies.readPipeToken ?? readPosixProbePipeIdentities;
  const readPipeOwners = dependencies.readPipeOwners ?? readPosixProbePipeOwners;
  const readProcesses = dependencies.readProcesses ?? readPosixProcessTable;
  let pipeToken = readPipeToken(child);
  const ownedPids = new Set([rootPid]);
  const applyPipeToken = () => {
    for (const ownerPid of pipeToken?.ownerPids ?? []) ownedPids.add(ownerPid);
  };
  applyPipeToken();
  const recover = () => {
    if (!pipeToken) {
      pipeToken = readPipeToken(child);
      applyPipeToken();
    }
    return pipeToken !== null;
  };
  const refresh = () => {
    if (!recover()) return null;
    const pipeOwners = readPipeOwners(pipeToken.identities);
    if (!pipeOwners) return null;
    for (const pipeOwner of pipeOwners) ownedPids.add(pipeOwner);
    const processes = readProcesses();
    if (processes) extendPosixOwnership(ownedPids, processes);
    return processes ? { pipeOwners, processes } : null;
  };
  return {
    get confirmed() { return pipeToken !== null; },
    dispose() {},
    ownedPids,
    recover,
    refresh,
  };
}

function forceTerminatePosixProcessTree(pid, tracker) {
  // Freeze every process group whose leader is owned by this probe. The probe
  // pipe identities recover an inherited, pipe-holding descendant even when
  // its root exited and it reparented before cleanup began.
  const ownedPids = tracker?.ownedPids ?? new Set([pid]);
  const ownedGroups = new Set();
  const individualPids = new Set();
  const ownershipSnapshot = tracker?.refresh();
  let completeTreeSignaled = tracker === null || ownershipSnapshot !== null;
  for (const pipeOwner of ownershipSnapshot?.pipeOwners ?? []) {
    individualPids.add(pipeOwner);
    completeTreeSignaled = signalProcess(pipeOwner, "SIGSTOP") && completeTreeSignaled;
  }
  let discoveryStable = false;
  for (let pass = 0; pass < PROCESS_GROUP_DISCOVERY_PASSES; pass += 1) {
    const processes = pass === 0 && ownershipSnapshot
      ? ownershipSnapshot.processes
      : readPosixProcessTable();
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
  return probeNativeExecutableWithDependencies(command, args, options);
}

export function probeNativeExecutableWithDependencies(
  command,
  args,
  options = {},
  dependencies = {},
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  return new Promise((resolveProbe, rejectProbe) => {
    const startedAt = Date.now();
    const startAfterOwnership = process.platform !== "win32"
      && options.startAfterOwnership === true;
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      env: options.environment ?? {},
      shell: false,
      stdio: [startAfterOwnership ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const processTracker = process.platform === "win32" || !child.pid
      ? null
      : createPosixProcessTracker(child.pid, child, dependencies.processTracker);
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure;
    let settled = false;
    let cleanupTimer;
    let deadlineTimer;
    let ownershipRecoveryTimer;

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(cleanupTimer);
      clearTimeout(ownershipRecoveryTimer);
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
    child.stdin?.once("error", (error) => stopTree(error));
    child.once("error", (error) => settle(() => rejectProbe(error)));
    child.once("close", (status, signal) => {
      if (failure) {
        settle(() => rejectProbe(failure));
        return;
      }
      if (processTracker && !processTracker.confirmed) {
        forceTerminateProcessTree(child, processTracker);
        settle(() => rejectProbe(new Error(
          "The native executable exited with unconfirmed process ownership.",
        )));
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
    if (startAfterOwnership) {
      let recoveryPass = 0;
      const releaseStartGate = () => {
        if (failure || settled) return;
        if (processTracker?.recover()) {
          child.stdin.end(POSIX_START_MARKER);
          return;
        }
        if (recoveryPass >= POSIX_OWNERSHIP_RECOVERY_PASSES) {
          stopTree(new Error(
            "The native executable process ownership token could not be initialized.",
          ));
          return;
        }
        recoveryPass += 1;
        ownershipRecoveryTimer = setTimeout(
          releaseStartGate,
          POSIX_OWNERSHIP_RECOVERY_DELAY_MS,
        );
      };
      releaseStartGate();
    }
  });
}
