import { spawn, spawnSync } from "node:child_process";
import { opendirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join, win32 } from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 2_000;
const PROCESS_TABLE_TIMEOUT_MS = 500;
const LINUX_LSOF_TIMEOUT_MS = 1_000;
const PROCESS_TABLE_OUTPUT_LIMIT = 1024 * 1024;
const PROCESS_GROUP_DISCOVERY_PASSES = 3;
const LINUX_PROC_OWNER_SCAN_LIMIT = 32 * 1024;
const LINUX_PROC_OWNER_CANDIDATE_LIMIT = 128;
const LINUX_OWNERSHIP_SCAN_PASSES = 2;
const POSIX_OWNERSHIP_TOKEN_PASSES = 3;
const POSIX_OWNERSHIP_RECOVERY_PASSES = 3;
const POSIX_OWNERSHIP_RECOVERY_DELAY_MS = 25;
const POSIX_START_MARKER = "inertia-native-probe-start\n";
const POSIX_LSOF_PATH = process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
const LINUX_SS_PATH = "/usr/bin/ss";

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

function readLsofRecords(args, timeoutMs = PROCESS_TABLE_TIMEOUT_MS) {
  const result = spawnSync(
    POSIX_LSOF_PATH,
    [
      "-n",
      "-P",
      ...lsofPlatformArgs(),
      ...args,
      "-F",
      "pfdin",
    ],
    {
      encoding: "utf8",
      env: {},
      maxBuffer: PROCESS_TABLE_OUTPUT_LIMIT,
      shell: false,
      timeout: timeoutMs,
    },
  );
  if (result.error || result.status !== 0) return null;
  return parseLsofRecords(result.stdout);
}

export function lsofPlatformArgs(platform = process.platform) {
  if (platform === "linux") return ["-E"];
  // Darwin's descriptor-only mode avoids inspecting unrelated process
  // metadata during the all-user fd 1/2 ownership scan. That keeps the scan
  // within its existing bound even on a loaded native Intel runner.
  if (platform === "darwin") return ["-X"];
  return [];
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

export function parseLinuxSocketPairs(output) {
  if (
    typeof output !== "string"
    || Buffer.byteLength(output) > PROCESS_TABLE_OUTPUT_LIMIT
  ) return null;
  const identities = new Set();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (
      fields.length < 8
      || fields[0] !== "u_str"
      || fields[1] !== "ESTAB"
      || fields[4] !== "*"
      || fields[6] !== "*"
      || !/^\d+$/u.test(fields[5])
      || !/^\d+$/u.test(fields[7])
      || fields[5] === "0"
      || fields[7] === "0"
    ) continue;
    identities.add(`socket:${[fields[5], fields[7]].sort().join(":")}`);
  }
  return identities;
}

export function readLinuxSocketPairs(dependencies = {}) {
  const run = dependencies.run ?? spawnSync;
  let result;
  try {
    result = run(
      dependencies.command ?? LINUX_SS_PATH,
      ["-x", "-n", "-a", "-H", "-O"],
      {
        encoding: "utf8",
        env: {},
        maxBuffer: PROCESS_TABLE_OUTPUT_LIMIT,
        shell: false,
        timeout: PROCESS_TABLE_TIMEOUT_MS,
      },
    );
  } catch {
    return null;
  }
  if (result?.error || result?.status !== 0) return null;
  return parseLinuxSocketPairs(result.stdout);
}

function lsofPipePeerPid({ name }, platform = process.platform) {
  if (platform !== "linux") return null;
  const peerPid = Number(/^type=STREAM ->INO=\d+\s+(\d+),/u.exec(name)?.[1]);
  return Number.isSafeInteger(peerPid) && peerPid > 1 ? peerPid : null;
}

