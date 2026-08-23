import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
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

import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
} from "../shared/attachments.js";
import type { ChatAttachment } from "../shared/contracts.js";
import type { TrustedRuntimeAttachment } from "../shared/runtime-attachments.js";
import {
  prepareAttachmentImport,
  prepareAttachmentImportMetadata,
  type PreparedAttachmentImport,
  type PreparedAttachmentMetadata,
} from "./attachment-import.js";
import {
  inProcessAttachmentImportValidationRunner,
  type AttachmentImportFileOperation,
  type AttachmentImportValidationReceipt,
  type AttachmentImportValidationRunner,
} from "./attachment-import-file.js";

const MAX_SESSION_ATTACHMENT_RECORDS = 256;
const MAX_SESSION_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const ATTACHMENT_RELEASE_ATTEMPTS = 3;
const ATTACHMENT_RELEASE_RETRY_BASE_MS = 25;
const ATTACHMENT_HANDOFF_TIMEOUT_MS = 210_000;
const MAX_PENDING_IMPORT_BYTES = MAX_CHAT_ATTACHMENT_TOTAL_BYTES;
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
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp|gif|pdf|txt|md|csv|json|xlsx|xls)$/iu;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface AttachmentRegistryRecord extends TrustedRuntimeAttachment {
  readonly extension: string;
}

interface PendingAttachmentRelease {
  readonly promise: Promise<boolean>;
  begin(): boolean;
  cancel(): boolean;
}

interface PendingAttachmentHandoff {
  readonly attachmentIds: Set<string>;
  readonly timer: ReturnType<typeof setTimeout>;
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
  readonly validationRunner?: AttachmentImportValidationRunner;
  /** Test-only worker delay used by real Electron responsiveness coverage. */
  readonly validationDelayMs?: number;
}

