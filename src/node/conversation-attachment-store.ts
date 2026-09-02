import { createHash, randomUUID } from "node:crypto";
import { constants, type Dir } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
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
  FILE_OPEN_DIRECTORY,
  FILE_OPEN_NO_FOLLOW,
} from "./platform-file-open-flags.js";
import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentMimeTypeForName,
  chatAttachmentStorageExtension,
  type ChatAttachmentMimeType,
} from "../shared/attachments.js";
import type { ChatAttachment } from "../shared/contracts.js";
import {
  runConversationAttachmentStoreChild as runStoreChild,
  type ConversationAttachmentStoreReadOperationRunner,
  type ConversationAttachmentStoreOperationRunner,
} from "./conversation-attachment-store-child.js";

export type {
  ConversationAttachmentStoreOperation,
  ConversationAttachmentStoreOperationRunner,
} from "./conversation-attachment-store-child.js";

const STORE_DIRECTORY = "conversation-attachments";
const MAX_PERSISTED_RECORDS = 256;
const MAX_PERSISTED_BYTES = 512 * 1024 * 1024;
const RECONCILIATION_BATCH_ENTRIES = 32;
const RECONCILIATION_BATCH_TIMEOUT_MS = 250;
const MAX_PARALLEL_CLEANUPS = 8;
const CLEANUP_BATCH_TIMEOUT_MS = 30_000;
const CHILD_STOP_CONFIRMATION_TIMEOUT_MS = 250;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

interface PersistedAttachmentMetadata {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly mimeType: ChatAttachmentMimeType;
  readonly size: number;
  readonly digest: string;
  readonly extension: string;
}

export interface ConversationAttachmentPayload {
  readonly attachment: ChatAttachment;
  readonly bytes: Uint8Array;
}

export interface ConversationAttachmentPreview {
  readonly attachment: ChatAttachment;
  readonly bytes: Buffer;
}

export interface ConversationAttachmentValidationResult {
  readonly displayName: string;
  readonly mimeType: ChatAttachmentMimeType;
  readonly size: number;
  readonly digest: string;
}

export type ConversationAttachmentValidator = (value: {
  readonly name: string;
  readonly mimeType: ChatAttachmentMimeType;
  readonly data: Uint8Array;
}) => ConversationAttachmentValidationResult;

export interface ConversationAttachmentStoreOptions {
  readonly maxBytes?: number;
  readonly maxRecords?: number;
  readonly validate?: ConversationAttachmentValidator;
  readonly persistenceFault?: {
    readonly attachmentId: string;
    readonly stallBeforePublishMs: number;
  };
  readonly readFault?: {
    readonly attachmentId: string;
    readonly stallBeforeRecordRevalidateMs: number;
    readonly onReady?: () => void;
  };
  /** Test-only bounds for deterministic incremental-reconciliation coverage. */
  readonly reconciliationBatchEntries?: number;
  readonly reconciliationBatchTimeoutMs?: number;
  /** Deterministic store-operation seam for unit tests; production uses the bounded child. */
  readonly operationRunner?: ConversationAttachmentStoreOperationRunner;
  readonly readOperationRunner?: ConversationAttachmentStoreReadOperationRunner;
}

interface StoreDirectoryAuthority {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: string | null;
}

interface AttachmentReconciliationState {
  readonly directory: Dir;
  readonly references: ReadonlyMap<string, ChatAttachment>;
  readonly records: Map<string, number>;
  readonly retryNames: string[];
  directoryExhausted: boolean;
  scheduled: boolean;
}

function contained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation !== ".."
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation);
}

function sameExactIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPrivateExactEntry(
  entry: { mode: bigint; uid: bigint },
  mode: 0o700,
): boolean {
  if (process.platform === "win32") return true;
  return (entry.mode & 0o777n) === BigInt(mode)
    && (
      typeof process.getuid !== "function"
      || entry.uid === BigInt(process.getuid())
    );
}

function boundedLimit(
  value: number | undefined,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value), maximum))
    : maximum;
}

