import { readAttachment } from "../node/read-attachment.js";
import { snapshotSourceSchema, type SnapshotSource } from "../shared/snapshots.js";
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
} from "node:path";

import {
  FILE_OPEN_NO_FOLLOW,
} from "../node/platform-file-open-flags.js";
import { MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_TOTAL_BYTES } from "../shared/attachments.js";
import type { ChatAttachment } from "../shared/contracts.js";
import type { TrustedRuntimeAttachment } from "../shared/runtime-attachments.js";
import {
  prepareAttachmentImport,
  prepareAttachmentImportMetadata,
  type PreparedAttachmentImport,
  type PreparedAttachmentMetadata,
} from "./attachment-import.js";
import { attachmentPreviewLimit, assertAttachmentImportReceipt } from "./attachment-registry-file-verification.js";
import { isStablePrivateAttachment, verifyPinnedAttachmentDirectory,
  verifyStoredAttachmentAfterValidation } from "./attachment-registry-file-verification.js";
import {
  inProcessAttachmentImportValidationRunner,
  type AttachmentImportFileOperation,
  type AttachmentImportValidationReceipt,
  type AttachmentImportValidationRunner,
} from "./attachment-import-file.js";
import { RendererAttachmentImportHolds } from "./attachment-import-holds.js";
import { availableAttachmentDiskBytes } from "../node/conversation-attachment-storage-management.js";
import { ATTACHMENT_DISK_RESERVE_BYTES } from "../shared/attachment-storage.js";
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  MAX_SESSION_ATTACHMENT_RECORDS,
  TEMPORARY_ATTACHMENT_STORAGE_FULL,
  isContained,
  sameIdentity,
  securePrivateDirectory,
  temporaryStorageWriteError,
  unlinkWithRetry,
  waitForReleaseRetry,
  type AttachmentStorageReservation,
} from "./attachment-storage-session.js";

export {
  cleanupOrphanedAttachments,
  createAttachmentStorageSession,
  removeAttachmentStorageSession,
  type AttachmentStorageReservation,
  type AttachmentStorageSession,
  type AttachmentStorageSessionOptions,
} from "./attachment-storage-session.js";

const ATTACHMENT_HANDOFF_TIMEOUT_MS = 210_000;
const MAX_PENDING_IMPORT_BYTES = MAX_ATTACHMENT_TOTAL_BYTES;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface AttachmentRegistryRecord extends TrustedRuntimeAttachment {
  readonly extension: string;
}

interface StagedAttachment {
  readonly id: string;
  readonly path: string;
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



function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("The attachment request was cancelled.");
}

function validateSelectedImportCount(count: number): void {
  if (
    !Number.isSafeInteger(count)
    || count < 0
    || count > MAX_ATTACHMENT_COUNT
  ) throw new Error(`Select at most ${MAX_ATTACHMENT_COUNT} attachments.`);
}

function boundedLimit(value: number | undefined, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value), maximum))
    : maximum;
}

export class AttachmentRegistry {
  private readonly records = new Map<string, AttachmentRegistryRecord>();
  private readonly releases = new Map<string, PendingAttachmentRelease>();
  private readonly handoffs = new Map<string, PendingAttachmentHandoff>();
  private readonly attachmentHandoffs = new Map<string, Set<string>>();
  readonly rendererImports = new RendererAttachmentImportHolds(
    (id) => this.records.get(id)?.size ?? null,
    (id) => this.revokedAttachmentIds.has(id) || this.releases.has(id)
      || this.attachmentHandoffs.has(id),
  );
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
  private readonly stagingWrites = new Set<Promise<unknown>>();
  private directoryAuthority: { root: string; identity: BigIntStats } | null = null;
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
      || attachmentIds.length > MAX_ATTACHMENT_COUNT
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
        || this.rendererImports.has(id)
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

