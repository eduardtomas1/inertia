import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
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
import { Worker } from "node:worker_threads";

import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentMimeTypeForName,
  chatAttachmentStorageExtension,
  type ChatAttachmentMimeType,
} from "../shared/attachments.js";
import type { ChatAttachment } from "../shared/contracts.js";

const STORE_DIRECTORY = "conversation-attachments";
const METADATA_FILE = "metadata.json";
const MAX_METADATA_BYTES = 4 * 1024;
const MAX_PERSISTED_RECORDS = 256;
const MAX_PERSISTED_BYTES = 512 * 1024 * 1024;
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
    readonly stallAfterContentSyncMs: number;
  };
}

interface StoreDirectoryAuthority {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

function contained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation !== ".."
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation);
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPrivateEntry(
  entry: { mode: number; uid: number },
  mode: 0o600 | 0o700,
): boolean {
  if (process.platform === "win32") return true;
  return (entry.mode & 0o777) === mode
    && (
      typeof process.getuid !== "function"
      || entry.uid === process.getuid()
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
  const named = await lstat(requested);
  if (!named.isDirectory() || named.isSymbolicLink()) {
    throw new Error("Conversation attachment storage is not a safe directory.");
  }
  if (process.platform !== "win32") {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const directoryOnly = "O_DIRECTORY" in constants
      ? constants.O_DIRECTORY
      : 0;
    const directory = await open(
      requested,
      constants.O_RDONLY | noFollow | directoryOnly,
    );
    try {
      const pinnedBefore = await directory.stat();
      if (
        !pinnedBefore.isDirectory()
        || !sameIdentity(named, pinnedBefore)
      ) throw new Error("Conversation attachment storage changed.");
      await directory.chmod(0o700);
      const pinnedAfter = await directory.stat();
      if (
        !pinnedAfter.isDirectory()
        || !sameIdentity(pinnedBefore, pinnedAfter)
        || !isPrivateEntry(pinnedAfter, 0o700)
      ) throw new Error("Conversation attachment storage could not be secured.");
    } finally {
      await directory.close();
    }
  }
  const canonical = await realpath(requested);
  const verified = await lstat(canonical);
  if (
    canonical !== requested
    || dirname(canonical) !== parent
    || !contained(parent, canonical)
    || !sameIdentity(named, verified)
    || !verified.isDirectory()
    || verified.isSymbolicLink()
    || !isPrivateEntry(verified, 0o700)
  ) {
    throw new Error("Conversation attachment storage could not be secured.");
  }
  return {
    path: canonical,
    dev: verified.dev,
    ino: verified.ino,
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

const PERSIST_WORKER_SOURCE = `
  const { constants } = require("node:fs");
  const { chmod, mkdir, open } = require("node:fs/promises");
  const { join } = require("node:path");
  const { parentPort, workerData } = require("node:worker_threads");

  async function persist() {
    await mkdir(workerData.directory, { mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(workerData.directory, 0o700);
    }
    const contentPath = join(workerData.directory, workerData.contentName);
    const content = await open(
      contentPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await content.writeFile(workerData.bytes);
      await content.sync();
    } finally {
      await content.close();
    }
    if (workerData.stallAfterContentSyncMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, workerData.stallAfterContentSyncMs);
      });
    }
    if (process.platform !== "win32") await chmod(contentPath, 0o600);
    const metadataPath = join(workerData.directory, ${JSON.stringify(METADATA_FILE)});
    const manifest = await open(
      metadataPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await manifest.writeFile(workerData.metadata, "utf8");
      await manifest.sync();
    } finally {
      await manifest.close();
    }
    if (process.platform !== "win32") await chmod(metadataPath, 0o600);
  }

  void persist().then(
    () => parentPort.postMessage({ ok: true }),
    () => parentPort.postMessage({ ok: false }),
  ).finally(() => parentPort.close());
`;

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Conversation attachment retention was cancelled.");
}

function persistRecordOffThread(
  input: {
    readonly directory: string;
    readonly contentName: string;
    readonly bytes: Uint8Array;
    readonly metadata: string;
    readonly stallAfterContentSyncMs: number;
  },
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancellationError(signal));
  const worker = new Worker(PERSIST_WORKER_SOURCE, {
    eval: true,
    execArgv: ["--no-warnings"],
    workerData: input,
  });
  return new Promise<void>((resolvePersist, rejectPersist) => {
    let receipt = false;
    let workerError: Error | null = null;
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPersist(error);
      else resolvePersist();
    };
    const abort = (): void => {
      const error = signal
        ? cancellationError(signal)
        : new Error("Conversation attachment retention was cancelled.");
      finish(error);
      worker.unref();
      void worker.terminate().catch(() => undefined);
    };

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    worker.on("message", (message: unknown) => {
      receipt = typeof message === "object"
        && message !== null
        && "ok" in message
        && message.ok === true;
      if (!receipt) {
        workerError = new Error("Conversation attachment persistence failed.");
      }
    });
    worker.once("error", (error) => {
      workerError = error instanceof Error ? error : new Error(String(error));
    });
    worker.once("exit", (code) => {
      if (settled) return;
      finish(
        code === 0 && receipt
          ? undefined
          : workerError
            ?? new Error("Conversation attachment persistence failed."),
      );
    });
  });
}

