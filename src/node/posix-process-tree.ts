import { spawnSync } from "node:child_process";

const MAX_FREEZE_PASSES = 8;
const PROCESS_TABLE_COMMAND = "/bin/ps";
const PROCESS_SNAPSHOT_TIMEOUT_MS = 250;
const PROCESS_TABLE_MAX_BYTES = 2 * 1024 * 1024;

export interface PosixProcessTreeDependencies {
  kill: typeof process.kill;
  spawnProcessSync: typeof spawnSync;
  rootProcessGroup: boolean;
}

export function posixDescendantPids(
  rootPid: number,
  processTable: string,
): number[] {
  const children = new Map<number, number[]>();
  for (const line of processTable.split(/\r?\n/gu)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  const descendants: number[] = [];
  const visited = new Set<number>([rootPid]);
  const visit = (parent: number): void => {
    for (const child of children.get(parent) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      visit(child);
      descendants.push(child);
    }
  };
  visit(rootPid);
  return descendants;
}

/**
 * Freezes an owned POSIX process tree, rescans for children created during the
 * snapshot race, then force-kills descendants before their parents.
 */
export function forceKillPosixProcessTree(
  rootPid: number,
  dependencies: Partial<PosixProcessTreeDependencies> = {},
): number[] {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) return [];
  const kill = dependencies.kill ?? process.kill;
  const spawnProcessSync = dependencies.spawnProcessSync ?? spawnSync;
  const rootProcessGroup = dependencies.rootProcessGroup === true;

  if (rootProcessGroup) {
    try { kill(-rootPid, "SIGSTOP"); } catch { /* It may not be a group leader. */ }
  }
  try { kill(rootPid, "SIGSTOP"); } catch { /* It may already be gone. */ }

  const frozen = new Set<number>();
  let killOrder: number[] = [];
  for (let pass = 0; pass < MAX_FREEZE_PASSES; pass += 1) {
    let descendants: number[] = [];
    try {
      const table = spawnProcessSync(
        PROCESS_TABLE_COMMAND,
        ["-axo", "pid=,ppid="],
        {
          encoding: "utf8",
          timeout: PROCESS_SNAPSHOT_TIMEOUT_MS,
          maxBuffer: PROCESS_TABLE_MAX_BYTES,
          shell: false,
        },
      );
      if (table.status === 0 && typeof table.stdout === "string") {
        descendants = posixDescendantPids(rootPid, table.stdout);
      }
    } catch {
      // The owned process group remains the bounded fallback when available.
    }
    killOrder = descendants;
    const newlyDiscovered = descendants.filter((pid) => !frozen.has(pid));
    if (newlyDiscovered.length === 0) break;
    for (const pid of [...newlyDiscovered].reverse()) {
      try { kill(-pid, "SIGSTOP"); } catch { /* Not a process-group leader. */ }
      try { kill(pid, "SIGSTOP"); } catch { /* Already stopped with its group. */ }
      frozen.add(pid);
    }
  }

  const targets = [
    ...killOrder,
    ...[...frozen].filter((pid) => !killOrder.includes(pid)),
  ];
  for (const pid of targets) {
    try { kill(-pid, "SIGKILL"); } catch { /* Not a process-group leader. */ }
    try { kill(pid, "SIGKILL"); } catch { /* Already removed with its group. */ }
  }
  if (rootProcessGroup) {
    try { kill(-rootPid, "SIGKILL"); } catch { /* The group may already be gone. */ }
  }
  try { kill(rootPid, "SIGKILL"); } catch { /* Already gone. */ }
  return targets;
}
