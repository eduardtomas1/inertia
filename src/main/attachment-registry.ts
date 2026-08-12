import { randomUUID } from "node:crypto";
import {
  constants,
} from "node:fs";
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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { MAX_CHAT_ATTACHMENT_TOTAL_BYTES } from "../shared/attachments.js";
import type { ChatAttachment } from "../shared/contracts.js";
import type { TrustedRuntimeAttachment } from "../shared/runtime-attachments.js";
import {
  validateAttachmentImport,
  type ValidatedAttachmentImport,
} from "./attachment-import.js";

const MAX_SESSION_ATTACHMENT_RECORDS = 256;
const MAX_SESSION_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const ATTACHMENT_RELEASE_ATTEMPTS = 3;
const ATTACHMENT_RELEASE_RETRY_BASE_MS = 25;
// Renderer cleanup can cross the utility-process attachment claim while a
// submitted message is moving between IPC queues. Keep deletion revocable for
// one short turn of the event loop so the authoritative runtime resolve can
// adopt the capability without racing a stale renderer cleanup.
const ATTACHMENT_RELEASE_GRACE_MS = 250;
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
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp|gif|pdf|txt|md|csv|json)$/iu;

interface AttachmentRegistryRecord extends TrustedRuntimeAttachment {
  readonly extension: string;
}

interface PendingAttachmentRelease {
  readonly promise: Promise<boolean>;
  cancel(): void;
}

export interface ValidatedAttachmentPreview {
  readonly bytes: Buffer;
  readonly mimeType: ChatAttachment["mimeType"];
  readonly size: number;
}

interface ValidatedAttachmentRead {
  readonly attachment: TrustedRuntimeAttachment;
  readonly bytes: Buffer;
}

export interface AttachmentRegistryLimits {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly reservedRecords?: number;
  readonly reservedBytes?: number;
}

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

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function sameIdentity(
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

async function securePrivateDirectory(
  path: string,
  expectedParent?: string,
  options: AttachmentStorageSessionOptions = {},
): Promise<string> {
  const before = await lstat(path);
  assertOwnedDirectory(before);
  if (process.platform !== "win32") {
    const noFollow = "O_NOFOLLOW" in constants
      ? constants.O_NOFOLLOW
      : 0;
    const directoryOnly = "O_DIRECTORY" in constants
      ? constants.O_DIRECTORY
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

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("The attachment request was cancelled.");
}

function boundedLimit(value: number | undefined, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value), maximum))
    : maximum;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function waitForReleaseRetry(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, delayMs);
  });
}