function metadataFromUnknown(value: unknown): PersistedAttachmentMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<PersistedAttachmentMetadata>;
  const keys = Object.keys(value);
  if (
    keys.length !== 7
    || !keys.every((key) => [
      "version",
      "id",
      "name",
      "mimeType",
      "size",
      "digest",
      "extension",
    ].includes(key))
    || candidate.version !== 1
    || typeof candidate.id !== "string"
    || !UUID_PATTERN.test(candidate.id)
    || typeof candidate.name !== "string"
    || candidate.name.length < 1
    || candidate.name.length > 255
    || /[\0-\x1f\x7f]/u.test(candidate.name)
    || /[\\/]/u.test(candidate.name)
    || basename(candidate.name) !== candidate.name
    || typeof candidate.mimeType !== "string"
    || !(CHAT_ATTACHMENT_MIME_TYPES as readonly string[])
      .includes(candidate.mimeType)
    || chatAttachmentMimeTypeForName(candidate.name) !== candidate.mimeType
    || !Number.isSafeInteger(candidate.size)
    || (candidate.size ?? 0) < 1
    || (candidate.size ?? 0) > MAX_CHAT_ATTACHMENT_BYTES
    || typeof candidate.digest !== "string"
    || !DIGEST_PATTERN.test(candidate.digest)
    || typeof candidate.extension !== "string"
    || chatAttachmentStorageExtension(
      candidate.mimeType as ChatAttachmentMimeType,
    )
      !== candidate.extension
  ) return null;
  return candidate as PersistedAttachmentMetadata;
}

async function secureStoreDirectory(
  dataDirectory: string,
): Promise<StoreDirectoryAuthority> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const parent = await realpath(dataDirectory);
  const requested = join(parent, STORE_DIRECTORY);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const named = await lstat(requested, { bigint: true });
  if (!named.isDirectory() || named.isSymbolicLink()) {
    throw new Error("Conversation attachment storage is not a safe directory.");
  }
  if (process.platform !== "win32") {
    const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
    const directoryOnly = "O_DIRECTORY" in constants
      ? FILE_OPEN_DIRECTORY
      : 0;
    const directory = await open(
      requested,
      constants.O_RDONLY | noFollow | directoryOnly,
    );
    try {
      const pinnedBefore = await directory.stat({ bigint: true });
      if (
        !pinnedBefore.isDirectory()
        || !sameExactIdentity(named, pinnedBefore)
      ) throw new Error("Conversation attachment storage changed.");
      await directory.chmod(0o700);
      const pinnedAfter = await directory.stat({ bigint: true });
      if (
        !pinnedAfter.isDirectory()
        || !sameExactIdentity(pinnedBefore, pinnedAfter)
        || !isPrivateExactEntry(pinnedAfter, 0o700)
      ) throw new Error("Conversation attachment storage could not be secured.");
    } finally {
      await directory.close();
    }
  }
  const canonical = await realpath(requested);
  const verified = await lstat(canonical, { bigint: true });
  if (
    canonical !== requested
    || dirname(canonical) !== parent
    || !contained(parent, canonical)
    || !sameExactIdentity(named, verified)
    || !verified.isDirectory()
    || verified.isSymbolicLink()
    || !isPrivateExactEntry(verified, 0o700)
  ) {
    throw new Error("Conversation attachment storage could not be secured.");
  }
  return {
    path: canonical,
    dev: String(verified.dev),
    ino: String(verified.ino),
    uid: process.platform === "win32" ? null : String(verified.uid),
  };
}

function metadataFor(payload: ConversationAttachmentPayload): PersistedAttachmentMetadata {
  const { attachment, bytes } = payload;
  if (
    !UUID_PATTERN.test(attachment.id)
    || attachment.name.length < 1
    || attachment.name.length > 255
    || /[\0-\x1f\x7f]/u.test(attachment.name)
    || /[\\/]/u.test(attachment.name)
    || basename(attachment.name) !== attachment.name
    || bytes.byteLength !== attachment.size
    || attachment.size < 1
    || attachment.size > MAX_CHAT_ATTACHMENT_BYTES
    || chatAttachmentMimeTypeForName(attachment.name) !== attachment.mimeType
  ) {
    throw new Error("The retained conversation attachment is invalid.");
  }
  return {
    version: 1,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    digest: createHash("sha256").update(bytes).digest("hex"),
    extension: chatAttachmentStorageExtension(attachment.mimeType),
  };
}

