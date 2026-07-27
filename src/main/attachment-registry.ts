import { randomUUID } from "node:crypto";
import {
  constants,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  relative,
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

interface AttachmentRegistryRecord extends TrustedRuntimeAttachment {
  readonly extension: string;
}

export interface AttachmentRegistryLimits {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("The attachment request was cancelled.");
}

function boundedLimit(value: number | undefined, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value), maximum))
    : maximum;
}

export class AttachmentRegistry {
  private readonly records = new Map<string, AttachmentRegistryRecord>();
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private importTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    limits: AttachmentRegistryLimits = {},
  ) {
    this.maxRecords = boundedLimit(
      limits.maxRecords,
      MAX_SESSION_ATTACHMENT_RECORDS,
    );
    this.maxBytes = boundedLimit(
      limits.maxBytes,
      MAX_SESSION_ATTACHMENT_BYTES,
    );
  }

  async import(values: readonly unknown[]): Promise<ChatAttachment[]> {
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
      this.records.size + deduplicated.length > this.maxRecords
      || retainedBytes + totalBytes > this.maxBytes
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
      return registered.map(({ digest: _digest, extension: _extension, ...attachment }) =>
        attachment);
    } catch (error) {
      await Promise.all(registered.map(async (attachment) => {
        this.records.delete(attachment.id);
        await unlink(attachment.path).catch(() => undefined);
      }));
      throw error;
    }
  }

  preview(id: string): Pick<ChatAttachment, "path" | "mimeType" | "size"> | null {
    const record = this.records.get(id);
    return record
      ? { path: record.path, mimeType: record.mimeType, size: record.size }
      : null;
  }

  async resolve(
    id: string,
    signal?: AbortSignal,
  ): Promise<TrustedRuntimeAttachment | null> {
    assertNotAborted(signal);
    const record = this.records.get(id);
    if (!record) return null;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
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
    const file = await open(record.path, constants.O_RDONLY | noFollow);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size !== record.size) {
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
    } finally {
      await file.close();
    }
    return {
      id: record.id,
      name: record.name,
      path: canonicalPath,
      mimeType: record.mimeType,
      size: record.size,
      digest: record.digest,
    };
  }

  async release(id: string): Promise<void> {
    const record = this.records.get(id);
    this.records.delete(id);
    if (!record) return;
    await unlink(record.path).catch(() => undefined);
  }

  clear(): void {
    this.records.clear();
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