async function unlinkWithRetry(
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

function fullReservation(): AttachmentStorageReservation {
  return {
    records: MAX_SESSION_ATTACHMENT_RECORDS,
    bytes: MAX_SESSION_ATTACHMENT_BYTES,
  };
}

export class AttachmentRegistry {
  private readonly records = new Map<string, AttachmentRegistryRecord>();
  private readonly releases = new Map<string, PendingAttachmentRelease>();
  private readonly revokedAttachmentIds = new Set<string>();
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly reservedRecords: number;
  private readonly reservedBytes: number;
  private importTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly directory: string,
    limits: AttachmentRegistryLimits = {},
    private readonly unlinkFile: (path: string) => Promise<void> = unlink,
    private readonly waitForRetry:
      (delayMs: number) => Promise<void> = waitForReleaseRetry,
  ) {
    this.maxRecords = boundedLimit(
      limits.maxRecords,
      MAX_SESSION_ATTACHMENT_RECORDS,
    );
    this.maxBytes = boundedLimit(
      limits.maxBytes,
      MAX_SESSION_ATTACHMENT_BYTES,
    );
    this.reservedRecords = Math.max(
      0,
      Math.min(Math.trunc(limits.reservedRecords ?? 0), this.maxRecords),
    );
    this.reservedBytes = Math.max(
      0,
      Math.min(Math.trunc(limits.reservedBytes ?? 0), this.maxBytes),
    );
  }

  usage(): AttachmentStorageReservation {
    return {
      records: this.reservedRecords + this.records.size,
      bytes: this.reservedBytes + [...this.records.values()].reduce(
        (total, { size }) => total + size,
        0,
      ),
    };
  }

  async import(values: readonly unknown[]): Promise<ChatAttachment[]> {
    if (this.disposed) {
      throw new Error("Temporary attachment storage is no longer available.");
    }
    let unlock = (): void => undefined;
    const previous = this.importTail;
    this.importTail = new Promise<void>((resolveImport) => {
      unlock = resolveImport;
    });
    await previous;
    try {
      return await this.importExclusive(values);
    } finally {
      unlock();
    }
  }

  private async importExclusive(
    values: readonly unknown[],
  ): Promise<ChatAttachment[]> {
    if (this.disposed) {
      throw new Error("Temporary attachment storage is no longer available.");
    }
    const validated = values.map(validateAttachmentImport);
    const deduplicated = validated.filter((attachment, index) =>
      validated.findIndex(({ digest }) => digest === attachment.digest) === index);
    const totalBytes = deduplicated.reduce((total, { size }) => total + size, 0);
    if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
      throw new Error("Attachments exceed the 20 MB turn limit.");
    }
    const retainedBytes = [...this.records.values()].reduce(
      (total, { size }) => total + size,
      0,
    );
    if (
      this.reservedRecords + this.records.size + deduplicated.length
        > this.maxRecords
      || this.reservedBytes + retainedBytes + totalBytes > this.maxBytes
    ) {
      throw new Error(
        "Temporary attachment storage is full. Remove an attachment and try again.",
      );
    }
    const registered: AttachmentRegistryRecord[] = [];
    try {
      for (const attachment of deduplicated) {
        registered.push(await this.persist(attachment));
      }
      return registered.map(({
        digest: _digest,
        extension: _extension,
        path: _path,
        ...attachment
      }) => ({
        ...attachment,
        path: attachment.id,
      }));
    } catch (error) {
      await Promise.all(registered.map(async (attachment) => {
        this.records.delete(attachment.id);
        await unlink(attachment.path).catch(() => undefined);
      }));
      throw error;
    }
  }

  async preview(
    id: string,
    signal?: AbortSignal,
  ): Promise<ValidatedAttachmentPreview | null> {
    const validated = await this.readValidated(id, signal);
    return validated
      ? {
          bytes: validated.bytes,
          mimeType: validated.attachment.mimeType,
          size: validated.attachment.size,
        }
      : null;
  }

  async resolve(
    id: string,
    signal?: AbortSignal,
  ): Promise<TrustedRuntimeAttachment | null> {
    return (await this.readValidated(id, signal))?.attachment ?? null;
  }

  /**
   * Claims a capability for an accepted runtime send. Unlike preview and
   * ordinary resolve operations, this may revoke a renderer cleanup that
   * crossed the runtime request in another IPC queue.
   */
  async resolveForRuntime(
    id: string,
    signal?: AbortSignal,
  ): Promise<TrustedRuntimeAttachment | null> {
    assertNotAborted(signal);
    this.cancelPendingRelease(id);
    return await this.resolve(id, signal);
  }

  private async readValidated(
    id: string,
    signal?: AbortSignal,
  ): Promise<ValidatedAttachmentRead | null> {
    assertNotAborted(signal);
    if (this.revokedAttachmentIds.has(id)) return null;
    const record = this.records.get(id);
    if (!record) return null;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.revokedAttachmentIds.has(id)) return null;
    const canonicalRoot = await realpath(this.directory);
    const pathInfo = await lstat(record.path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
      throw new Error("The registered attachment is not a safe regular file.");
    }
    const canonicalPath = await realpath(record.path);
    const expectedPath = join(canonicalRoot, `${record.id}.${record.extension}`);
    if (
      !isContained(canonicalRoot, canonicalPath)
      || canonicalPath !== expectedPath
      || basename(canonicalPath) !== `${record.id}.${record.extension}`
    ) {
      throw new Error("The registered attachment escaped its trusted directory.");
    }

    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const nonBlocking = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
    const file = await open(
      record.path,
      constants.O_RDONLY | noFollow | nonBlocking,
    );
    try {
      const before = await file.stat();
      if (
        !before.isFile()
        || !sameIdentity(pathInfo, before)
        || before.size !== record.size
      ) {
        throw new Error("The registered attachment changed after import.");
      }
      assertNotAborted(signal);
      const bytes = await file.readFile();
      const after = await file.stat();
      assertNotAborted(signal);
      if (
        after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
      ) {
        throw new Error("The registered attachment changed while it was read.");
      }
      const validated = validateAttachmentImport({
        name: record.name,
        mimeType: record.mimeType,
        data: bytes,
      });
      if (
        validated.mimeType !== record.mimeType
        || validated.size !== record.size
        || validated.digest !== record.digest
      ) {
        throw new Error("The registered attachment metadata no longer matches its content.");
      }
      return {
        attachment: {
          id: record.id,
          name: record.name,
          path: canonicalPath,
          mimeType: record.mimeType,
          size: record.size,
          digest: record.digest,
        },
        bytes,
      };
    } finally {
      await file.close();
    }
  }

  async release(id: string): Promise<boolean> {
    return await this.startRelease(id, false);
  }

  async releaseFromRenderer(id: string): Promise<boolean> {
    return await this.startRelease(id, true);
  }

  private async startRelease(
    id: string,
    allowRuntimeClaim: boolean,
  ): Promise<boolean> {
    const pending = this.releases.get(id);
    if (pending) return await pending.promise;
    const record = this.records.get(id);
    if (!record) return false;
    this.revokedAttachmentIds.add(id);
    let cancelRelease = (): void => undefined;
    const releasePromise = new Promise<boolean>((resolveRelease, rejectRelease) => {
      let settled = false;
      const beginRelease = () => {
        settled = true;
        void this.releaseRecord(record).then(resolveRelease, rejectRelease);
      };
      const timer = allowRuntimeClaim
        ? setTimeout(beginRelease, ATTACHMENT_RELEASE_GRACE_MS)
        : null;
      timer?.unref();
      cancelRelease = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveRelease(false);
      };
      if (!allowRuntimeClaim) beginRelease();
    });
    const release: PendingAttachmentRelease = {
      promise: releasePromise,
      cancel: cancelRelease,
    };
    this.releases.set(id, release);
    try {
      return await release.promise;
    } finally {
      if (this.releases.get(id) === release) {
        this.releases.delete(id);
      }
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = this.disposeExclusive();
    return this.disposal;
  }

  private async disposeExclusive(): Promise<void> {
    await this.importTail;
    const releases = [...this.releases.values()];
    for (const release of releases) release.cancel();
    await Promise.allSettled(releases.map(({ promise }) => promise));
    const records = [...this.records.values()];
    this.records.clear();
    this.revokedAttachmentIds.clear();
    await Promise.all(records.map(({ path }) =>
      unlink(path).catch(() => undefined)));
  }

  private cancelPendingRelease(id: string): void {
    const pending = this.releases.get(id);
    if (!pending) return;
    pending.cancel();
    if (this.releases.get(id) === pending) this.releases.delete(id);
    this.revokedAttachmentIds.delete(id);
  }

  private async releaseRecord(
    record: AttachmentRegistryRecord,
  ): Promise<boolean> {
    await unlinkWithRetry(record.path, this.unlinkFile, this.waitForRetry);
    if (this.records.get(record.id) === record) {
      this.records.delete(record.id);
    }
    this.revokedAttachmentIds.delete(record.id);
    return true;
  }

  private async persist(
    attachment: ValidatedAttachmentImport,
  ): Promise<AttachmentRegistryRecord> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const path = join(this.directory, `${id}.${attachment.extension}`);
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await file.writeFile(attachment.bytes);
    } finally {
      await file.close();
    }
    const record: AttachmentRegistryRecord = {
      id,
      name: attachment.displayName,
      path,
      mimeType: attachment.mimeType,
      size: attachment.size,
      digest: attachment.digest,
      extension: attachment.extension,
    };
    this.records.set(id, record);
    return record;
  }
}
