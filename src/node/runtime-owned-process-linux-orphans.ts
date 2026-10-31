import { readdirSync, readFileSync } from "node:fs";

export const LINUX_RUNTIME_OWNED_GUARDIAN_MARKER = "INERTIA_RUNTIME_OWNED_GUARDIAN";
const MAX_SCANNED_PROCESSES = 32_768;
const MAX_ANCESTRY_DEPTH = 64;
const ORPHAN_TERMINATION_GRACE_MS = 500;
const ORPHAN_POLL_MS = 20;
const ORPHAN_REAP_ROUNDS = 3;

export interface LinuxGuardianOrphan {
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly command: string;
}

export interface LinuxGuardianOrphanReap {
  readonly recovered: boolean;
  readonly unsignalled: readonly LinuxGuardianOrphan[];
}

export interface LinuxGuardianOrphanOptions {
  readonly deadlineAt: number;
  readonly procRoot?: string;
  readonly selfPid?: number;
  readonly maxProcesses?: number;
  readonly reusedHolderStartTimeTicks?: string | null;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait?: (durationMs: number) => Promise<void>;
  readonly uid?: number | null;
  readonly readEnviron?: (path: string) => string;
}

interface LinuxProcessStat {
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTimeTicks: string;
  readonly command: string;
  readonly executable: boolean;
}

export function linuxGuardianMarkerValue(guardian: {
  readonly pid: number;
  readonly startTimeTicks: string;
}): string {
  return `${guardian.pid}:${guardian.startTimeTicks}`;
}

function readProcessStat(procRoot: string, pid: number): LinuxProcessStat | null {
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open < 0 || close < open) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const sessionId = Number(fields[3]);
    const startTimeTicks = fields[19];
    if (!fields[0] || !Number.isSafeInteger(parentPid) || !Number.isSafeInteger(processGroupId)
      || !Number.isSafeInteger(sessionId) || !startTimeTicks || !/^[0-9]+$/u.test(startTimeTicks)) return null;
    return {
      parentPid,
      processGroupId,
      sessionId,
      startTimeTicks,
      command: stat.slice(open + 1, close).slice(0, 64),
      executable: !["Z", "X", "x"].includes(fields[0]),
    };
  } catch {
    return null;
  }
}

type MarkerState = "present" | "absent" | "unreadable";

function markerState(
  procRoot: string,
  pid: number,
  entry: string,
  readEnviron: (path: string) => string,
): MarkerState {
  try {
    return readEnviron(`${procRoot}/${pid}/environ`).split("\0").includes(entry) ? "present" : "absent";
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    return code === "EACCES" || code === "EPERM" ? "unreadable" : "absent";
  }
}

function processRealUid(procRoot: string, pid: number): number | null {
  try {
    const match = /^Uid:\s+([0-9]+)\s/mu.exec(readFileSync(`${procRoot}/${pid}/status`, "utf8"));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function ancestors(procRoot: string, pid: number): Set<number> {
  const found = new Set<number>();
  let current = readProcessStat(procRoot, pid)?.parentPid ?? 0;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current > 1 && !found.has(current); depth += 1) {
    found.add(current);
    current = readProcessStat(procRoot, current)?.parentPid ?? 0;
  }
  return found;
}

function belongsToGuardian(
  procRoot: string,
  guardian: { readonly pid: number; readonly startTimeTicks: string },
  stat: LinuxProcessStat,
): boolean {
  if (stat.sessionId === guardian.pid || stat.processGroupId === guardian.pid) return true;
  let current = stat.parentPid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && current > 1; depth += 1) {
    const parent = readProcessStat(procRoot, current);
    if (!parent) return false;
    if (current === guardian.pid) return parent.startTimeTicks === guardian.startTimeTicks;
    current = parent.parentPid;
  }
  return false;
}

export function scanLinuxGuardianOrphans(
  guardian: { readonly pid: number; readonly startTimeTicks: string },
  options: LinuxGuardianOrphanOptions,
): {
  readonly complete: boolean;
  readonly orphans: readonly LinuxGuardianOrphan[];
  readonly unreadable?: readonly LinuxGuardianOrphan[];
  readonly interrupted?: true;
} {
  const procRoot = options.procRoot ?? "/proc";
  const selfPid = options.selfPid ?? process.pid;
  const reusedHolder = options.reusedHolderStartTimeTicks ?? null;
  const uid = options.uid === undefined ? process.getuid?.() ?? null : options.uid;
  const readEnviron = options.readEnviron ?? ((path: string) => readFileSync(path, "latin1"));
  const entry = `${LINUX_RUNTIME_OWNED_GUARDIAN_MARKER}=${linuxGuardianMarkerValue(guardian)}`;
  let names: string[];
  try {
    names = readdirSync(procRoot).filter((name) => /^[1-9][0-9]*$/u.test(name));
  } catch {
    return { complete: false, orphans: [] };
  }
  if (names.length > (options.maxProcesses ?? MAX_SCANNED_PROCESSES)) {
    return { complete: false, orphans: [] };
  }
  const protectedAncestors = ancestors(procRoot, selfPid);
  const orphans: LinuxGuardianOrphan[] = [];
  const unreadable: LinuxGuardianOrphan[] = [];
  const blocked = () => unreadable.length > 0 ? { unreadable } : {};
  for (const name of names) {
    if (Date.now() >= options.deadlineAt) return { complete: false, orphans, ...blocked(), interrupted: true };
    const pid = Number(name);
    if (pid === selfPid || protectedAncestors.has(pid)) continue;
    const marker = markerState(procRoot, pid, entry, readEnviron);
    if (marker === "absent") continue;
    const stat = readProcessStat(procRoot, pid);
    if (!stat?.executable || ancestors(procRoot, pid).has(selfPid)) continue;
    if (marker === "unreadable") {
      if (reusedHolder !== null && BigInt(stat.startTimeTicks) >= BigInt(reusedHolder)) continue;
      if (
        uid !== null
        && processRealUid(procRoot, pid) === uid
        && BigInt(stat.startTimeTicks) >= BigInt(guardian.startTimeTicks)
        && belongsToGuardian(procRoot, guardian, stat)
      ) unreadable.push({ pid, startTimeTicks: stat.startTimeTicks, command: stat.command });
      continue;
    }
    orphans.push({ pid, startTimeTicks: stat.startTimeTicks, command: stat.command });
  }
  return unreadable.length > 0 ? { complete: false, orphans, unreadable } : { complete: true, orphans };
}

