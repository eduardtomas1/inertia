import { readFileSync } from "node:fs";

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