export class ConversationAttachmentStore {
  readonly directory: string;
  private readonly directoryAuthority: StoreDirectoryAuthority;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private readonly validate?: ConversationAttachmentValidator;
  private readonly persistenceFault?: ConversationAttachmentStoreOptions["persistenceFault"];
  private readonly authoritativeRecords = new Set<string>();
  private readonly retentionRecords = new Map<string, Set<string>>();
  private readonly recordRetentions = new Map<string, Set<string>>();
  private records: Map<string, number> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

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
    if (!UUID_PATTERN.test(retentionId)) {
      throw new Error("Invalid conversation attachment retention identity.");
    }
    if (payloads.length === 0) return [];
    return await this.serialize(async () => {
      signal?.throwIfAborted();
      if (this.retentionRecords.has(retentionId)) {
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
      if (unique.size > 8) {
        throw new Error("Too many conversation attachments were retained.");
      }
      const batchBytes = [...unique.values()].reduce(
        (total, { bytes }) => total + bytes.byteLength,
        0,
      );
      if (batchBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
        throw new Error("Conversation attachments exceed the turn limit.");
      }
      const usage = await this.loadUsage();
      signal?.throwIfAborted();
      const newPayloads: ConversationAttachmentPayload[] = [];
      for (const payload of unique.values()) {
        const current = await this.inspect(payload.attachment.id);
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
      if (
        usage.records + newPayloads.length > this.maxRecords
        || usage.bytes + newBytes > this.maxBytes
      ) {
        throw new Error("Conversation attachment storage is full.");
      }
      const created: string[] = [];
      try {
        for (const payload of newPayloads) {
          await this.persist(payload, signal);
          created.push(payload.attachment.id);
        }
      } catch (error) {
        await Promise.allSettled(created.map((id) => this.removeRecord(id)));
        throw error;
      }
      for (const payload of newPayloads) {
        this.records?.set(payload.attachment.id, payload.attachment.size);
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
    return await this.inspect(id);
  }

  acceptRetention(retentionId: string): void {
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
    if (!UUID_PATTERN.test(retentionId)) {
      throw new Error("Invalid conversation attachment retention identity.");
    }
    await this.serialize(async () => {
      const attachmentIds = this.retentionRecords.get(retentionId);
      if (!attachmentIds) return;
      this.retentionRecords.delete(retentionId);
      for (const id of attachmentIds) {
        const retentions = this.recordRetentions.get(id);
        retentions?.delete(retentionId);
        if (retentions?.size === 0) this.recordRetentions.delete(id);
        if (
          !this.authoritativeRecords.has(id)
          && !this.recordRetentions.has(id)
        ) {
          await this.removeRecord(id);
          this.records?.delete(id);
        }
      }
    });
  }

  async release(ids: readonly string[]): Promise<void> {
    await this.serialize(async () => {
      for (const id of new Set(ids)) {
        if (!UUID_PATTERN.test(id)) {
          throw new Error("Invalid conversation attachment identity.");
        }
        this.authoritativeRecords.delete(id);
        for (const retentionId of this.recordRetentions.get(id) ?? []) {
          const attachmentIds = this.retentionRecords.get(retentionId);
          attachmentIds?.delete(id);
          if (attachmentIds?.size === 0) {
            this.retentionRecords.delete(retentionId);
          }
        }
        this.recordRetentions.delete(id);
        await this.removeRecord(id);
        this.records?.delete(id);
      }
    });
  }

  async reconcile(references: readonly ChatAttachment[]): Promise<void> {
    await this.serialize(async () => {
      const referenced = new Map<string, ChatAttachment>();
      const conflicted = new Set<string>();
      const records = new Map<string, number>();
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
      for (const name of await readdir(this.directory)) {
        if (!UUID_PATTERN.test(name)) {
          await this.removeContainedEntry(name);
          continue;
        }
        const expected = referenced.get(name);
        if (!expected) {
          await this.removeRecord(name);
          continue;
        }
        const current = await this.inspectForMaintenance(name);
        if (!current) continue;
        if (
          current.attachment.name !== expected.name
          || current.attachment.mimeType !== expected.mimeType
          || current.attachment.size !== expected.size
        ) {
          await this.removeRecord(name);
        } else {
          records.set(name, current.attachment.size);
        }
      }
      this.records = records;
      this.authoritativeRecords.clear();
      for (const id of records.keys()) this.authoritativeRecords.add(id);
    });
  }

  async usage(): Promise<{ bytes: number; records: number }> {
    return await this.serialize(() => this.loadUsage());
  }

  private async loadUsage(): Promise<{ bytes: number; records: number }> {
    if (this.records) return this.usageFromRecords();
    const records = new Map<string, number>();
    for (const name of await readdir(this.directory)) {
      if (!UUID_PATTERN.test(name)) {
        await this.removeContainedEntry(name);
        continue;
      }
      const current = await this.inspectForMaintenance(name);
      if (!current) continue;
      records.set(name, current.attachment.size);
    }
    this.records = records;
    return this.usageFromRecords();
  }

  private async inspect(
    id: string,
  ): Promise<ConversationAttachmentPreview | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const recordDirectory = join(this.directory, id);
    let directoryInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      directoryInfo = await lstat(recordDirectory);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? null
        : Promise.reject(error);
    }
    if (
      !directoryInfo.isDirectory()
      || directoryInfo.isSymbolicLink()
      || !isPrivateEntry(directoryInfo, 0o700)
    ) {
      throw new Error("Conversation attachment record is unsafe.");
    }
    const canonicalRecord = await realpath(recordDirectory);
    if (
      canonicalRecord !== recordDirectory
      || dirname(canonicalRecord) !== this.directory
      || !contained(this.directory, canonicalRecord)
    ) throw new Error("Conversation attachment record escaped storage.");
    const metadata = await this.readMetadata(canonicalRecord);
    if (!metadata || metadata.id !== id) return null;
    const contentPath = join(canonicalRecord, `${id}.${metadata.extension}`);
    const named = await lstat(contentPath);
    if (
      !named.isFile()
      || named.isSymbolicLink()
      || !isPrivateEntry(named, 0o600)
    ) {
      throw new Error("Conversation attachment content is unsafe.");
    }
    const canonicalContent = await realpath(contentPath);
    if (
      canonicalContent !== contentPath
      || dirname(canonicalContent) !== canonicalRecord
      || !contained(canonicalRecord, canonicalContent)
    ) throw new Error("Conversation attachment content escaped storage.");
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const nonBlocking = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
    const file = await open(
      canonicalContent,
      constants.O_RDONLY | noFollow | nonBlocking,
    );
    try {
      const before = await file.stat();
      if (
        !before.isFile()
        || !sameIdentity(named, before)
        || before.size !== metadata.size
      ) throw new Error("Conversation attachment content changed.");
      const bytes = await file.readFile();
      const after = await file.stat();
      if (
        after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
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
          path: canonicalContent,
          mimeType: metadata.mimeType,
          size: metadata.size,
        },
        bytes,
      };
    } finally {
      await file.close();
    }
  }

  private async inspectForMaintenance(
    id: string,
  ): Promise<ConversationAttachmentPreview | null> {
    try {
      const current = await this.inspect(id);
      if (!current) await this.removeRecord(id);
      return current;
    } catch {
      await this.removeRecord(id);
      return null;
    }
  }

  private async readMetadata(
    recordDirectory: string,
  ): Promise<PersistedAttachmentMetadata | null> {
    const path = join(recordDirectory, METADATA_FILE);
    const named = await lstat(path);
    if (
      !named.isFile()
      || named.isSymbolicLink()
      || !isPrivateEntry(named, 0o600)
      || named.size > MAX_METADATA_BYTES
    ) {
      throw new Error("Conversation attachment metadata is unsafe.");
    }
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const file = await open(path, constants.O_RDONLY | noFollow);
    try {
      const before = await file.stat();
      if (!before.isFile() || !sameIdentity(named, before)) {
        throw new Error("Conversation attachment metadata changed.");
      }
      const raw = await file.readFile("utf8");
      const after = await file.stat();
      if (
        after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
      ) throw new Error("Conversation attachment metadata changed.");
      try {
        return metadataFromUnknown(JSON.parse(raw));
      } catch {
        return null;
      }
    } finally {
      await file.close();
    }
  }

  private async persist(
    payload: ConversationAttachmentPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    const metadata = metadataFor(payload);
    const recordDirectory = join(this.directory, metadata.id);
    const stagingName = `.pending-${randomUUID()}`;
    const stagingDirectory = join(this.directory, stagingName);
    let published = false;
    signal?.throwIfAborted();
    await this.assertStoreRoot();
    try {
      const configuredStall = process.env.NODE_ENV === "test"
        && this.persistenceFault?.attachmentId === metadata.id
        ? this.persistenceFault.stallAfterContentSyncMs
        : 0;
      await persistRecordOffThread({
        directory: stagingDirectory,
        contentName: `${metadata.id}.${metadata.extension}`,
        bytes: payload.bytes,
        metadata: JSON.stringify(metadata),
        stallAfterContentSyncMs: Math.max(
          0,
          Math.min(Math.trunc(configuredStall), 60_000),
        ),
      }, signal);
      signal?.throwIfAborted();
      await this.assertStoreRoot();
      await rename(stagingDirectory, recordDirectory);
      published = true;
      signal?.throwIfAborted();
    } catch (error) {
      if (published) {
        await this.removeRecord(metadata.id).catch(() => undefined);
      } else if (signal?.aborted) {
        void this.removeContainedEntry(stagingName).catch(() => undefined);
      } else {
        await this.removeContainedEntry(stagingName).catch(() => undefined);
      }
      throw error;
    }
  }

  private async assertStoreRoot(): Promise<void> {
    const named = await lstat(this.directory);
    if (
      !named.isDirectory()
      || named.isSymbolicLink()
      || !sameIdentity(this.directoryAuthority, named)
      || !isPrivateEntry(named, 0o700)
    ) throw new Error("Conversation attachment storage changed.");
    const canonical = await realpath(this.directory);
    if (canonical !== this.directory) {
      throw new Error("Conversation attachment storage escaped its authority.");
    }
  }

  private async removeRecord(id: string): Promise<void> {
    if (!UUID_PATTERN.test(id)) {
      throw new Error("Invalid conversation attachment identity.");
    }
    await this.removeContainedEntry(id);
  }

  private async removeContainedEntry(name: string): Promise<void> {
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
    await this.assertStoreRoot();
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  }

  private usageFromRecords(): { bytes: number; records: number } {
    const records = this.records ?? new Map<string, number>();
    return {
      records: records.size,
      bytes: [...records.values()].reduce((total, size) => total + size, 0),
    };
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
}