function guardianSessionMembers(
  guardian: { readonly pid: number; readonly startTimeTicks: string },
  options: LinuxGuardianOrphanOptions,
): LinuxGuardianOrphan[] | null {
  const procRoot = options.procRoot ?? "/proc";
  let names: string[];
  try {
    names = readdirSync(procRoot).filter((name) => /^[1-9][0-9]*$/u.test(name));
  } catch {
    return null;
  }
  if (names.length > (options.maxProcesses ?? MAX_SCANNED_PROCESSES)) return null;
  const reusedHolder = options.reusedHolderStartTimeTicks ?? null;
  const members: LinuxGuardianOrphan[] = [];
  for (const name of names) {
    if (Date.now() >= options.deadlineAt) return null;
    const stat = readProcessStat(procRoot, Number(name));
    if (
      !stat?.executable
      || stat.sessionId !== guardian.pid
      || BigInt(stat.startTimeTicks) < BigInt(guardian.startTimeTicks)
      || (reusedHolder !== null && BigInt(stat.startTimeTicks) >= BigInt(reusedHolder))
    ) continue;
    members.push({ pid: Number(name), startTimeTicks: stat.startTimeTicks, command: stat.command });
  }
  return members;
}

function sameOrphan(procRoot: string, orphan: LinuxGuardianOrphan): boolean {
  const stat = readProcessStat(procRoot, orphan.pid);
  return stat !== null && stat.executable && stat.startTimeTicks === orphan.startTimeTicks;
}

function signalOrphan(
  procRoot: string,
  orphan: LinuxGuardianOrphan,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void,
): boolean {
  if (!sameOrphan(procRoot, orphan)) return true;
  try {
    kill(orphan.pid, signal);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

async function waitUntilGone(
  procRoot: string,
  orphans: readonly LinuxGuardianOrphan[],
  untilAt: number,
  wait: (durationMs: number) => Promise<void>,
): Promise<LinuxGuardianOrphan[]> {
  let survivors = orphans.filter((orphan) => sameOrphan(procRoot, orphan));
  while (survivors.length > 0 && Date.now() + ORPHAN_POLL_MS < untilAt) {
    await wait(ORPHAN_POLL_MS);
    survivors = survivors.filter((orphan) => sameOrphan(procRoot, orphan));
  }
  return survivors;
}

export async function reapLinuxGuardianOrphans(
  guardian: { readonly pid: number; readonly startTimeTicks: string },
  options: LinuxGuardianOrphanOptions,
): Promise<LinuxGuardianOrphanReap> {
  const procRoot = options.procRoot ?? "/proc";
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); });
  const wait = options.wait ?? ((durationMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  }));
  let blockers: readonly LinuxGuardianOrphan[] = [];
  for (let round = 0; round <= ORPHAN_REAP_ROUNDS; round += 1) {
    const scan = scanLinuxGuardianOrphans(guardian, options);
    blockers = scan.unreadable ?? [];
    if (!scan.complete && (scan.interrupted || blockers.length === 0)) {
      return { recovered: false, unsignalled: [...blockers] };
    }
    if (scan.orphans.length === 0) {
      if (blockers.length > 0) return { recovered: false, unsignalled: [...blockers] };
      const members = guardianSessionMembers(guardian, options);
      return { recovered: members?.length === 0, unsignalled: members ?? [] };
    }
    if (round === ORPHAN_REAP_ROUNDS) break;
    const unsignalled = scan.orphans.filter((orphan) => !signalOrphan(procRoot, orphan, "SIGTERM", kill));
    const signalled = scan.orphans.filter((orphan) => !unsignalled.includes(orphan));
    const survivors = await waitUntilGone(
      procRoot,
      signalled,
      Math.min(Date.now() + ORPHAN_TERMINATION_GRACE_MS, options.deadlineAt),
      wait,
    );
    unsignalled.push(...survivors.filter((orphan) => !signalOrphan(procRoot, orphan, "SIGKILL", kill)));
    const remaining = await waitUntilGone(procRoot, survivors, options.deadlineAt, wait);
    if (unsignalled.length > 0 || remaining.length > 0) {
      return { recovered: false, unsignalled: [...blockers, ...unsignalled] };
    }
  }
  return { recovered: false, unsignalled: [...blockers] };
}