export interface AttachmentImportWriter {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  write(
    destination: FileHandle,
    signal: AbortSignal,
  ): Promise<void>;
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

function isStablePrivateAttachment(
  before: BigIntStats,
  after: BigIntStats,
): boolean {
  return before.isFile()
    && after.isFile()
    && !before.isSymbolicLink()
    && !after.isSymbolicLink()
    && before.nlink === 1n
    && after.nlink === 1n
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
    && (
      process.platform === "win32"
      || (
        (before.mode & 0o777n) === 0o600n
        && (after.mode & 0o777n) === 0o600n
        && (
          typeof process.getuid !== "function"
          || (
            before.uid === BigInt(process.getuid())
            && after.uid === BigInt(process.getuid())
          )
        )
      )
    );
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

function validateSelectedImportCount(count: number): void {
  if (
    !Number.isSafeInteger(count)
    || count < 0
    || count > MAX_CHAT_ATTACHMENTS
  ) throw new Error(`Select at most ${MAX_CHAT_ATTACHMENTS} attachments.`);
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
  private readonly handoffs = new Map<string, PendingAttachmentHandoff>();
  private readonly attachmentHandoffs = new Map<string, Set<string>>();
  private readonly revokedAttachmentIds = new Set<string>();
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly reservedRecords: number;
  private readonly reservedBytes: number;
  private readonly validationRunner: AttachmentImportValidationRunner;
  private readonly validationDelayMs: number;
  private readonly lifecycle = new AbortController();
  private readonly pendingPaths = new Map<string, number>();
  private pendingImportBytes = 0;
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
    this.validationRunner = limits.validationRunner
      ?? inProcessAttachmentImportValidationRunner;
    this.validationDelayMs = process.env.NODE_ENV === "test"
      && typeof limits.validationDelayMs === "number"
      && Number.isFinite(limits.validationDelayMs)
      ? Math.max(
          0,
          Math.min(Math.trunc(limits.validationDelayMs ?? 0), 60_000),
        )
      : 0;
  }

  usage(): AttachmentStorageReservation {
    return {
      records: this.reservedRecords
        + this.records.size
        + this.pendingPaths.size,
      bytes: this.reservedBytes + [...this.records.values()].reduce(
        (total, { size }) => total + size,
        [...this.pendingPaths.values()].reduce(
          (total, size) => total + size,
          0,
        ),
      ),
    };
  }

  async prepareHandoff(
    handoffId: string,
    attachmentIds: readonly string[],
    runtimeOwnsAttachment: (attachmentId: string) => boolean,
  ): Promise<void> {
    if (
      this.disposed
      || !UUID_PATTERN.test(handoffId)
      || attachmentIds.length < 1
      || attachmentIds.length > MAX_CHAT_ATTACHMENTS
      || new Set(attachmentIds).size !== attachmentIds.length
      || attachmentIds.some((id) => !UUID_PATTERN.test(id))
    ) {
      throw new Error("Invalid attachment handoff.");
    }
    await this.importTail;
    if (this.disposed || this.handoffs.has(handoffId)) {
      throw new Error("Attachment handoff is unavailable.");
    }
    // This check and the supersession below intentionally remain synchronous
    // after import serialization. Runtime claims are recorded synchronously in
    // the main-process coordinator, so the event loop orders an old claim
    // either before this check (and rejects the retry) or after supersession
    // (and the old token can no longer resolve).
    for (const id of attachmentIds) {
      if (
        !this.records.has(id)
        || this.revokedAttachmentIds.has(id)
        || this.releases.has(id)
        || runtimeOwnsAttachment(id)
      ) {
        throw new Error("Attachment handoff is unavailable.");
      }
    }
    const supersededHandoffIds = new Set(attachmentIds.flatMap((id) =>
      [...this.attachmentHandoffs.get(id) ?? []]));
    for (const oldHandoffId of supersededHandoffIds) {
      const oldHandoff = this.handoffs.get(oldHandoffId);
      if ([...(oldHandoff?.attachmentIds ?? [])].some(runtimeOwnsAttachment)) {
        throw new Error("Attachment handoff is unavailable.");
      }
    }
    // A retry after ambiguous transport delivery is the renderer's explicit
    // reconciliation signal. Once no part of an intersecting old handoff is
    // runtime-owned, invalidate its entire token before installing the new
    // one; a late old resolve will then fail closed.
    this.retireAttachmentHandoffs(attachmentIds);
    const handoff: PendingAttachmentHandoff = {
      attachmentIds: new Set(attachmentIds),
      timer: setTimeout(
        () => this.finishHandoff(handoffId),
        ATTACHMENT_HANDOFF_TIMEOUT_MS,
      ),
    };
    handoff.timer.unref();
    this.handoffs.set(handoffId, handoff);
    for (const id of attachmentIds) {
      this.attachmentHandoffs.set(id, new Set([handoffId]));
    }
  }

  finishHandoff(handoffId: string): void {
    const handoff = this.handoffs.get(handoffId);
    if (!handoff) return;
    this.handoffs.delete(handoffId);
    clearTimeout(handoff.timer);
    for (const id of handoff.attachmentIds) {
      this.detachHandoffAttachment(handoffId, id);
      if (!this.attachmentHandoffs.has(id)) {
        this.releases.get(id)?.begin();
      }
    }
  }

  async import(
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<ChatAttachment[]> {
    validateSelectedImportCount(values.length);
    if (values.length === 0) return [];
    const prepared = values.map(prepareAttachmentImport);
    const pendingBytes = prepared.reduce((total, { size }) => total + size, 0);
    return await this.serializeImport(
      pendingBytes,
      async (operationSignal) =>
        await this.importPrepared(prepared, operationSignal),
      signal,
    );
  }

  async importFromWriter(
    source: AttachmentImportWriter,
    signal?: AbortSignal,
    batchDigests?: Set<string>,
  ): Promise<ChatAttachment | null> {
    const prepared = prepareAttachmentImportMetadata(source);
    const imported = await this.serializeImport(
      prepared.size,
      async (operationSignal) => await this.importPreparedWriters([{
        prepared,
        write: source.write,
      }], operationSignal, batchDigests),
      signal,
    );
    const attachment = imported[0];
    if (!attachment && batchDigests) return null;
    if (!attachment) throw new Error("Attachment import did not complete.");
    return attachment;
  }

  private async serializeImport<T>(
    pendingBytes: number,
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed || externalSignal?.aborted) {
      throw new Error("Temporary attachment storage is no longer available.");
    }
    if (
      !Number.isSafeInteger(pendingBytes)
      || pendingBytes < 1
      || pendingBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES
    ) throw new Error("Attachments exceed the 20 MB turn limit.");
    if (this.pendingImportBytes + pendingBytes > MAX_PENDING_IMPORT_BYTES) {
      throw new Error("Attachment import is busy. Try again in a moment.");
    }
    this.pendingImportBytes += pendingBytes;
    let unlock = (): void => undefined;
    const previous = this.importTail;
    this.importTail = new Promise<void>((resolveImport) => {
      unlock = resolveImport;
    });
    await previous;
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, this.lifecycle.signal])
      : this.lifecycle.signal;
    try {
      signal.throwIfAborted();
      if (this.disposed) {
        throw new Error("Temporary attachment storage is no longer available.");
      }
      return await operation(signal);
    } finally {
      this.pendingImportBytes -= pendingBytes;
      unlock();
    }
  }

  private async importPrepared(
    prepared: readonly PreparedAttachmentImport[],
    signal: AbortSignal,
  ): Promise<ChatAttachment[]> {
    return await this.importPreparedWriters(prepared.map((attachment) => ({
      prepared: attachment,
      write: async (destination: FileHandle): Promise<void> => {
        await destination.writeFile(attachment.bytes);
      },
    })), signal);
  }

  private async importPreparedWriters(
    sources: readonly {
      readonly prepared: PreparedAttachmentMetadata;
      readonly write: (
        destination: FileHandle,
        signal: AbortSignal,
      ) => Promise<void>;
    }[],
    signal: AbortSignal,
    digests = new Set<string>(),
  ): Promise<ChatAttachment[]> {
    const registered: AttachmentRegistryRecord[] = [];
    let totalBytes = 0;
    try {
      for (const source of sources) {
        signal.throwIfAborted();
        this.assertStorageCapacity(source.prepared.size);
        const attachment = await this.persistAndValidate(
          source.prepared,
          source.write,
          signal,
        );
        if (digests.has(attachment.digest)) {
          await this.rollbackRecord(attachment);
          continue;
        }
        digests.add(attachment.digest);
        totalBytes += attachment.size;
        if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
          await this.rollbackRecord(attachment);
          throw new Error("Attachments exceed the 20 MB turn limit.");
        }
        registered.push(attachment);
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
      await Promise.all(registered.map(async (attachment) =>
        await this.rollbackRecord(attachment)));
      throw error;
    }
  }

  private assertStorageCapacity(additionalBytes: number): void {
    const retainedBytes = [...this.records.values()].reduce(
      (total, { size }) => total + size,
      [...this.pendingPaths.values()].reduce(
        (total, size) => total + size,
        0,
      ),
    );
    if (
      this.reservedRecords
        + this.records.size
        + this.pendingPaths.size
        + 1 > this.maxRecords
      || this.reservedBytes + retainedBytes + additionalBytes > this.maxBytes
    ) {
      throw new Error(
        "Temporary attachment storage is full. Remove an attachment and try again.",
      );
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
   * Claims a capability for exactly one renderer-prepared message send. The
   * send request UUID binds the cross-IPC handoff, so an unrelated runtime
   * resolve cannot revive a genuine renderer deletion.
   */
  async resolveForRuntime(
    id: string,
    handoffId: string,
    signal?: AbortSignal,
  ): Promise<TrustedRuntimeAttachment | null> {
    assertNotAborted(signal);
    if (!this.consumeHandoff(handoffId, id)) return null;
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
    const operationSignal = signal
      ? AbortSignal.any([signal, this.lifecycle.signal])
      : this.lifecycle.signal;
    let receipt: AttachmentImportValidationReceipt;
    try {
      receipt = await this.validateStoredFile(
        record.path,
        {
          displayName: record.name,
          mimeType: record.mimeType,
          extension: record.extension,
          size: record.size,
        },
        operationSignal,
        false,
      );
    } catch {
      assertNotAborted(operationSignal);
      throw new Error("The registered attachment changed after import.");
    }
    if (
      receipt.displayName !== record.name
      || receipt.mimeType !== record.mimeType
      || receipt.extension !== record.extension
      || receipt.size !== record.size
      || receipt.digest !== record.digest
    ) {
      throw new Error("The registered attachment metadata no longer matches its content.");
    }
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
      assertNotAborted(operationSignal);
      const bytes = await file.readFile();
      const after = await file.stat();
      assertNotAborted(operationSignal);
      if (
        after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
      ) {
        throw new Error("The registered attachment changed while it was read.");
      }
      if (
        createHash("sha256").update(bytes).digest("hex") !== record.digest
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
    return await this.startRelease(id, true);
  }

  async rollback(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    await this.rollbackRecord(record);
  }

  async releaseFromRenderer(id: string): Promise<boolean> {
    try {
      return await this.startRelease(id, !this.attachmentHandoffs.has(id));
    } catch (error) {
      const record = this.records.get(id);
      if (record) this.retireForPendingCleanup(record);
      throw error;
    }
  }

  private async startRelease(
    id: string,
    beginImmediately: boolean,
  ): Promise<boolean> {
    const pending = this.releases.get(id);
    if (pending) {
      if (beginImmediately) pending.begin();
      return await pending.promise;
    }
    const record = this.records.get(id);
    if (!record) return false;
    this.revokedAttachmentIds.add(id);
    let beginRelease = (): boolean => false;
    let cancelRelease = (): boolean => false;
    const releasePromise = new Promise<boolean>((resolveRelease, rejectRelease) => {
      let settled = false;
      beginRelease = () => {
        if (settled) return false;
        settled = true;
        void this.releaseRecord(record).then(resolveRelease, rejectRelease);
        return true;
      };
      cancelRelease = () => {
        if (settled) return false;
        settled = true;
        resolveRelease(false);
        return true;
      };
    });
    const release: PendingAttachmentRelease = {
      promise: releasePromise,
      begin: beginRelease,
      cancel: cancelRelease,
    };
    this.releases.set(id, release);
    if (beginImmediately) release.begin();
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
    this.lifecycle.abort();
    this.disposal = this.disposeExclusive();
    return this.disposal;
  }

  private async disposeExclusive(): Promise<void> {
    await this.importTail;
    const validationStopped = await this.validationRunner.shutdown?.() ?? true;
    if (!validationStopped) {
      throw new Error("Attachment validation utility shutdown is unconfirmed.");
    }
    for (const handoff of this.handoffs.values()) clearTimeout(handoff.timer);
    this.handoffs.clear();
    this.attachmentHandoffs.clear();
    const releases = [...this.releases.values()];
    for (const release of releases) release.cancel();
    await Promise.allSettled(releases.map(({ promise }) => promise));
    const records = [...this.records.values()];
    const pendingPaths = [...this.pendingPaths.keys()];
    this.records.clear();
    this.pendingPaths.clear();
    this.revokedAttachmentIds.clear();
    await Promise.all([...records.map(({ path }) => path), ...pendingPaths]
      .map((path) => unlink(path).catch(() => undefined)));
  }

  private cancelPendingRelease(id: string): boolean {
    const pending = this.releases.get(id);
    if (!pending || !pending.cancel()) return false;
    if (this.releases.get(id) === pending) this.releases.delete(id);
    this.revokedAttachmentIds.delete(id);
    return true;
  }

  private consumeHandoff(handoffId: string, attachmentId: string): boolean {
    const handoff = this.handoffs.get(handoffId);
    if (!handoff?.attachmentIds.has(attachmentId)) return false;
    const pending = this.releases.get(attachmentId);
    if (pending && !this.cancelPendingRelease(attachmentId)) return false;
    handoff.attachmentIds.delete(attachmentId);
    this.detachHandoffAttachment(handoffId, attachmentId);
    if (handoff.attachmentIds.size === 0) {
      this.handoffs.delete(handoffId);
      clearTimeout(handoff.timer);
    }
    return true;
  }

  private detachHandoffAttachment(
    handoffId: string,
    attachmentId: string,
  ): void {
    const handoffs = this.attachmentHandoffs.get(attachmentId);
    handoffs?.delete(handoffId);
    if (handoffs?.size === 0) this.attachmentHandoffs.delete(attachmentId);
  }

  private retireAttachmentHandoffs(attachmentIds: readonly string[]): void {
    const handoffIds = new Set(attachmentIds.flatMap((attachmentId) =>
      [...this.attachmentHandoffs.get(attachmentId) ?? []]));
    for (const handoffId of handoffIds) {
      const handoff = this.handoffs.get(handoffId);
      if (!handoff) continue;
      this.handoffs.delete(handoffId);
      clearTimeout(handoff.timer);
      for (const attachmentId of handoff.attachmentIds) {
        this.detachHandoffAttachment(handoffId, attachmentId);
        if (!this.attachmentHandoffs.has(attachmentId)) {
          this.releases.get(attachmentId)?.begin();
        }
      }
    }
  }

  private dropAttachmentHandoffs(attachmentId: string): void {
    const handoffIds = this.attachmentHandoffs.get(attachmentId);
    this.attachmentHandoffs.delete(attachmentId);
    for (const handoffId of handoffIds ?? []) {
      const handoff = this.handoffs.get(handoffId);
      handoff?.attachmentIds.delete(attachmentId);
      if (handoff?.attachmentIds.size === 0) {
        this.handoffs.delete(handoffId);
        clearTimeout(handoff.timer);
      }
    }
  }

  private async releaseRecord(
    record: AttachmentRegistryRecord,
  ): Promise<boolean> {
    await unlinkWithRetry(record.path, this.unlinkFile, this.waitForRetry);
    if (this.records.get(record.id) === record) {
      this.records.delete(record.id);
    }
    this.dropAttachmentHandoffs(record.id);
    this.revokedAttachmentIds.delete(record.id);
    return true;
  }

  private async rollbackRecord(
    record: AttachmentRegistryRecord,
  ): Promise<void> {
    try {
      await this.releaseRecord(record);
    } catch {
      // The capability was never published to its caller, so it cannot be
      // retried through release. Retire it while conservatively retaining its
      // quota until disposal or restart cleanup can unlink the private file.
      this.retireForPendingCleanup(record);
    }
  }

  private retireForPendingCleanup(record: AttachmentRegistryRecord): void {
    if (this.records.get(record.id) === record) {
      this.records.delete(record.id);
    }
    this.dropAttachmentHandoffs(record.id);
    this.revokedAttachmentIds.delete(record.id);
    this.pendingPaths.set(record.path, record.size);
  }

  private async persistAndValidate(
    attachment: PreparedAttachmentMetadata,
    write: (
      destination: FileHandle,
      signal: AbortSignal,
    ) => Promise<void>,
    signal: AbortSignal,
  ): Promise<AttachmentRegistryRecord> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const path = join(this.directory, `${id}.${attachment.extension}`);
    const file = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    this.pendingPaths.set(path, attachment.size);
    try {
      try {
        await write(file, signal);
      } finally {
        await file.close();
      }
      signal.throwIfAborted();
      const receipt = await this.validateStoredFile(
        path,
        attachment,
        signal,
        true,
      );
      if (
        receipt.displayName !== attachment.displayName
        || receipt.mimeType !== attachment.mimeType
        || receipt.extension !== attachment.extension
        || receipt.size !== attachment.size
      ) {
        throw new Error(
          "Temporary attachment storage could not be verified safely.",
        );
      }
      signal.throwIfAborted();
      const record: AttachmentRegistryRecord = {
        id,
        name: receipt.displayName,
        path,
        mimeType: receipt.mimeType,
        size: receipt.size,
        digest: receipt.digest,
        extension: receipt.extension,
      };
      this.records.set(id, record);
      this.pendingPaths.delete(path);
      return record;
    } catch (error) {
      const removed = await unlinkWithRetry(
        path,
        this.unlinkFile,
        this.waitForRetry,
      ).then(() => true, () => false);
      if (removed) this.pendingPaths.delete(path);
      throw error;
    }
  }

  private async validateStoredFile(
    path: string,
    attachment: PreparedAttachmentMetadata,
    signal: AbortSignal,
    allowTestDelay: boolean,
  ): Promise<AttachmentImportValidationReceipt> {
    signal.throwIfAborted();
    const root = await securePrivateDirectory(this.directory);
    const rootInfo = await lstat(root, { bigint: true });
    const [before, canonicalPath] = await Promise.all([
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    const expectedPath = join(root, basename(path));
    if (
      !isStablePrivateAttachment(before, before)
      || before.size !== BigInt(attachment.size)
      || canonicalPath !== expectedPath
      || dirname(canonicalPath) !== root
    ) {
      throw new Error(
        "Temporary attachment storage could not be verified safely.",
      );
    }
    const operation: AttachmentImportFileOperation = {
      root,
      rootDev: String(rootInfo.dev),
      rootIno: String(rootInfo.ino),
      rootUid: process.platform === "win32" ? null : String(rootInfo.uid),
      fileName: basename(path),
      name: attachment.displayName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      stallBeforeValidationMs: allowTestDelay
        ? this.validationDelayMs
        : 0,
    };
    const validation = this.validationRunner(operation, signal);
    let receipt: AttachmentImportValidationReceipt | null = null;
    let resultError: unknown;
    try {
      receipt = await validation.result;
    } catch (error) {
      resultError = error;
    }
    await validation.stopped;
    if (resultError) throw resultError;
    if (!receipt) {
      throw new Error("Attachment validation utility returned no result.");
    }
    signal.throwIfAborted();
    const verifiedRoot = await securePrivateDirectory(this.directory);
    const [after, verifiedPath] = await Promise.all([
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    if (
      verifiedRoot !== root
      || !isStablePrivateAttachment(before, after)
      || verifiedPath !== join(verifiedRoot, basename(path))
      || dirname(verifiedPath) !== verifiedRoot
    ) {
      throw new Error(
        "Temporary attachment storage could not be verified safely.",
      );
    }
    return receipt;
  }
}
