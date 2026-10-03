import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  FILE_OPEN_DIRECTORY,
  FILE_OPEN_NO_FOLLOW,
} from "../node/platform-file-open-flags.js";

export const MAX_SESSION_ATTACHMENT_RECORDS = 1_024;
export const TEMPORARY_ATTACHMENT_STORAGE_FULL =
  "Temporary attachment storage is full. Remove an attachment and try again.";
export const MAX_SESSION_ATTACHMENT_BYTES = 16 * 1024 * 1024 * 1024;
const ATTACHMENT_RELEASE_ATTEMPTS = 3;
const ATTACHMENT_RELEASE_RETRY_BASE_MS = 25;
const ATTACHMENT_SESSION_PREFIX = "session-";
const ATTACHMENT_SESSION_DIRECTORY =
  /^session-[A-Za-z0-9_-]{6}$/u;
const TRANSIENT_UNLINK_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
  "ETXTBSY",
]);
const OWNED_ATTACHMENT_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp|gif|pdf|txt|md|csv|json|xlsx|xls|bin)$/iu;

export interface AttachmentStorageReservation {
  readonly records: number;
  readonly bytes: number;
}

export interface AttachmentStorageSession {
  readonly directory: string;
  readonly reservation: AttachmentStorageReservation;
}

export interface AttachmentStorageSessionOptions {
  /** Inventory prior sessions without unlinking while provider cleanup is unconfirmed. */
  readonly preserveExisting?: boolean;
  readonly openDirectory?: (
    path: string,
    flags: number,
  ) => Promise<FileHandle>;
  readonly chmodDirectory?: (
    directory: FileHandle,
    mode: number,
  ) => Promise<void>;
}

interface OrphanCleanupOptions {
  readonly preserveExisting?: boolean;
  readonly readDirectory?: (directory: string) => Promise<string[]>;
  readonly inspectFile?: (path: string) => ReturnType<typeof lstat>;
  readonly unlinkFile?: (path: string) => Promise<void>;
  readonly waitForRetry?: (delayMs: number) => Promise<void>;
}

export async function cleanupOrphanedAttachments(
  directory: string,
  options: OrphanCleanupOptions = {},
): Promise<AttachmentStorageReservation> {
  const readDirectory = options.readDirectory ?? readdir;
  const inspectFile = options.inspectFile ?? lstat;
  const unlinkFile = options.unlinkFile ?? unlink;
  const waitForRetry = options.waitForRetry ?? waitForReleaseRetry;
  let entries: string[];
  try {
    entries = await readDirectory(directory);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { records: 0, bytes: 0 }
      : fullReservation();
  }
  let records = 0;
  let bytes = 0;
  for (const name of entries) {
    if (!OWNED_ATTACHMENT_FILE.test(name)) continue;
    const path = join(directory, name);
    try {
      const info = await inspectFile(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        if (options.preserveExisting) return fullReservation();
        try {
          await unlinkWithRetry(path, unlinkFile, waitForRetry);
        } catch {
          return fullReservation();
        }
        continue;
      }
      if (options.preserveExisting) {
        records += 1;
        const size = typeof info.size === "bigint"
          ? info.size >= BigInt(MAX_SESSION_ATTACHMENT_BYTES)
            ? MAX_SESSION_ATTACHMENT_BYTES
            : Number(info.size)
          : info.size;
        bytes += Math.max(0, size);
        continue;
      }
      try {
        await unlinkWithRetry(path, unlinkFile, waitForRetry);
      } catch {
        records += 1;
        const size = typeof info.size === "bigint"
          ? info.size >= BigInt(MAX_SESSION_ATTACHMENT_BYTES)
            ? MAX_SESSION_ATTACHMENT_BYTES
            : Number(info.size)
          : info.size;
        bytes += Math.max(0, size);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return fullReservation();
    }
  }
  return {
    records: Math.min(records, MAX_SESSION_ATTACHMENT_RECORDS),
    bytes: Math.min(bytes, MAX_SESSION_ATTACHMENT_BYTES),
  };
}

export function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedDirectory(
  info: Awaited<ReturnType<typeof lstat>>,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Temporary attachment storage is not a safe directory.");
  }
  if (
    typeof process.getuid === "function"
    && info.uid !== process.getuid()
  ) {
    throw new Error("Temporary attachment storage has an unexpected owner.");
  }
}