export class ConversationAttachmentStore {
  readonly directory: string;
  private readonly directoryAuthority: StoreDirectoryAuthority;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private readonly validate?: ConversationAttachmentValidator;
  private readonly persistenceFault?: ConversationAttachmentStoreOptions["persistenceFault"];
  private readonly readFault?: ConversationAttachmentStoreOptions["readFault"];
  private readonly reconciliationBatchEntries: number;
  private readonly reconciliationBatchTimeoutMs: number;
  private readonly operationRunner: ConversationAttachmentStoreOperationRunner;
  private readonly readOperationRunner: ConversationAttachmentStoreReadOperationRunner;
  private readonly authoritativeRecords = new Set<string>();
  private readonly retentionRecords = new Map<string, Set<string>>();
  private readonly recordRetentions = new Map<string, Set<string>>();
  private readonly activeStagingRecords = new Map<string, string>();
  private readonly pendingRecordBytes = new Map<string, number>();
  private readonly pendingRetentionRecords = new Map<string, Set<string>>();
  private reconciliation: AttachmentReconciliationState | null = null;
  private reconciliationTimer: ReturnType<typeof setTimeout> | null = null;
  private reconciliationFailure: Error | null = null;
  private records: Map<string, number> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly lifecycle = new AbortController();
  private readonly activeOperationStops = new Set<Promise<void>>();
  private operationStopFailure: Error | null = null;
  private operationStopUnconfirmed = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  private constructor(
    directoryAuthority: StoreDirectoryAuthority,
    options: ConversationAttachmentStoreOptions,
  ) {
    this.directoryAuthority = directoryAuthority;
    this.directory = directoryAuthority.path;
    this.maxBytes = boundedLimit(options.maxBytes, MAX_PERSISTED_BYTES);
    this.maxRecords = boundedLimit(options.maxRecords, MAX_PERSISTED_RECORDS);
    this.validate = options.validate;
    this.persistenceFault = options.persistenceFault;
    this.readFault = options.readFault;
    this.reconciliationBatchEntries = process.env.NODE_ENV === "test"
      ? boundedLimit(
          options.reconciliationBatchEntries,
          RECONCILIATION_BATCH_ENTRIES,
        )
      : RECONCILIATION_BATCH_ENTRIES;
    this.reconciliationBatchTimeoutMs = process.env.NODE_ENV === "test"
      ? boundedLimit(
          options.reconciliationBatchTimeoutMs,
          RECONCILIATION_BATCH_TIMEOUT_MS,
        )
      : RECONCILIATION_BATCH_TIMEOUT_MS;
    this.operationRunner = options.operationRunner ?? runStoreChild;
    this.readOperationRunner = options.readOperationRunner ?? runStoreChild;
  }

  static async open(
    dataDirectory: string,
    options: ConversationAttachmentStoreOptions = {},
  ): Promise<ConversationAttachmentStore> {
    return new ConversationAttachmentStore(
      await secureStoreDirectory(resolve(dataDirectory)),
      options,
    );
  }

