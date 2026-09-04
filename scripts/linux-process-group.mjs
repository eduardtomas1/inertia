import { readdirSync, readFileSync } from "node:fs";

function missingProcess(error) {
  return error?.code === "ENOENT" || error?.code === "ESRCH";
}

function parsedLinuxProcess(stat) {
  const closingName = stat.lastIndexOf(")");
  if (closingName < 2) return null;
  const fields = stat.slice(closingName + 1).trimStart().split(/\s+/u);
  const state = fields[0];
  const processGroupId = Number(fields[2]);
  return state && /^[A-Za-z]$/u.test(state)
    && Number.isSafeInteger(processGroupId)
    ? { processGroupId, state }
    : null;
}

export function linuxProcessCanExecute(pid, dependencies = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  let stat;
  try {
    stat = dependencies.readStat?.(String(pid))
      ?? readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return missingProcess(error) ? false : null;
  }
  const process = parsedLinuxProcess(stat);
  return process
    ? process.state !== "Z" && process.state !== "X" && process.state !== "x"
    : null;
}

/**
 * Returns whether any member of one Linux process group can still execute.
 * `false` includes an absent group and a group containing only Z/X/x states;
 * malformed or unreadable observations remain `null` and therefore fail closed.
 */
export function linuxProcessGroupCanExecute(processGroupId, dependencies = {}) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) return null;
  let processIds;
  try {
    processIds = dependencies.processIds?.() ?? readdirSync("/proc");
  } catch {
    return null;
  }
  for (const value of processIds) {
    if (!/^[1-9][0-9]*$/u.test(value)) continue;
    let stat;
    try {
      stat = dependencies.readStat?.(value)
        ?? readFileSync(`/proc/${value}/stat`, "utf8");
    } catch (error) {
      if (missingProcess(error)) continue;
      return null;
    }
    const process = parsedLinuxProcess(stat);
    if (!process) return null;
    if (process.processGroupId !== processGroupId) continue;
    if (process.state !== "Z" && process.state !== "X"
      && process.state !== "x") return true;
  }
  return false;
}
