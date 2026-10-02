import { realpathSync, statSync, type BigIntStats } from "node:fs";
import { dirname, join, posix } from "node:path";
import { normalizeIdentityPath } from "./project-identity";

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

function isPathInside(root: string, candidate: string): boolean {
  const child = posix.relative(normalizeIdentityPath(root), normalizeIdentityPath(candidate));
  return child === "" || (child !== ".." && !child.startsWith("../") && !posix.isAbsolute(child));
}

export function isWithinScratchRoot(dataDirectory: string, path: string): boolean {
  const scratchRoot = join(dataDirectory, "scratch");
  let identity: BigIntStats;
  let root: string;
  let candidate: string;
  try {
    identity = statSync(scratchRoot, { bigint: true });
    root = realpathSync.native(scratchRoot);
    candidate = realpathSync.native(path);
  } catch {
    return false;
  }
  if (isPathInside(root, candidate)) return true;
  if (identity.ino === 0n) return false;
  for (let current = candidate; ; current = dirname(current)) {
    if (isSameDirectory(current, identity)) return true;
    if (dirname(current) === current) return false;
  }
}