function linuxPipePeerDescriptorTarget({ inode, name }) {
  if (name.startsWith("type=STREAM")) {
    const peer = /^type=STREAM ->INO=(\d+)(?:\s|$)/u.exec(name)?.[1];
    return peer ? `socket:[${peer}]` : null;
  }
  return inode && name === "pipe" ? `pipe:[${inode}]` : null;
}

export function readLinuxProbePipeOwnerCandidates(descriptorTargets, dependencies = {}) {
  if (!(descriptorTargets instanceof Set) || descriptorTargets.size === 0) return null;
  const userId = "userId" in dependencies
    ? dependencies.userId
    : process.getuid?.();
  if (!Number.isSafeInteger(userId) || userId < 0) return null;
  const procRoot = dependencies.procRoot ?? "/proc";
  const now = dependencies.now ?? performance.now.bind(performance);
  const startedAt = now();
  let processDirectory;
  try {
    processDirectory = opendirSync(procRoot);
  } catch {
    return null;
  }
  try {
    const candidates = new Map();
    let scannedProcessCount = 0;
    let entry;
    while (true) {
      try {
        entry = processDirectory.readSync();
      } catch {
        return null;
      }
      if (entry === null) break;
      if (now() - startedAt > PROCESS_TABLE_TIMEOUT_MS) return null;
      if (!entry.isDirectory() || !/^[1-9]\d*$/u.test(entry.name)) continue;
      scannedProcessCount += 1;
      if (scannedProcessCount > LINUX_PROC_OWNER_SCAN_LIMIT) return null;
      const pid = Number(entry.name);
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      try {
        if (statSync(join(procRoot, entry.name)).uid !== userId) continue;
      } catch {
        continue;
      }
      for (const descriptor of ["1", "2"]) {
        try {
          const target = readlinkSync(join(procRoot, entry.name, "fd", descriptor));
          if (!descriptorTargets.has(target)) continue;
          const ownedTargets = candidates.get(pid) ?? new Set();
          ownedTargets.add(target);
          candidates.set(pid, ownedTargets);
          if (candidates.size > LINUX_PROC_OWNER_CANDIDATE_LIMIT) return null;
        } catch {
          // The process or descriptor can disappear during the bounded snapshot.
        }
      }
    }
    return candidates;
  } finally {
    try { processDirectory.closeSync(); } catch { /* The scan handle is already closed. */ }
  }
}

function childPipeDescriptor(stream) {
  const descriptor = stream?._handle?.fd;
  return Number.isSafeInteger(descriptor) && descriptor >= 0 ? descriptor : null;
}

function linuxSocketDescriptorInode(target) {
  return /^socket:\[(\d+)\]$/u.exec(target)?.[1] ?? null;
}

function readLinuxProcessIdentity(pid, procRoot) {
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
    const parentPid = Number(fields[1]);
    const startTime = fields[19];
    return Number.isSafeInteger(parentPid) && parentPid > 0 && /^\d+$/u.test(startTime)
      ? { parentPid, startTime }
      : null;
  } catch {
    return null;
  }
}