  async retain(
    payloads: readonly ConversationAttachmentPayload[],
    signal?: AbortSignal,
    retentionId = randomUUID(),
  ): Promise<ChatAttachment[]> {
    this.assertOpen();
    if (!UUID_PATTERN.test(retentionId)) {
      throw new Error("Invalid conversation attachment retention identity.");
    }
    if (payloads.length === 0) return [];
    return await this.serialize(async () => {
      this.assertOpen();
      signal?.throwIfAborted();
      if (this.reconciliation) {
        throw new Error("Conversation attachment storage is still reconciling.");
      }
      if (this.reconciliationFailure) {
        throw new Error("Conversation attachment storage reconciliation failed.");
      }
      if (
        this.retentionRecords.has(retentionId)
        || this.pendingRetentionRecords.has(retentionId)
      ) {
        throw new Error("Conversation attachment retention identity was reused.");
      }
      const unique = new Map<string, ConversationAttachmentPayload>();
      for (const payload of payloads) {
        const prior = unique.get(payload.attachment.id);
        if (prior) {
          const priorMetadata = metadataFor(prior);
          const currentMetadata = metadataFor(payload);
          if (
            priorMetadata.name !== currentMetadata.name
            || priorMetadata.mimeType !== currentMetadata.mimeType
            || priorMetadata.size !== currentMetadata.size
            || priorMetadata.digest !== currentMetadata.digest
          ) throw new Error("Conversation attachment identity was reused.");
          continue;
        }
        unique.set(payload.attachment.id, payload);
      }
      if (unique.size > MAX_CHAT_ATTACHMENTS) {
        throw new Error("Too many conversation attachments were retained.");
      }
      const batchBytes = [...unique.values()].reduce(
        (total, { bytes }) => total + bytes.byteLength,
        0,
      );
      if (batchBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
        throw new Error("Conversation attachments exceed the turn limit.");
      }
      if ([...unique.keys()].some((id) => this.pendingRecordBytes.has(id))) {
        throw new Error("Conversation attachment storage is still cleaning up.");
      }
      const usage = await this.loadUsage();
      signal?.throwIfAborted();
      const newPayloads: ConversationAttachmentPayload[] = [];
      for (const payload of unique.values()) {
        const current = await this.inspect(payload.attachment.id, signal);
        signal?.throwIfAborted();
        if (!current) {
          newPayloads.push(payload);
          continue;
        }
        const expected = metadataFor(payload);
        if (
          current.attachment.name !== expected.name
          || current.attachment.mimeType !== expected.mimeType
          || current.attachment.size !== expected.size
          || createHash("sha256").update(current.bytes).digest("hex")
            !== expected.digest
        ) throw new Error("Conversation attachment identity was reused.");
      }
      const newBytes = newPayloads.reduce(
        (total, { bytes }) => total + bytes.byteLength,
        0,
      );
      const reserved = this.reservedUsage();
      if (
        usage.records + reserved.records + newPayloads.length > this.maxRecords
        || usage.bytes + reserved.bytes + newBytes > this.maxBytes
      ) {
        throw new Error("Conversation attachment storage is full.");
      }
      if (newPayloads.length > 0) {
        const pendingIds = new Set<string>();
        for (const { attachment } of newPayloads) {
          pendingIds.add(attachment.id);
          this.pendingRecordBytes.set(attachment.id, attachment.size);
        }
        this.pendingRetentionRecords.set(retentionId, pendingIds);
      }
      const created: string[] = [];
      try {
        for (const payload of newPayloads) {
          await this.persist(payload, signal);
          created.push(payload.attachment.id);
        }
      } catch (error) {
        if (signal?.aborted) {
          void this.cleanupUnclaimedRecords(created).catch(() => undefined);
        } else {
          const cleanup = await Promise.allSettled(
            created.map((id) => this.removeRecord(id)),
          );
          for (const [index, result] of cleanup.entries()) {
            if (result.status === "fulfilled") {
              this.clearPendingRecord(created[index]!);
            }
          }
        }
        throw error;
      }
      for (const payload of unique.values()) {
        this.records?.set(payload.attachment.id, payload.attachment.size);
      }
      for (const { attachment } of unique.values()) {
        this.clearPendingRecord(attachment.id);
      }
      const attachmentIds = [...unique.keys()];
      this.retentionRecords.set(retentionId, new Set(attachmentIds));
      for (const id of attachmentIds) {
        const retentions = this.recordRetentions.get(id) ?? new Set<string>();
        retentions.add(retentionId);
        this.recordRetentions.set(id, retentions);
      }
      return attachmentIds.map((id) => {
        const payload = unique.get(id)!;
        const extension = chatAttachmentStorageExtension(
          payload.attachment.mimeType,
        );
        return {
          ...payload.attachment,
          path: join(this.directory, id, `${id}.${extension}`),
        };
      });
    });
  }

  async preview(id: string): Promise<ConversationAttachmentPreview | null> {
    this.assertOpen();
    return await this.inspect(id);
  }

  acceptRetention(retentionId: string): void {
    this.assertOpen();
    if (!UUID_PATTERN.test(retentionId)) {
      throw new Error("Invalid conversation attachment retention identity.");
    }
    const attachmentIds = this.retentionRecords.get(retentionId);
    if (!attachmentIds) return;
    this.retentionRecords.delete(retentionId);
    for (const id of attachmentIds) {
      const retentions = this.recordRetentions.get(id);
      retentions?.delete(retentionId);
      if (retentions?.size === 0) this.recordRetentions.delete(id);
      this.authoritativeRecords.add(id);
    }
  }

  async releaseRetention(retentionId: string): Promise<void> {
    this.assertOpen();
    if (!UUID_PATTERN.test(retentionId)) {
      throw new Error("Invalid conversation attachment retention identity.");
    }
    if (!this.retentionRecords.has(retentionId)) return;
    await this.serialize(async () => {
      this.assertOpen();
      const attachmentIds = this.retentionRecords.get(retentionId);
      if (!attachmentIds) return;
      const removable: string[] = [];
      const detach = (id: string): void => {
        attachmentIds.delete(id);
        const retentions = this.recordRetentions.get(id);
        retentions?.delete(retentionId);
        if (retentions?.size === 0) this.recordRetentions.delete(id);
      };
      for (const id of attachmentIds) {
        const retentions = this.recordRetentions.get(id);
        let retainedElsewhere = false;
        for (const candidate of retentions ?? []) {
          if (candidate === retentionId) continue;
          retainedElsewhere = true;
          break;
        }
        if (
          !this.authoritativeRecords.has(id)
          && !retainedElsewhere
        ) {
          removable.push(id);
        } else {
          detach(id);
        }
      }
      const cleanup = await this.cleanupRecords(removable);
      for (const id of cleanup.removed) {
        detach(id);
        this.records?.delete(id);
        this.reconciliation?.records.delete(id);
      }
      if (attachmentIds.size === 0) {
        this.retentionRecords.delete(retentionId);
      }
      if (cleanup.failure) throw cleanup.failure;
    });
  }

