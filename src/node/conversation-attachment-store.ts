import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
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

async function secureStoreDirectory(dataDirectory: string): Promise<string> {
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
  return canonical;
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
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private readonly validate?: ConversationAttachmentValidator;
  private records: Map<string, number> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    directory: string,
    options: ConversationAttachmentStoreOptions,
  ) {
    this.directory = directory;
    this.maxBytes = boundedLimit(options.maxBytes, MAX_PERSISTED_BYTES);
    this.maxRecords = boundedLimit(options.maxRecords, MAX_PERSISTED_RECORDS);
    this.validate = options.validate;
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
  ): Promise<ChatAttachment[]> {
    if (payloads.length === 0) return [];
    return await this.serialize(async () => {
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
      const newPayloads: ConversationAttachmentPayload[] = [];
      for (const payload of unique.values()) {
        const current = await this.inspect(payload.attachment.id);
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
          await this.persist(payload);
          created.push(payload.attachment.id);
        }
      } catch (error) {
        await Promise.allSettled(created.map((id) => this.removeRecord(id)));
        throw error;
      }
      for (const payload of newPayloads) {
        this.records?.set(payload.attachment.id, payload.attachment.size);
      }
      return [...unique.keys()].map((id) => {
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

  async release(ids: readonly string[]): Promise<void> {
    await this.serialize(async () => {
      for (const id of new Set(ids)) {
        if (!UUID_PATTERN.test(id)) {
          throw new Error("Invalid conversation attachment identity.");
        }
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
          throw new Error("Conversation attachment storage contains an unexpected entry.");
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
        throw new Error("Conversation attachment storage contains an unexpected entry.");
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

  private async persist(payload: ConversationAttachmentPayload): Promise<void> {
    const metadata = metadataFor(payload);
    const recordDirectory = join(this.directory, metadata.id);
    await mkdir(recordDirectory, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(recordDirectory, 0o700);
    try {
      const contentPath = join(
        recordDirectory,
        `${metadata.id}.${metadata.extension}`,
      );
      const content = await open(
        contentPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await content.writeFile(payload.bytes);
        await content.sync();
      } finally {
        await content.close();
      }
      if (process.platform !== "win32") await chmod(contentPath, 0o600);
      const metadataPath = join(recordDirectory, METADATA_FILE);
      const manifest = await open(
        metadataPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await manifest.writeFile(JSON.stringify(metadata), "utf8");
        await manifest.sync();
      } finally {
        await manifest.close();
      }
      if (process.platform !== "win32") await chmod(metadataPath, 0o600);
    } catch (error) {
      await this.removeRecord(metadata.id).catch(() => undefined);
      throw error;
    }
  }

  private async removeRecord(id: string): Promise<void> {
    if (!UUID_PATTERN.test(id)) {
      throw new Error("Invalid conversation attachment identity.");
    }
    const target = join(this.directory, id);
    if (dirname(target) !== this.directory) {
      throw new Error("Conversation attachment cleanup escaped storage.");
    }
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
