import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

import { appControlNameDenied } from "../shared/app-control-denylist.js";

/**
 * Resolves the live process tree an App under test launch owns, so App control
 * reads and acts only on windows of processes Inertia launched for that chat.
 * The root must still be the process the runtime spawned: its start time has
 * to fall inside the window recorded when the runtime spawned it. Every
 * descendant must have a known start time no earlier than its direct
 * parent's; anything else is a reused pid and is dropped with its subtree.
 */

export interface AppControlProcessEntry {
  pid: number;
  parentPid: number;
  /** Epoch milliseconds, or null when the platform did not report it. */
  startedAtMs: number | null;
  /** Executable path or name, or null when it could not be read. */
  executable: string | null;
}

export interface AppControlOwnedTree {
  /** The root and every live descendant, root first. */
  pids: number[];
  /** Members whose executable is on the App control denylist or could not be read. */
  deniedPids: number[];
}

export const APP_CONTROL_MAX_TREE_PROCESSES = 1_024;
const MAX_PROCESS_TABLE_ENTRIES = 65_536;
/** The root may start a little before the recorded instant (clock reads, rounding) and after it. */
const START_EARLIEST_MS = 2_000;
const START_LATEST_MS = 15_000;
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/** The launch's tree has more processes than App control checks; the command is refused. */
export class AppControlTreeTooLargeError extends Error {
  constructor() {
    super("The app's process tree is too large to check.");
  }
}

/**
 * True when an observed start time is consistent with the start recorded at
 * spawn. An unknown start time cannot prove the identity, so it never matches.
 */
export function appControlStartMatches(observedMs: number | null, recordedMs: number): boolean {
  if (observedMs === null) return false;
  return observedMs >= recordedMs - START_EARLIEST_MS && observedMs <= recordedMs + START_LATEST_MS;
}

/**
 * The root and every process whose parent chain reaches it, by parent pid
 * only (no start-time check), bounded. Throws when the tree is larger than
 * App control checks, so a caller never reads only part of it.
 */
export function appControlTreeCandidates(
  entries: readonly Pick<AppControlProcessEntry, "pid" | "parentPid">[],
  rootPid: number,
): Set<number> {
  const children = new Map<number, number[]>();
  for (const { pid, parentPid } of entries) {
    if (pid === parentPid) continue;
    const list = children.get(parentPid);
    if (list) list.push(pid);
    else children.set(parentPid, [pid]);
  }
  const owned = new Set([rootPid]);
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index]!) ?? []) {
      if (owned.has(child)) continue;
      if (owned.size >= APP_CONTROL_MAX_TREE_PROCESSES) throw new AppControlTreeTooLargeError();
      owned.add(child);
      queue.push(child);
    }
  }
  return owned;
}

/**
 * The owned tree under `rootPid`, null when the root is gone or is no longer
 * the launched process (pid reuse or an unknown start time), or "too-large".
 */
export function appControlOwnedTree(
  entries: readonly AppControlProcessEntry[],
  rootPid: number,
  processStartedAt: number,
): AppControlOwnedTree | "too-large" | null {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const root = byPid.get(rootPid);
  if (!root || !appControlStartMatches(root.startedAtMs, processStartedAt)) return null;
  const children = new Map<number, AppControlProcessEntry[]>();
  for (const entry of entries) {
    if (entry.pid === entry.parentPid || entry.pid === rootPid) continue;
    const list = children.get(entry.parentPid);
    if (list) list.push(entry);
    else children.set(entry.parentPid, [entry]);
  }
  const members: AppControlProcessEntry[] = [root];
  const seen = new Set([rootPid]);
  for (let index = 0; index < members.length; index += 1) {
    const parent = members[index]!;
    for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      // Fail closed: an unknown start time, or one before the direct parent's
      // (a reused pid, not a child), drops the entry and its whole subtree.
      if (child.startedAtMs === null || parent.startedAtMs === null || child.startedAtMs < parent.startedAtMs) continue;
      if (members.length >= APP_CONTROL_MAX_TREE_PROCESSES) return "too-large";
      seen.add(child.pid);
      members.push(child);
    }
  }
  // An executable that could not be read is treated as denied.
  const deniedPids = members
    .filter(({ executable }) => executable === null || appControlNameDenied({ executablePath: executable }))
    .map(({ pid }) => pid);
  return { pids: members.map(({ pid }) => pid), deniedPids };
}

/** One `/proc/<pid>/stat` line: parent pid and start time in clock ticks since boot. */
export function parseLinuxStat(stat: string): { parentPid: number; startTicks: number } | null {
  const closing = stat.lastIndexOf(")");
  if (closing < 0 || stat.length > 16_384) return null;
  const fields = stat.slice(closing + 2).trim().split(/\s+/u);
  const parentPid = Number(fields[1]);
  const startTicks = Number(fields[19]);
  return Number.isSafeInteger(parentPid) && Number.isSafeInteger(startTicks) ? { parentPid, startTicks } : null;
}

/** Boot time in epoch milliseconds from `/proc/stat`. */
export function parseLinuxBootTime(stat: string): number | null {
  const match = stat.match(/^btime\s+(\d+)$/mu);
  return match ? Number(match[1]) * 1_000 : null;
}

/**
 * Linux: every process's parent and start time from `/proc`, without starting
 * a process. Executables are read only for the tree under `rootPid`, the
 * only ones the denylist needs; a tree larger than App control checks throws
 * `AppControlTreeTooLargeError` instead of being read in part.
 */
export async function readLinuxProcessTable(rootPid: number, procRoot = "/proc"): Promise<AppControlProcessEntry[]> {
  const bootMs = parseLinuxBootTime(await readFile(join(procRoot, "stat"), "utf8").catch(() => ""));
  const names = (await readdir(procRoot)).filter((name) => /^\d+$/u.test(name)).slice(0, MAX_PROCESS_TABLE_ENTRIES);
  const parsed = await Promise.all(names.map(async (name): Promise<AppControlProcessEntry | null> => {
    const stat = parseLinuxStat(await readFile(join(procRoot, name, "stat"), "utf8").catch(() => ""));
    if (!stat) return null;
    return {
      pid: Number(name),
      parentPid: stat.parentPid,
      startedAtMs: bootMs === null ? null : bootMs + stat.startTicks * (1_000 / LINUX_CLOCK_TICKS_PER_SECOND),
      executable: null,
    };
  }));
  const entries = parsed.filter((entry): entry is AppControlProcessEntry => entry !== null);
  const owned = appControlTreeCandidates(entries, rootPid);
  await Promise.all(entries.map(async (entry) => {
    if (!owned.has(entry.pid)) return;
    entry.executable = await readlink(join(procRoot, String(entry.pid), "exe")).catch(() => null);
  }));
  return entries;
}