export async function securePrivateDirectory(
  path: string,
  expectedParent?: string,
  options: AttachmentStorageSessionOptions = {},
): Promise<string> {
  const before = await lstat(path);
  assertOwnedDirectory(before);
  if (process.platform !== "win32") {
    const noFollow = "O_NOFOLLOW" in constants
      ? FILE_OPEN_NO_FOLLOW
      : 0;
    const directoryOnly = "O_DIRECTORY" in constants
      ? FILE_OPEN_DIRECTORY
      : 0;
    const directory = await (options.openDirectory ?? open)(
      path,
      constants.O_RDONLY | noFollow | directoryOnly,
    );
    try {
      const pinnedBefore = await directory.stat();
      assertOwnedDirectory(pinnedBefore);
      if (!sameIdentity(before, pinnedBefore)) {
        throw new Error("Temporary attachment storage changed before it was secured.");
      }
      await (options.chmodDirectory
        ?? ((handle, mode) => handle.chmod(mode)))(directory, 0o700);
      const pinnedAfter = await directory.stat();
      if (
        !pinnedAfter.isDirectory()
        || !sameIdentity(pinnedBefore, pinnedAfter)
        || (pinnedAfter.mode & 0o777) !== 0o700
        || (
          typeof process.getuid === "function"
          && pinnedAfter.uid !== process.getuid()
        )
      ) {
        throw new Error("Temporary attachment storage could not be secured.");
      }
    } finally {
      await directory.close();
    }
  }
  const canonical = await realpath(path);
  const named = await lstat(path);
  const after = await stat(canonical);
  if (
    named.isSymbolicLink()
    || !named.isDirectory()
    || !after.isDirectory()
    || !sameIdentity(before, after)
    || !sameIdentity(named, after)
    || (
      process.platform !== "win32"
      && (after.mode & 0o777) !== 0o700
    )
    || (
      typeof process.getuid === "function"
      && after.uid !== process.getuid()
    )
    || (
      expectedParent !== undefined
      && (
        dirname(canonical) !== expectedParent
        || !isContained(expectedParent, canonical)
      )
    )
  ) {
    throw new Error("Temporary attachment storage could not be secured.");
  }
  return canonical;
}

function addReservation(
  left: AttachmentStorageReservation,
  right: AttachmentStorageReservation,
): AttachmentStorageReservation {
  return {
    records: Math.min(
      left.records + right.records,
      MAX_SESSION_ATTACHMENT_RECORDS,
    ),
    bytes: Math.min(
      left.bytes + right.bytes,
      MAX_SESSION_ATTACHMENT_BYTES,
    ),
  };
}

async function cleanupOrphanedSessions(
  root: string,
  options: AttachmentStorageSessionOptions = {},
): Promise<AttachmentStorageReservation> {
  // An unconfirmed prior runtime can still add or grow files after any
  // inventory. Preserve its bytes and reserve the entire shared ceiling.
  if (options.preserveExisting) return fullReservation();
  let reservation = await cleanupOrphanedAttachments(root, {
    preserveExisting: false,
  });
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return fullReservation();
  }
  for (const name of names) {
    if (!ATTACHMENT_SESSION_DIRECTORY.test(name)) continue;
    let directory: string;
    try {
      directory = await securePrivateDirectory(join(root, name), root, options);
    } catch {
      return fullReservation();
    }
    const orphaned = await cleanupOrphanedAttachments(directory, {
      preserveExisting: false,
    });
    reservation = addReservation(reservation, orphaned);
    if (orphaned.records > 0 || orphaned.bytes > 0) continue;
    try {
      await rmdir(directory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return fullReservation();
    }
  }
  return reservation;
}

export async function createAttachmentStorageSession(
  rootDirectory: string,
  options: AttachmentStorageSessionOptions = {},
): Promise<AttachmentStorageSession> {
  const requestedRoot = resolve(rootDirectory);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const root = await securePrivateDirectory(requestedRoot, undefined, options);
  const reservation = await cleanupOrphanedSessions(root, options);
  const created = await mkdtemp(join(root, ATTACHMENT_SESSION_PREFIX));
  try {
    return {
      directory: await securePrivateDirectory(created, root, options),
      reservation,
    };
  } catch (error) {
    await rmdir(created).catch(() => undefined);
    throw error;
  }
}

export async function removeAttachmentStorageSession(
  directory: string,
): Promise<void> {
  try {
    const canonical = await securePrivateDirectory(resolve(directory));
    await rmdir(canonical);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

export function temporaryStorageWriteError(error: unknown): unknown {
  const code = errorCode(error);
  return code === "ENOSPC" || code === "EDQUOT"
    ? new Error(TEMPORARY_ATTACHMENT_STORAGE_FULL)
    : error;
}

export function waitForReleaseRetry(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, delayMs);
  });
}

export async function unlinkWithRetry(
  path: string,
  unlinkFile: (path: string) => Promise<void>,
  waitForRetry: (delayMs: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < ATTACHMENT_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await unlinkFile(path);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return;
      if (
        !code
        || !TRANSIENT_UNLINK_CODES.has(code)
        || attempt === ATTACHMENT_RELEASE_ATTEMPTS - 1
      ) {
        throw error;
      }
      await waitForRetry(ATTACHMENT_RELEASE_RETRY_BASE_MS * 2 ** attempt);
    }
  }
}
function fullReservation(): AttachmentStorageReservation { return { records: MAX_SESSION_ATTACHMENT_RECORDS, bytes: MAX_SESSION_ATTACHMENT_BYTES }; }
