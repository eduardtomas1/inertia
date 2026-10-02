import { realpathSync, statSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";

export const SCRATCH_RECOVERY_TARGET_REFUSAL =
  "Choose a recovery folder outside Inertia's folder for chats without a project.";

function isSameDirectory(path: string, identity: BigIntStats): boolean {
  try {
    const current = statSync(path, { bigint: true });
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

export function isWithinScratchRoot(dataDirectory: string, path: string): boolean {
  let root: BigIntStats;
  let candidate: string;
  try {
    root = statSync(join(dataDirectory, "scratch"), { bigint: true });
    candidate = realpathSync.native(path);
  } catch {
    return false;
  }
  for (let current = candidate; ; current = dirname(current)) {
    if (isSameDirectory(current, root)) return true;
    if (dirname(current) === current) return false;
  }
}
