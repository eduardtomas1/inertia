import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const FILE_MODE = 0o600;

interface StatePaths {
  directory: string;
  target: string;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function statePaths(path: string): StatePaths {
  const name = basename(path);
  if (!name || name === "." || name === "..") {
    throw new Error("Invalid secure state path");
  }
  const directory = realpathSync(dirname(resolve(path)));
  const target = resolve(directory, name);
  const contained = relative(directory, target);
  if (!contained || contained === ".." || isAbsolute(contained)) {
    throw new Error("Secure state escaped its directory");
  }
  return { directory, target };
}

function targetMetadata(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function assertSafeTarget(target: string): void {
  const metadata = targetMetadata(target);
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error("Unsafe secure state target");
  }
}

function boundedMaximum(maximumBytes: number): number {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Invalid secure state size limit");
  }
  return maximumBytes;
}

/** Writes one fixed user-data file without following links or exposing broad permissions. */
export function writeSecureAtomicState(
  path: string,
  value: string,
  maximumBytes: number,
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > boundedMaximum(maximumBytes)) {
    throw new Error("Secure state is too large");
  }
  const { directory, target } = statePaths(path);
  assertSafeTarget(target);
  let temporaryPath = join(
    directory,
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      FILE_MODE,
    );
    fchmodSync(descriptor, FILE_MODE);
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    // A link appearing after this check is replaced by rename rather than
    // followed. Refusing one already present keeps the boundary explicit.
    assertSafeTarget(target);
    renameSync(temporaryPath, target);
    temporaryPath = "";
    try {
      const directoryOnly = "O_DIRECTORY" in constants
        ? constants.O_DIRECTORY
        : 0;
      const directoryDescriptor = openSync(
        directory,
        constants.O_RDONLY | directoryOnly,
      );
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
      // Some platforms do not permit directory fsync; the file itself is safe.
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (temporaryPath) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the original write failure; cleanup must not mask it.
      }
    }
  }
}

/** Reads one bounded regular file through the same no-follow boundary. */
export function readSecureAtomicState(
  path: string,
  maximumBytes: number,
): string | null {
  const maximum = boundedMaximum(maximumBytes);
  const { target } = statePaths(path);
  const before = targetMetadata(target);
  if (!before) return null;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.size > maximum
  ) return null;
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(target, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) return null;
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) return null;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) return null;
    return bytes.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}