  async release(ids: readonly string[]): Promise<void> {
    this.assertOpen();
    await this.serialize(async () => {
      this.assertOpen();
      const unique = [...new Set(ids)];
      for (const id of unique) {
        if (!UUID_PATTERN.test(id)) {
          throw new Error("Invalid conversation attachment identity.");
        }
      }
      const removable: string[] = [];
      for (const id of unique) {
        this.authoritativeRecords.delete(id);
        if (!this.recordRetentions.has(id)) removable.push(id);
      }
      const cleanup = await this.cleanupRecords(removable);
      for (const id of cleanup.removed) {
        this.records?.delete(id);
        this.reconciliation?.records.delete(id);
      }
      if (cleanup.failure) throw cleanup.failure;
    });
  }

  async reconcile(references: readonly ChatAttachment[]): Promise<void> {
    this.assertOpen();
    await this.serialize(async () => {
      this.assertOpen();
      if (this.reconciliation) {
        throw new Error("Conversation attachment storage is already reconciling.");
      }
      await this.assertStoreRootAuthority();
      const referenced = new Map<string, ChatAttachment>();
      const conflicted = new Set<string>();
      for (const attachment of references) {
        if (!UUID_PATTERN.test(attachment.id)) continue;
        if (conflicted.has(attachment.id)) continue;
        const prior = referenced.get(attachment.id);
        if (
          prior
          && (
            prior.name !== attachment.name
            || prior.mimeType !== attachment.mimeType
            || prior.size !== attachment.size
          )
        ) {
          referenced.delete(attachment.id);
          conflicted.add(attachment.id);
          continue;
        }
        referenced.set(attachment.id, attachment);
      }
      const directory = await opendir(this.directory, {
        bufferSize: this.reconciliationBatchEntries,
      });
      this.reconciliationFailure = null;
      const state: AttachmentReconciliationState = {
        directory,
        references: referenced,
        records: new Map<string, number>(),
        retryNames: [],
        directoryExhausted: false,
        scheduled: false,
      };
      this.reconciliation = state;
      try {
        await this.advanceReconciliation(state);
      } catch (error) {
        this.reconciliationFailure = error instanceof Error
          ? error
          : new Error(String(error));
        await this.closeReconciliation(state);
        throw error;
      }
      if (this.reconciliation === state) {
        this.scheduleReconciliation(state);
      }
    });
  }

  async usage(): Promise<{ bytes: number; records: number }> {
    this.assertOpen();
    return await this.serialize(() => (
      this.reconciliation || this.reconciliationFailure
    )
      ? Promise.resolve({
          bytes: this.maxBytes,
          records: this.maxRecords,
        })
      : this.loadUsage());
  }

