import { readFileSync, readlinkSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import { controlHelperCensus } from "./linux-control-helper-census.mjs";

if (!parentPort) throw new Error("The Linux process observer requires a parent port.");

const parentPid = workerData.parentPid;
const repositoryRoots = new Set(workerData.repositoryRoots);
const controlHelperPids = new Set();
const controlHelperCommands = new Map();
const guardianPids = new Set();
const guardedTreePids = new Set();
const observed = new Set();
const startedAt = performance.now();
let peakControlHelpers = 0;
let peakControlHelperDetail = [];
let peakAdmissionHelpers = 0;
let peakReleaseHelpers = 0;
let peakInspectionsWithControlHelpers = 0;
let releaseHandoffSamples = 0;
const controlHelperViolations = [];
let peakDescendants = 0;
let peakGuardedTreeDescendants = 0;
let peakDescendantRssKb = 0;
let peakDescendantThreads = 0;
let finishing = false;

function procChildren(pid) {
  try {
    const children = readFileSync(
      `/proc/${pid}/task/${pid}/children`,
      "utf8",
    ).trim();
    return children ? children.split(/\s+/u).map(Number) : [];
  } catch {
    return [];
  }
}

function descendants(pid) {
  const found = [];
  const pending = [...procChildren(pid)];
  const visited = new Set();
  while (pending.length > 0) {
    const child = pending.pop();
    if (!child || visited.has(child)) continue;
    visited.add(child);
    found.push(child);
    pending.push(...procChildren(child));
  }
  return found;
}

function procCommand(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function procLink(pid, name) {
  try {
    return readlinkSync(`/proc/${pid}/${name}`);
  } catch {
    return null;
  }
}

function procResourceUsage(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return {
      rssKb: Number(/^VmRSS:\s+(\d+)/mu.exec(status)?.[1] ?? 0),
      threads: Number(/^Threads:\s+(\d+)/mu.exec(status)?.[1] ?? 0),
    };
  } catch {
    return { rssKb: 0, threads: 0 };
  }
}

function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd < 0 ? null : stat.slice(commandEnd + 2, commandEnd + 3);
  } catch {
    return null;
  }
}

function guardianExecutable(pid) {
  return procLink(pid, "exe")?.endsWith("/runtime-process-guardian") === true;
}

function sample() {
  const direct = procChildren(parentPid);
  const all = descendants(parentPid);
  const directPids = new Set(direct);
  const helperCandidates = [];
  for (const pid of direct) {
    if (!guardianExecutable(pid)) continue;
    const args = procCommand(pid);
    if (args[1] === "ready" || args[1] === "signal") {
      helperCandidates.push({ pid, args });
      if (directPids.has(Number(args[2]))) guardianPids.add(Number(args[2]));
    } else if (repositoryRoots.has(procLink(pid, "cwd"))) {
      guardianPids.add(pid);
    }
  }
  for (const pid of direct) {
    if (!guardianPids.has(pid)) continue;
    guardedTreePids.add(pid);
    descendants(pid).forEach((child) => guardedTreePids.add(child));
  }
  for (const { pid, args } of helperCandidates) {
    if (guardianPids.has(Number(args[2]))) {
      controlHelperPids.add(pid);
      if (!controlHelperCommands.has(pid)) {
        controlHelperCommands.set(pid, {
          mode: args[1],
          target: Number(args[2]),
          action: args[1] === "signal" ? args[6] ?? null : null,
          firstSeenMs: Math.round(performance.now() - startedAt),
        });
      }
    }
  }
  const current = all.filter((pid) => (
    guardedTreePids.has(pid) || controlHelperPids.has(pid)
  ));
  // Exited children remain in /proc until libuv gets its waitpid turn. They
  // no longer execute control work or own RSS/threads, but remain in `current`
  // so settlement still requires the parent to reap every zombie.
  const liveCurrent = current.filter((pid) => {
    const state = procState(pid);
    return state !== null && state !== "Z";
  });
  const guardedCurrent = liveCurrent.filter((pid) => guardedTreePids.has(pid));
  const helpersCurrent = liveCurrent.filter((pid) => controlHelperPids.has(pid));
  if (helpersCurrent.length > peakControlHelpers) {
    const atMs = Math.round(performance.now() - startedAt);
    peakControlHelperDetail = helpersCurrent.map((pid) => {
      const command = controlHelperCommands.get(pid);
      return {
        pid,
        ...command,
        state: procState(pid),
        targetState: command ? procState(command.target) ?? "gone" : null,
        ageMs: command ? atMs - command.firstSeenMs : null,
      };
    });
  }
  peakControlHelpers = Math.max(peakControlHelpers, helpersCurrent.length);
  const census = controlHelperCensus(
    helpersCurrent.map((pid) => ({ pid, ...controlHelperCommands.get(pid) })),
    (guardian) => procChildren(guardian).length,
  );
  peakAdmissionHelpers = Math.max(peakAdmissionHelpers, census.admission);
  peakReleaseHelpers = Math.max(peakReleaseHelpers, census.release);
  peakInspectionsWithControlHelpers = Math.max(
    peakInspectionsWithControlHelpers,
    census.guardians,
  );
  if (census.handoffs > 0) releaseHandoffSamples += 1;
  if (census.violations.length > 0 && controlHelperViolations.length < 8) {
    controlHelperViolations.push({
      atMs: Math.round(performance.now() - startedAt),
      violations: census.violations,
    });
  }
  peakDescendants = Math.max(peakDescendants, liveCurrent.length);
  peakGuardedTreeDescendants = Math.max(
    peakGuardedTreeDescendants,
    guardedCurrent.length,
  );
  const usage = liveCurrent.map(procResourceUsage);
  peakDescendantRssKb = Math.max(
    peakDescendantRssKb,
    usage.reduce((sum, entry) => sum + entry.rssKb, 0),
  );
  peakDescendantThreads = Math.max(
    peakDescendantThreads,
    usage.reduce((sum, entry) => sum + entry.threads, 0),
  );
  current.forEach((pid) => observed.add(pid));
  return current;
}

async function finish() {
  const settlementStartedAt = performance.now();
  const deadlineAt = settlementStartedAt + 5_000;
  let consecutiveEmptySamples = 0;
  while (performance.now() < deadlineAt) {
    if (sample().length === 0) {
      consecutiveEmptySamples += 1;
      if (consecutiveEmptySamples === 2) break;
    } else {
      consecutiveEmptySamples = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  clearInterval(timer);
  const finalDescendants = sample();
  const durationMs = Math.max(1, performance.now() - startedAt);
  parentPort.postMessage({
    type: "metrics",
    value: {
      durationMs,
      finalDescendants,
      forkRatePerSecond: observed.size / (durationMs / 1_000),
      peakControlHelpers,
      peakControlHelperDetail,
      peakAdmissionHelpers,
      peakReleaseHelpers,
      peakInspectionsWithControlHelpers,
      releaseHandoffSamples,
      controlHelperViolations,
      peakDescendants,
      peakGuardedTreeDescendants,
      peakDescendantRssKb,
      peakDescendantThreads,
      settlementMs: performance.now() - settlementStartedAt,
      uniqueDescendants: observed.size,
      zombiesAtSettlement: finalDescendants.filter(
        (pid) => procState(pid) === "Z",
      ).length,
    },
  });
  parentPort.close();
}

sample();
const timer = setInterval(sample, 1);
parentPort.on("message", (message) => {
  if (message !== "finish" || finishing) return;
  finishing = true;
  void finish();
});
parentPort.postMessage({ type: "ready" });