export function readLinuxDirectChildPipeCandidate(child, dependencies = {}) {
  const rootPid = child?.pid;
  const parentPid = dependencies.parentPid ?? process.pid;
  const userId = "userId" in dependencies
    ? dependencies.userId
    : process.getuid?.();
  if (
    !Number.isSafeInteger(rootPid) || rootPid <= 1
    || !Number.isSafeInteger(parentPid) || parentPid <= 1
    || !Number.isSafeInteger(userId) || userId < 0
  ) return null;
  const procRoot = dependencies.procRoot ?? "/proc";
  const before = readLinuxProcessIdentity(rootPid, procRoot);
  if (before?.parentPid !== parentPid) return null;
  try {
    if (statSync(join(procRoot, String(rootPid))).uid !== userId) return null;
  } catch {
    return null;
  }
  const descriptors = [
    [childPipeDescriptor(child.stdout), "1"],
    [childPipeDescriptor(child.stderr), "2"],
  ];
  const descriptorIdentities = new Map();
  const descriptorTargets = new Set();
  const identities = new Set();
  for (const [parentDescriptor, childDescriptor] of descriptors) {
    if (parentDescriptor === null) return null;
    try {
      const parentTarget = readlinkSync(
        join(procRoot, String(parentPid), "fd", String(parentDescriptor)),
      );
      const childTarget = readlinkSync(
        join(procRoot, String(rootPid), "fd", childDescriptor),
      );
      const parentInode = linuxSocketDescriptorInode(parentTarget);
      const childInode = linuxSocketDescriptorInode(childTarget);
      if (!parentInode || !childInode) return null;
      const identity = `socket:${[parentInode, childInode].sort().join(":")}`;
      descriptorIdentities.set(childTarget, identity);
      identities.add(identity);
      descriptorTargets.add(childTarget);
    } catch {
      return null;
    }
  }
  const after = readLinuxProcessIdentity(rootPid, procRoot);
  let finalUserId = null;
  try {
    finalUserId = statSync(join(procRoot, String(rootPid))).uid;
  } catch {
    return null;
  }
  if (
    after?.parentPid !== parentPid
    || after.startTime !== before.startTime
    || finalUserId !== userId
    || descriptorIdentities.size !== descriptors.length
    || identities.size !== descriptors.length
    || descriptorTargets.size !== descriptors.length
  ) return null;
  return {
    descriptorIdentities,
    descriptorTargets,
    identities,
    ownerPids: new Set([rootPid]),
  };
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function descriptorIdentitiesEqual(left, right) {
  return left.size === right.size
    && [...left].every(([target, identity]) => right.get(target) === identity);
}

export function readPosixProbePipeIdentities(
  child,
  readRecords = readLsofRecords,
  platform = process.platform,
  dependencies = {},
) {
  if (platform === "linux") {
    const readDirectCandidate = dependencies.readDirectCandidate
      ?? readLinuxDirectChildPipeCandidate;
    const readSocketPairs = dependencies.readSocketPairs ?? readLinuxSocketPairs;
    const before = readDirectCandidate(child);
    if (before) {
      const liveIdentities = readSocketPairs();
      const after = readDirectCandidate(child);
      const finalIdentities = after ? readSocketPairs() : null;
      if (
        liveIdentities
        && finalIdentities
        && after
        && setsEqual(before.identities, after.identities)
        && descriptorIdentitiesEqual(
          before.descriptorIdentities,
          after.descriptorIdentities,
        )
        && [...after.identities].every((identity) => (
          liveIdentities.has(identity) && finalIdentities.has(identity)
        ))
      ) return after;
    }
  }
  const descriptors = [
    childPipeDescriptor(child.stdout),
    childPipeDescriptor(child.stderr),
  ];
  if (descriptors.some((descriptor) => descriptor === null)) return null;
  const scanPasses = platform === "linux"
    ? LINUX_OWNERSHIP_SCAN_PASSES
    : POSIX_OWNERSHIP_TOKEN_PASSES;
  for (let pass = 0; pass < scanPasses; pass += 1) {
    const records = readRecords([
      "-a",
      "-p", String(process.pid),
      "-d", descriptors.join(","),
    ], platform === "linux" ? LINUX_LSOF_TIMEOUT_MS : PROCESS_TABLE_TIMEOUT_MS);
    if (!records) continue;
    const identities = new Set(
      records.map((record) => lsofPipeIdentity(record, platform)).filter(Boolean),
    );
    if (identities.size !== descriptors.length) continue;
    const descriptorIdentities = new Map();
    if (platform === "linux") {
      for (const record of records) {
        const target = linuxPipePeerDescriptorTarget(record);
        const identity = lsofPipeIdentity(record, platform);
        if (target && identity) descriptorIdentities.set(target, identity);
      }
    }
    const descriptorTargets = platform === "linux"
      ? new Set(descriptorIdentities.keys())
      : null;
    if (platform === "linux" && descriptorTargets.size !== descriptors.length) continue;
    return {
      descriptorIdentities,
      descriptorTargets,
      identities,
      ownerPids: new Set(records.map((record) => lsofPipePeerPid(record, platform)).filter(Boolean)),
    };
  }
  return null;
}

export function readPosixProbePipeOwners(
  pipeIdentities,
  dependencies = {},
) {
  const readRecords = dependencies.readRecords ?? readLsofRecords;
  const platform = dependencies.platform ?? process.platform;
  const userId = "userId" in dependencies
    ? dependencies.userId
    : process.getuid?.();
  if (!Number.isSafeInteger(userId) || userId < 0) return null;
  if (platform === "linux" && dependencies.descriptorTargets) {
    const readLinuxCandidates = dependencies.readLinuxCandidates
      ?? readLinuxProbePipeOwnerCandidates;
    const readSocketPairs = dependencies.readSocketPairs ?? readLinuxSocketPairs;
    const beforeCandidates = readLinuxCandidates(dependencies.descriptorTargets, { userId });
    if (beforeCandidates?.size > 0) {
      const liveIdentities = readSocketPairs();
      const afterCandidates = liveIdentities
        ? readLinuxCandidates(dependencies.descriptorTargets, { userId })
        : null;
      const finalIdentities = afterCandidates ? readSocketPairs() : null;
      if (
        afterCandidates
        && finalIdentities
        && dependencies.descriptorIdentities instanceof Map
      ) {
        const owners = new Set();
        for (const [pid, beforeTargets] of beforeCandidates) {
          const afterTargets = afterCandidates.get(pid);
          if (!afterTargets) continue;
          const hasProvenDescriptor = [...beforeTargets].some((target) => {
            const identity = dependencies.descriptorIdentities.get(target);
            return afterTargets.has(target)
              && pipeIdentities.has(identity)
              && liveIdentities.has(identity)
              && finalIdentities.has(identity);
          });
          if (hasProvenDescriptor) owners.add(pid);
        }
        if (owners.size > 0) return owners;
      }
      const candidatePids = new Set([
        ...beforeCandidates.keys(),
        ...(afterCandidates?.keys() ?? []),
      ]);
      const scopedArgs = [
        "-a",
        "-p", [...candidatePids].join(","),
        "-u", String(userId),
        "-d", "1,2",
      ];
      for (let pass = 0; pass < LINUX_OWNERSHIP_SCAN_PASSES; pass += 1) {
        const records = readRecords(scopedArgs, LINUX_LSOF_TIMEOUT_MS);
        if (!records) continue;
        const owners = new Set(
          records
            .filter((record) => (
              candidatePids.has(record.pid)
              && pipeIdentities.has(lsofPipeIdentity(record, platform))
            ))
            .map(({ pid }) => pid),
        );
        if (owners.size > 0) return owners;
      }
    }
  }
  let emptyOwners = null;
  const scanPasses = platform === "linux"
    ? LINUX_OWNERSHIP_SCAN_PASSES
    : POSIX_OWNERSHIP_TOKEN_PASSES;
  for (let pass = 0; pass < scanPasses; pass += 1) {
    const records = readRecords([
      "-a",
      "-u", String(userId),
      "-d", "1,2",
    ], platform === "linux" ? LINUX_LSOF_TIMEOUT_MS : PROCESS_TABLE_TIMEOUT_MS);
    if (!records) continue;
    const owners = new Set(
      records
        .filter((record) => pipeIdentities.has(lsofPipeIdentity(record, platform)))
        .map(({ pid }) => pid),
    );
    if (owners.size > 0) return owners;
    emptyOwners = owners;
  }
  return emptyOwners;
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
    const pipeOwners = readPipeOwners(pipeToken.identities, {
      descriptorIdentities: pipeToken.descriptorIdentities,
      descriptorTargets: pipeToken.descriptorTargets,
    });
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
