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

import {
  FILE_OPEN_DIRECTORY,
  FILE_OPEN_NO_FOLLOW,
} from "../node/platform-file-open-flags.js";

const FILE_MODE = 0o600;

export interface SecureAtomicStatePaths {
  directory: string;
  target: string;
}

export type SecureAtomicStateReadErrorCode =
  | "changed"
  | "io"
  | "permission"
  | "too-large"
  | "unsafe";

export class SecureAtomicStateReadError extends Error {
  constructor(
    readonly code: SecureAtomicStateReadErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "SecureAtomicStateReadError";
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function resolveSecureAtomicStatePaths(
  path: string,
): SecureAtomicStatePaths {
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

function classifiedReadError(error: unknown): SecureAtomicStateReadError {
  if (error instanceof SecureAtomicStateReadError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    return new SecureAtomicStateReadError(
      "permission",
      "Secure state could not be read because access was denied",
      { cause: error },
    );
  }
  if (code === "ELOOP" || code === "ENOTDIR") {
    return new SecureAtomicStateReadError(
      "unsafe",
      "Secure state crossed an unsafe filesystem boundary",
      { cause: error },
    );
  }
  return new SecureAtomicStateReadError(
    "io",
    "Secure state could not be read",
    { cause: error },
  );
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
  const { directory, target } = resolveSecureAtomicStatePaths(path);
  assertSafeTarget(target);
  let temporaryPath = join(
    directory,
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
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
        ? FILE_OPEN_DIRECTORY
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
  try {
    return readSecureAtomicStateStrict(path, maximumBytes);
  } catch (error) {
    if (
      error instanceof SecureAtomicStateReadError
      && (
        error.code === "changed"
        || error.code === "too-large"
        || error.code === "unsafe"
      )
    ) return null;
    throw error;
  }
}

/**
 * Strict variant used for durable user state where missing, damaged, unsafe,
 * and temporarily unreadable files must remain distinguishable.
 */
export function readSecureAtomicStateStrict(
  path: string,
  maximumBytes: number,
): string | null {
  const maximum = boundedMaximum(maximumBytes);
  let descriptor: number | null = null;
  try {
    const { target } = resolveSecureAtomicStatePaths(path);
    const before = targetMetadata(target);
    if (!before) return null;
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new SecureAtomicStateReadError(
        "unsafe",
        "Secure state is not a regular local file",
      );
    }
    if (before.size > maximum) {
      throw new SecureAtomicStateReadError(
        "too-large",
        "Secure state exceeds its size limit",
      );
    }
    const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
    descriptor = openSync(target, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
    ) {
      throw new SecureAtomicStateReadError(
        "changed",
        "Secure state changed while it was being opened",
      );
    }
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
      if (count === 0) {
        throw new SecureAtomicStateReadError(
          "changed",
          "Secure state ended before the verified size",
        );
      }
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new SecureAtomicStateReadError(
        "changed",
        "Secure state changed while it was being read",
      );
    }
    return bytes.toString("utf8");
  } catch (error) {
    throw classifiedReadError(error);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}