  setSnapshotSource(id: string, source: SnapshotSource): ChatAttachment {
    const snapshot = snapshotSourceSchema.parse(source);
    const record = this.records.get(id);
    if (!record || record.mimeType !== "image/png") throw new Error("Snapshot attachment is unavailable.");
    record.snapshot = snapshot;
    return { id: record.id, name: record.name, path: record.id, mimeType: record.mimeType, size: record.size, snapshot };
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
    if (this.disposed || signal?.aborted) {
      throw new Error("Temporary attachment storage is no longer available.");
    }
    const staging = this.stageAttachment(
      prepared,
      source.write,
      signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal,
    );
    this.stagingWrites.add(staging);
    let staged: StagedAttachment;
    try {
      staged = await staging;
    } finally {
      this.stagingWrites.delete(staging);
    }
    let imported: ChatAttachment[];
    try {
      imported = await this.serializeImport(
        prepared.size,
        async (operationSignal) => await this.importPreparedWriters([{
          prepared,
          staged,
        }], operationSignal, batchDigests),
        signal,
      );
    } catch (error) {
      await this.discardStaged(staged.path);
      throw error;
    }
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
      || pendingBytes > MAX_ATTACHMENT_TOTAL_BYTES
    ) throw new Error("Attachments exceed the maximum message size.");
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
    sources: readonly ({
      readonly prepared: PreparedAttachmentMetadata;
    } & ({
      readonly write: AttachmentImportWriter["write"];
    } | {
      readonly staged: StagedAttachment;
    }))[],
    signal: AbortSignal,
    digests = new Set<string>(),
  ): Promise<ChatAttachment[]> {
    const registered: AttachmentRegistryRecord[] = [];
    let totalBytes = 0;
    try {
      for (const source of sources) {
        signal.throwIfAborted();
        const attachment = await this.publishStaged(
          source.prepared,
          "staged" in source
            ? source.staged
            : await this.stageAttachment(source.prepared, source.write, signal),
          signal,
        );
        if (digests.has(attachment.digest)) {
          await this.rollbackRecord(attachment);
          continue;
        }
        digests.add(attachment.digest);
        totalBytes += attachment.size;
        if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
          await this.rollbackRecord(attachment);
          throw new Error("Attachments exceed the maximum message size.");
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

  private assertStorageCapacity(additionalBytes: number, availableDiskBytes = Infinity): void {
    const pendingBytes = [...this.pendingPaths.values()].reduce(
      (total, size) => total + size,
      0,
    );
    const retainedBytes = [...this.records.values()].reduce(
      (total, { size }) => total + size,
      pendingBytes,
    );
    if (
      this.reservedRecords
        + this.records.size
        + this.pendingPaths.size
        + 1 > this.maxRecords
      || this.reservedBytes + retainedBytes + additionalBytes > this.maxBytes
      || availableDiskBytes < pendingBytes + additionalBytes + ATTACHMENT_DISK_RESERVE_BYTES
    ) {
      throw new Error(TEMPORARY_ATTACHMENT_STORAGE_FULL);
    }
  }

  async preview(id: string, signal?: AbortSignal): Promise<ValidatedAttachmentPreview | null> {
    const record = this.records.get(id);
    const limit = record ? attachmentPreviewLimit(record.mimeType, record.size) : 0;
    if (limit === null) return null;
    const validated = await this.readValidated(id, signal, limit);
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
    captureBytes = 0,
  ): Promise<ValidatedAttachmentRead | null> {
    assertNotAborted(signal);
    if (
      this.revokedAttachmentIds.has(id)
      || this.rendererImports.has(id)
    ) return null;
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
    await this.verifiedDirectory();
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

    const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
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
      const { bytes, digest } = await readAttachment(file, record.size, captureBytes, operationSignal);
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
        digest !== record.digest
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
          ...(record.snapshot ? { snapshot: record.snapshot } : {}),
        },
        bytes,
      };
    } finally {
      await file.close();
    }
  }

  async release(id: string): Promise<boolean> {
    if (this.rendererImports.has(id)) return false;
    return await this.startRelease(id, true);
  }

  async rollback(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    await this.rollbackRecord(record);
  }

  async releaseFromRenderer(id: string): Promise<boolean> {
    if (this.rendererImports.has(id)) return false;
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
    await Promise.allSettled(this.stagingWrites);
    const validationStopped = await this.validationRunner.shutdown?.() ?? true;
    if (!validationStopped) {
      throw new Error("Attachment validation utility shutdown is unconfirmed.");
    }
    if (this.directoryAuthority) await this.verifiedDirectory();
    for (const handoff of this.handoffs.values()) clearTimeout(handoff.timer);
    this.handoffs.clear();
    this.attachmentHandoffs.clear();
    this.rendererImports.clear();
    const releases = [...this.releases.values()];
    for (const release of releases) release.cancel();
    await Promise.allSettled(releases.map(({ promise }) => promise));
    const records = [...this.records.values()];
    const pendingPaths = [...this.pendingPaths.keys()];
    this.records.clear();
    this.pendingPaths.clear();
    this.revokedAttachmentIds.clear();
    await Promise.all([...records.map(({ path }) => path), ...pendingPaths]
      .map(async (path) => {
        await this.verifiedDirectory();
        await unlink(path).catch(() => undefined);
      }));
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
    await unlinkWithRetry(record.path, async (path) => {
      await this.verifiedDirectory();
      await this.unlinkFile(path);
    }, this.waitForRetry);
    if (this.records.get(record.id) === record) {
      this.records.delete(record.id);
    }
    this.rendererImports.drop(record.id);
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
    this.rendererImports.drop(record.id);
    this.dropAttachmentHandoffs(record.id);
    this.revokedAttachmentIds.delete(record.id);
    this.pendingPaths.set(record.path, record.size);
  }

  private async stageAttachment(
    attachment: PreparedAttachmentMetadata,
    write: AttachmentImportWriter["write"],
    signal: AbortSignal,
  ): Promise<StagedAttachment> {
    await this.verifiedDirectory();
    signal.throwIfAborted();
    const availableDiskBytes = await availableAttachmentDiskBytes(this.directory);
    signal.throwIfAborted();
    this.assertStorageCapacity(attachment.size, availableDiskBytes);
    const id = randomUUID();
    const path = join(this.directory, `${id}.${attachment.extension}`);
    this.pendingPaths.set(path, attachment.size);
    let file: FileHandle;
    try {
      file = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      this.pendingPaths.delete(path);
      throw error;
    }
    try {
      try {
        await this.verifiedDirectory();
        await write(file, signal);
      } finally {
        await file.close();
      }
      signal.throwIfAborted();
      return { id, path };
    } catch (error) {
      await this.discardStaged(path);
      throw temporaryStorageWriteError(error);
    }
  }

  private async publishStaged(
    attachment: PreparedAttachmentMetadata,
    staged: StagedAttachment,
    signal: AbortSignal,
  ): Promise<AttachmentRegistryRecord> {
    const { id } = staged;
    let path = staged.path;
    try {
      signal.throwIfAborted();
      const receipt = await this.validateStoredFile(
        path,
        attachment,
        signal,
        true,
      );
      assertAttachmentImportReceipt(attachment, receipt);
      signal.throwIfAborted();
      if (receipt.extension !== attachment.extension) {
        const target = join(this.directory, `${id}.${receipt.extension}`);
        await this.verifiedDirectory();
        await rename(path, target);
        this.pendingPaths.delete(path);
        path = target;
        this.pendingPaths.set(path, receipt.size);
      }
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
      await this.discardStaged(path);
      throw error;
    }
  }

  private async discardStaged(path: string): Promise<void> {
    const removed = await unlinkWithRetry(
      path,
      async (path) => {
        await this.verifiedDirectory();
        await this.unlinkFile(path);
      },
      this.waitForRetry,
    ).then(() => true, () => false);
    if (removed) this.pendingPaths.delete(path);
  }

  private async validateStoredFile(
    path: string,
    attachment: PreparedAttachmentMetadata,
    signal: AbortSignal,
    initialImport: boolean,
  ): Promise<AttachmentImportValidationReceipt> {
    signal.throwIfAborted();
    const root = await this.verifiedDirectory();
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
      normalizeImage: initialImport && attachment.mimeType.startsWith("image/"),
      stallBeforeValidationMs: initialImport
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
    await verifyStoredAttachmentAfterValidation({
      before,
      expectedRoot: root,
      expectedSize: receipt.size,
      normalized: receipt.normalized === true && operation.normalizeImage === true && receipt.mimeType === "image/jpeg" && receipt.size <= 10 * 1024 * 1024,
      path,
      receipt,
      resolveVerifiedRoot: async () =>
        await this.verifiedDirectory(),
      signal,
    });
    return receipt;
  }

  private async verifiedDirectory(): Promise<string> {
    if (!this.directoryAuthority) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const root = await securePrivateDirectory(this.directory);
      this.directoryAuthority = { root, identity: await lstat(root, { bigint: true }) };
    }
    return await verifyPinnedAttachmentDirectory(this.directory, this.directoryAuthority);
  }
}
