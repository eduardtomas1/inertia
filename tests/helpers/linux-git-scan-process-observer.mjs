import { readFileSync, readlinkSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("The Linux process observer requires a parent port.");

const parentPid = workerData.parentPid;
const repositoryRoots = new Set(workerData.repositoryRoots);
const controlHelperPids = new Set();
const guardianPids = new Set();
const guardedTreePids = new Set();
const observed = new Set();
const startedAt = performance.now();
let peakControlHelpers = 0;
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
  for (const pid of direct) {
    if (
      guardianExecutable(pid)
      && repositoryRoots.has(procLink(pid, "cwd"))
    ) {
      guardianPids.add(pid);
      guardedTreePids.add(pid);
      descendants(pid).forEach((child) => guardedTreePids.add(child));
    }
  }
  for (const pid of direct) {
    const args = procCommand(pid);
    if (
      guardianExecutable(pid)
      && (args[1] === "ready" || args[1] === "signal")
      && guardianPids.has(Number(args[2]))
    ) controlHelperPids.add(pid);
  }
  const current = all.filter((pid) => (
    guardedTreePids.has(pid) || controlHelperPids.has(pid)
  ));
  const guardedCurrent = current.filter((pid) => guardedTreePids.has(pid));
  const helpersCurrent = current.filter((pid) => controlHelperPids.has(pid));
  peakControlHelpers = Math.max(peakControlHelpers, helpersCurrent.length);
  peakDescendants = Math.max(peakDescendants, current.length);
  peakGuardedTreeDescendants = Math.max(
    peakGuardedTreeDescendants,
    guardedCurrent.length,
  );
  const usage = current.map(procResourceUsage);
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
