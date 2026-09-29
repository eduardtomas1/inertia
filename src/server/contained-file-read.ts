import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "../node/platform-file-open-flags";

export interface ContainedFileRead {
  relativePath: string;
  content: Buffer;
}

interface NamespaceChain {
  directories: BigIntStats[];
  file: BigIntStats;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectNamespace(root: string, segments: readonly string[]): NamespaceChain {
  const directories = [lstatSync(root, { bigint: true })];
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    directories.push(lstatSync(cursor, { bigint: true }));
  }
  return {
    directories,
    file: lstatSync(join(cursor, segments.at(-1)!), { bigint: true }),
  };
}

function safeDirectories(chain: NamespaceChain): boolean {
  return chain.directories.every((entry) => entry.isDirectory() && !entry.isSymbolicLink());
}

function descriptorPath(descriptor: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readlinkSync(`/proc/self/fd/${descriptor}`);
  } catch {
    return "";
  }
}

export function readContainedFileSync(
  rootPath: string,
  requestedPath: string,
  maxBytes: number,
  label: string,
): ContainedFileRead {
  const root = realpathSync(rootPath);
  const canonical = realpathSync(resolve(root, requestedPath));
  const relation = relative(root, canonical);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} resolves outside the project workspace.`);
  }
  const segments = relation.split(sep).filter(Boolean);
  if (segments.length === 0) throw new Error(`${label} must resolve to a regular file.`);
  const changed = (): Error => new Error(`${label} ${relation} changed while it was being read.`);
  const tooLarge = (): Error => new Error(`${label} is too large to inspect safely.`);

  const before = inspectNamespace(root, segments);
  if (!safeDirectories(before)) throw changed();
  if (!before.file.isFile() || before.file.isSymbolicLink()) {
    throw new Error(`${label} must resolve to a regular file.`);
  }
  if (before.file.size > BigInt(maxBytes)) throw tooLarge();

  const descriptor = openSync(canonical, fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(opened, before.file)) throw changed();
    if (opened.size > BigInt(maxBytes)) throw tooLarge();
    const kernelPath = descriptorPath(descriptor);
    if (kernelPath !== null && kernelPath !== canonical) throw changed();
    const after = inspectNamespace(root, segments);
    if (
      !safeDirectories(after)
      || after.directories.some((entry, index) => !sameIdentity(entry, before.directories[index]!))
      || after.file.isSymbolicLink()
      || !sameIdentity(after.file, opened)
      || realpathSync(rootPath) !== root
      || realpathSync(canonical) !== canonical
    ) throw changed();

    const size = Number(opened.size);
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > size) throw changed();
    return { relativePath: relation, content: buffer.subarray(0, offset) };
  } finally {
    closeSync(descriptor);
  }
}
