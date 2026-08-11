import {
  lstatSync,
  mkdirSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { join, normalize } from "node:path";

export interface PinnedJournalDirectory {
  readonly path: string;
  readonly realDataDirectory: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export function journalDirectoryIdentityMatches(
  expected: Pick<PinnedJournalDirectory, "device" | "inode">,
  actual: Pick<BigIntStats, "dev" | "ino">,
): boolean {
  return actual.dev === expected.device && actual.ino === expected.inode;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function safeDirectoryInfo(path: string): BigIntStats | null {
  try {
    const info = lstatSync(path, { bigint: true });
    return !info.isSymbolicLink() && info.isDirectory() ? info : null;
  } catch {
    return null;
  }
}

export function pinJournalDirectory(
  dataDirectory: string,
  leaf: string,
  create: boolean,
): PinnedJournalDirectory | null {
  if (!leaf || leaf === "." || leaf === ".." || /[\\/]/u.test(leaf)) {
    throw new Error("The runtime journal leaf is invalid.");
  }
  const realDataDirectory = realpathSync(dataDirectory);
  const path = join(realDataDirectory, leaf);
  let info = safeDirectoryInfo(path);
  if (!info && create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch {
      // A concurrent creator is accepted only after the same strict checks.
    }
    info = safeDirectoryInfo(path);
  }
  if (!info) {
    try {
      lstatSync(path);
      throw new Error("The runtime journal directory is unsafe.");
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && "code" in error
        && error.code === "ENOENT"
      ) return null;
      throw error;
    }
  }
  if (!samePath(realpathSync(path), path)) {
    throw new Error("The runtime journal directory escaped its data root.");
  }
  return {
    path,
    realDataDirectory,
    device: info.dev,
    inode: info.ino,
  };
}

export function journalDirectoryIsPinned(
  directory: PinnedJournalDirectory,
): boolean {
  const info = safeDirectoryInfo(directory.path);
  if (
    !info
    || !journalDirectoryIdentityMatches(directory, info)
  ) return false;
  try {
    return samePath(realpathSync(directory.path), directory.path);
  } catch {
    return false;
  }
}