  /** Cancels new work and proves every spawned store child has stopped. */
  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    this.lifecycle.abort(new Error("Conversation attachment storage is closing."));
    if (this.reconciliationTimer) {
      clearTimeout(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    this.closePromise = (async () => {
      while (true) {
        const tail = this.mutationTail;
        await tail;
        const stops = [...this.activeOperationStops];
        await Promise.all(stops);
        await Promise.resolve();
        if (
          tail === this.mutationTail
          && this.activeOperationStops.size === 0
        ) break;
      }
      if (this.reconciliation) {
        await this.closeReconciliation(this.reconciliation);
      }
      if (this.operationStopFailure) throw this.operationStopFailure;
    })();
    return await this.closePromise;
  }

  private async assertStoreRootAuthority(): Promise<void> {
    const named = await lstat(this.directory, { bigint: true });
    const canonical = await realpath(this.directory);
    if (
      canonical !== this.directoryAuthority.path
      || !named.isDirectory()
      || named.isSymbolicLink()
      || String(named.dev) !== this.directoryAuthority.dev
      || String(named.ino) !== this.directoryAuthority.ino
      || (
        process.platform !== "win32"
        && (
          !isPrivateExactEntry(named, 0o700)
          || String(named.uid) !== this.directoryAuthority.uid
        )
      )
    ) throw new Error("Conversation attachment storage authority changed.");
  }

  private async advanceReconciliation(
    state: AttachmentReconciliationState,
  ): Promise<void> {
    if (this.reconciliation !== state) return;
    this.assertOpen();
    await this.assertStoreRootAuthority();
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new Error("Conversation attachment reconciliation yielded."));
    }, this.reconciliationBatchTimeoutMs);
    timer.unref();
    try {
      let processed = 0;
      while (
        processed < this.reconciliationBatchEntries
        && !deadline.signal.aborted
      ) {
        let name = state.retryNames.shift();
        if (!name && !state.directoryExhausted) {
          const entry = await state.directory.read();
          if (entry) name = entry.name;
          else state.directoryExhausted = true;
        }
        if (!name) {
          await this.assertStoreRootAuthority();
          await state.directory.close();
          if (this.reconciliation !== state) return;
          this.records = state.records;
          this.reconcilePendingRecords(state.records);
          this.authoritativeRecords.clear();
          for (const id of state.records.keys()) {
            this.authoritativeRecords.add(id);
          }
          this.reconciliation = null;
          return;
        }
        if (deadline.signal.aborted) {
          state.retryNames.push(name);
          break;
        }
        processed += 1;
        try {
          await this.reconcileEntry(state, name, deadline.signal);
        } catch (error) {
          state.retryNames.push(name);
          if (!deadline.signal.aborted) throw error;
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async reconcileEntry(
    state: AttachmentReconciliationState,
    name: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.activeStagingRecords.has(name)) {
      state.retryNames.push(name);
      return;
    }
    if (!UUID_PATTERN.test(name)) {
      await this.removeContainedEntry(name, signal);
      return;
    }
    const expected = state.references.get(name);
    if (!expected) {
      await this.removeRecord(name, signal);
      state.records.delete(name);
      return;
    }
    const current = await this.inspectForMaintenance(name, signal);
    if (!current) {
      state.records.delete(name);
      return;
    }
    if (
      current.attachment.name !== expected.name
      || current.attachment.mimeType !== expected.mimeType
      || current.attachment.size !== expected.size
    ) {
      await this.removeRecord(name, signal);
      state.records.delete(name);
      return;
    }
    state.records.set(name, current.attachment.size);
  }

  private scheduleReconciliation(state: AttachmentReconciliationState): void {
    if (this.closing || this.reconciliation !== state || state.scheduled) return;
    state.scheduled = true;
    const scheduled = setTimeout(() => {
      if (this.reconciliationTimer === scheduled) {
        this.reconciliationTimer = null;
      }
      state.scheduled = false;
      if (this.closing) return;
      void this.serialize(async () => {
        if (this.reconciliation !== state) return;
        await this.advanceReconciliation(state);
      }).then(
        () => {
          if (this.reconciliation === state) {
            this.scheduleReconciliation(state);
          }
        },
        (error: unknown) => {
          this.reconciliationFailure = error instanceof Error
            ? error
            : new Error(String(error));
          return this.closeReconciliation(state);
        },
      );
    }, 25);
    this.reconciliationTimer = scheduled;
    scheduled.unref();
  }

  private async closeReconciliation(
    state: AttachmentReconciliationState,
  ): Promise<void> {
    if (this.reconciliation === state) this.reconciliation = null;
    await state.directory.close().catch(() => undefined);
  }

  private async loadUsage(): Promise<{ bytes: number; records: number }> {
    if (this.records) return this.usageFromRecords();
    const records = new Map<string, number>();
    for (const name of await readdir(this.directory)) {
      if (this.activeStagingRecords.has(name)) continue;
      if (!UUID_PATTERN.test(name)) {
        await this.removeContainedEntry(name);
        continue;
      }
      const current = await this.inspectForMaintenance(name);
      if (!current) continue;
      records.set(name, current.attachment.size);
    }
    this.records = records;
    this.reconcilePendingRecords(records);
    return this.usageFromRecords();
  }

  private async inspect(
    id: string,
    signal?: AbortSignal,
  ): Promise<ConversationAttachmentPreview | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const configuredReadStall = process.env.NODE_ENV === "test"
      && this.readFault?.attachmentId === id
      ? this.readFault.stallBeforeRecordRevalidateMs
      : 0;
    const reading = this.trackOperation(this.readOperationRunner({
      operation: "read",
      root: this.directory,
      rootDev: this.directoryAuthority.dev,
      rootIno: this.directoryAuthority.ino,
      rootUid: this.directoryAuthority.uid,
      id,
      stallBeforeRecordRevalidateMs: Math.max(
        0,
        Math.min(Math.trunc(configuredReadStall), 60_000),
      ),
    }, this.operationSignal(signal)));
    if (
      process.env.NODE_ENV === "test"
      && configuredReadStall > 0
      && this.readFault?.onReady
    ) {
      const onReady = this.readFault.onReady;
      void reading.ready?.then((observed) => {
        if (observed) onReady();
      }, () => undefined);
    }
    const receipt = await reading.result;
    if (receipt.missing) return null;
    let metadata: PersistedAttachmentMetadata | null;
    try {
      metadata = metadataFromUnknown(JSON.parse(receipt.metadata));
    } catch {
      metadata = null;
    }
    if (!metadata || metadata.id !== id) return null;
    const bytes = Buffer.from(receipt.bytes);
    if (
      bytes.length !== metadata.size
      || createHash("sha256").update(bytes).digest("hex") !== metadata.digest
    ) throw new Error("Conversation attachment content changed.");
    if (this.validate) {
      const validated = this.validate({
        name: metadata.name,
        mimeType: metadata.mimeType,
        data: bytes,
      });
      if (
        validated.displayName !== metadata.name
        || validated.mimeType !== metadata.mimeType
        || validated.size !== metadata.size
        || validated.digest !== metadata.digest
      ) throw new Error("Conversation attachment content is invalid.");
    }
    return {
      attachment: {
        id,
        name: metadata.name,
        path: join(this.directory, id, `${id}.${metadata.extension}`),
        mimeType: metadata.mimeType,
        size: metadata.size,
      },
      bytes,
    };
  }

  private async inspectForMaintenance(
    id: string,
    signal?: AbortSignal,
  ): Promise<ConversationAttachmentPreview | null> {
    try {
      const current = await this.inspect(id, signal);
      if (!current) await this.removeRecord(id, signal);
      return current;
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.removeRecord(id, signal);
      return null;
    }
  }

  private async persist(
    payload: ConversationAttachmentPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    const metadata = metadataFor(payload);
    const stagingName = `.pending-${randomUUID()}`;
    signal?.throwIfAborted();
    this.activeStagingRecords.set(stagingName, metadata.id);
    const configuredStall = process.env.NODE_ENV === "test"
      && this.persistenceFault?.attachmentId === metadata.id
      ? this.persistenceFault.stallBeforePublishMs
      : 0;
    let persistence: {
      readonly result: Promise<void>;
      readonly stopped: Promise<void>;
      readonly ready?: Promise<boolean>;
    };
    try {
      persistence = this.trackOperation(this.operationRunner({
        operation: "persist",
        root: this.directory,
        rootDev: this.directoryAuthority.dev,
        rootIno: this.directoryAuthority.ino,
        rootUid: this.directoryAuthority.uid,
        id: metadata.id,
        stagingName,
        extension: metadata.extension,
        bytes: payload.bytes,
        metadata: JSON.stringify(metadata),
        stallBeforePublishMs: Math.max(
          0,
          Math.min(Math.trunc(configuredStall), 60_000),
        ),
      }, this.operationSignal(signal)));
    } catch (error) {
      this.activeStagingRecords.delete(stagingName);
      this.clearPendingRecord(metadata.id);
      throw error;
    }
    try {
      await persistence.result;
      this.activeStagingRecords.delete(stagingName);
    } catch (error) {
      void persistence.stopped.then(async () => {
        if (await this.cleanupStoppedPersistence(metadata.id, stagingName)) {
          this.activeStagingRecords.delete(stagingName);
          this.clearPendingRecord(metadata.id);
        }
      }).catch(() => undefined);
      throw error;
    }
  }

  private async cleanupStoppedPersistence(
    id: string,
    stagingName: string,
  ): Promise<boolean> {
    return await this.serialize(async () => {
      let cleaned = await this.removeContainedEntry(stagingName)
        .then(() => true, () => false);
      if (
        !this.authoritativeRecords.has(id)
        && !this.recordRetentions.has(id)
      ) {
        const recordRemoved = await this.removeRecord(id)
          .then(() => true, () => false);
        cleaned &&= recordRemoved;
        if (recordRemoved) {
          this.records?.delete(id);
          this.reconciliation?.records.delete(id);
        }
      }
      return cleaned;
    });
  }

  private async cleanupUnclaimedRecords(
    ids: readonly string[],
  ): Promise<void> {
    return await this.serialize(async () => {
      for (const id of ids) {
        if (
          this.authoritativeRecords.has(id)
          || this.recordRetentions.has(id)
        ) continue;
        const removed = await this.removeRecord(id)
          .then(() => true, () => false);
        if (removed) {
          this.records?.delete(id);
          this.reconciliation?.records.delete(id);
          this.clearPendingRecord(id);
        }
      }
    });
  }

  private async removeRecord(
    id: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!UUID_PATTERN.test(id)) {
      throw new Error("Invalid conversation attachment identity.");
    }
    await this.removeContainedEntry(id, signal);
  }

  private async cleanupRecords(
    ids: readonly string[],
  ): Promise<{ readonly removed: Set<string>; readonly failure?: Error }> {
    if (ids.length === 0) return { removed: new Set<string>() };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("Conversation attachment cleanup timed out."));
    }, CLEANUP_BATCH_TIMEOUT_MS);
    timer.unref();
    const removed = new Set<string>();
    let failed = false;
    let failure: Error | undefined;
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < ids.length && !controller.signal.aborted) {
        const id = ids[nextIndex++]!;
        try {
          await this.removeRecord(id, controller.signal);
          removed.add(id);
        } catch (error) {
          if (!failed) {
            failure = error instanceof Error ? error : new Error(String(error));
          }
          failed = true;
        }
      }
    };
    try {
      await Promise.all(Array.from(
        { length: Math.min(ids.length, MAX_PARALLEL_CLEANUPS) },
        () => worker(),
      ));
    } finally {
      clearTimeout(timer);
    }
    if (removed.size !== ids.length && !failure) {
      failed = true;
      failure = new Error("Conversation attachment cleanup timed out.");
    }
    return failed
      ? {
          removed,
          failure: failure ?? new Error("Conversation attachment cleanup failed."),
        }
      : { removed };
  }

  private async removeContainedEntry(
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const target = join(this.directory, name);
    if (
      name.length < 1
      || name === "."
      || name === ".."
      || basename(name) !== name
      || dirname(target) !== this.directory
      || !contained(this.directory, target)
    ) {
      throw new Error("Conversation attachment cleanup escaped storage.");
    }
    const cleanup = this.trackOperation(this.operationRunner({
      operation: "remove",
      root: this.directory,
      rootDev: this.directoryAuthority.dev,
      rootIno: this.directoryAuthority.ino,
      rootUid: this.directoryAuthority.uid,
      name,
    }, this.operationSignal(signal)));
    try {
      await cleanup.result;
    } catch (error) {
      await this.confirmOperationStopped(cleanup.stopped);
      throw error;
    }
    await this.confirmOperationStopped(cleanup.stopped);
  }

  private usageFromRecords(): { bytes: number; records: number } {
    const records = this.records ?? new Map<string, number>();
    return {
      records: records.size,
      bytes: [...records.values()].reduce((total, size) => total + size, 0),
    };
  }

  private reservedUsage(): { bytes: number; records: number } {
    return {
      bytes: [...this.pendingRecordBytes.values()].reduce(
        (total, bytes) => total + bytes,
        0,
      ),
      records: this.pendingRecordBytes.size,
    };
  }

  private clearPendingRecord(id: string): void {
    this.pendingRecordBytes.delete(id);
    for (const [retentionId, ids] of this.pendingRetentionRecords) {
      ids.delete(id);
      if (ids.size === 0) this.pendingRetentionRecords.delete(retentionId);
    }
  }

  private reconcilePendingRecords(records: ReadonlyMap<string, number>): void {
    const activeIds = new Set(this.activeStagingRecords.values());
    for (const id of this.pendingRecordBytes.keys()) {
      if (records.has(id) || !activeIds.has(id)) {
        this.clearPendingRecord(id);
      }
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let unlock!: () => void;
    this.mutationTail = new Promise<void>((resolveMutation) => {
      unlock = resolveMutation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new Error("Conversation attachment storage is closing.");
    }
    if (this.operationStopUnconfirmed && this.activeOperationStops.size > 0) {
      throw new Error("A prior conversation attachment operation is still stopping.");
    }
    if (this.operationStopFailure) throw this.operationStopFailure;
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.lifecycle.signal])
      : this.lifecycle.signal;
  }

  private trackOperation<T extends {
    readonly result: Promise<unknown>;
    readonly stopped: Promise<void>;
  }>(operation: T): T {
    const stopped = operation.stopped.catch((error: unknown) => {
      this.operationStopFailure ??= error instanceof Error
        ? error
        : new Error(String(error));
      throw error;
    });
    this.activeOperationStops.add(stopped);
    void stopped.then(
      () => {
        this.activeOperationStops.delete(stopped);
        if (this.activeOperationStops.size === 0) {
          this.operationStopUnconfirmed = false;
        }
      },
      () => this.activeOperationStops.delete(stopped),
    );
    return operation;
  }

  private async confirmOperationStopped(stopped: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stopped,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(
            "Conversation attachment child shutdown is unconfirmed.",
          )), CHILD_STOP_CONFIRMATION_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } catch (error) {
      this.operationStopUnconfirmed = true;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
