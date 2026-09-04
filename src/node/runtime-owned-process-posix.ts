import { readdirSync, readFileSync } from "node:fs";

import { readDarwinProcessIdentity } from "./runtime-owned-process-darwin.js";

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1;
}

export function linuxProcessCanExecute(pid: number): boolean | null {
  if (!validPid(pid)) return null;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (error.code === "ENOENT" || error.code === "ESRCH")
    ) return false;
    return null;
  }
  const closingName = stat.lastIndexOf(")");
  if (closingName < 2) return null;
  const state = stat.slice(closingName + 1).trimStart()[0];
  if (!state || !/^[A-Za-z]$/u.test(state)) return null;
  return state !== "Z" && state !== "X" && state !== "x";
}

/**
 * Reports whether an exact Linux process group still contains executable
 * work. Zombie/dead tasks remain signal-visible until their external parent
 * reaps them, but cannot retain resources or create descendants.
 */
export function linuxProcessGroupCanExecute(
  processGroupId: number,
  dependencies: {
    readonly processIds?: () => string[];
    readonly readStat?: (pid: string) => string;
  } = {},
): boolean | null {
  if (!validPid(processGroupId)) return null;
  let processIds: string[];
  try {
    processIds = dependencies.processIds?.() ?? readdirSync("/proc");
  } catch {
    return null;
  }
  for (const value of processIds) {
    if (!/^[1-9][0-9]*$/u.test(value)) continue;
    let stat: string;
    try {
      stat = dependencies.readStat?.(value)
        ?? readFileSync(`/proc/${value}/stat`, "utf8");
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && "code" in error
        && (error.code === "ENOENT" || error.code === "ESRCH")
      ) continue;
      return null;
    }
    const closingName = stat.lastIndexOf(")");
    if (closingName < 2) return null;
    const fields = stat.slice(closingName + 1).trimStart().split(/\s+/u);
    const state = fields[0];
    const group = fields[2];
    const groupId = Number(group);
    if (
      !state
      || !/^[A-Za-z]$/u.test(state)
      || !group
      || !/^[0-9]+$/u.test(group)
      || !Number.isSafeInteger(groupId)
    ) return null;
    // Linux kernel threads can legitimately report process group 0. They are
    // unrelated to any admissible owned group, but must not make the whole
    // exact /proc observation indeterminate.
    if (groupId !== processGroupId) continue;
    if (state !== "Z" && state !== "X" && state !== "x") return true;
  }
  return false;
}

export function darwinProcessCanExecute(
  pid: number,
  guardianPath: string,
  timeoutMs: number,
): boolean | null {
  try {
    return readDarwinProcessIdentity(pid, guardianPath, {
      deadlineAt: Date.now() + timeoutMs,
    }) !== null;
  } catch {
    return null;
  }
}

export function failedClaimProcessCanExecute(
  platform: NodeJS.Platform,
  guardianPath: string | null,
  timeoutMs: number,
): ((pid: number) => boolean | null) | null {
  if (platform === "linux") return linuxProcessCanExecute;
  if (platform !== "darwin" || !guardianPath) return null;
  return (pid) => darwinProcessCanExecute(pid, guardianPath, timeoutMs);
}

export function exactProcessGroupAbsent(pid: number): boolean | null {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error
      && typeof error === "object"
      && "code" in error
      && error.code === "ESRCH"
      ? true
      : null;
  }
}

export function exactProcessGroupTerminal(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): boolean | null {
  if (platform === "linux") {
    const executable = linuxProcessGroupCanExecute(pid);
    if (executable !== null) return !executable;
  }
  return exactProcessGroupAbsent(pid);
}
