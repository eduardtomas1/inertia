import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
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
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENTS,
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

export type ConversationAttachmentStoreOperation = {
  readonly operation: "persist";
  readonly root: string;
  readonly rootDev: string;
  readonly rootIno: string;
  readonly rootUid: string | null;
  readonly id: string;
  readonly stagingName: string;
  readonly extension: string;
  readonly bytes: Uint8Array;
  readonly metadata: string;
  readonly stallBeforePublishMs: number;
} | {
  readonly operation: "remove";
  readonly root: string;
  readonly rootDev: string;
  readonly rootIno: string;
  readonly rootUid: string | null;
  readonly name: string;
};

export type ConversationAttachmentStoreOperationRunner = (
  operation: ConversationAttachmentStoreOperation,
  signal?: AbortSignal,
) => { readonly result: Promise<void>; readonly stopped: Promise<void> };

export interface ConversationAttachmentStoreOptions {
  readonly maxBytes?: number;
  readonly maxRecords?: number;
  readonly validate?: ConversationAttachmentValidator;
  readonly persistenceFault?: {
    readonly attachmentId: string;
    readonly stallBeforePublishMs: number;
  };
  /** Deterministic store-operation seam for unit tests; production uses the bounded child. */
  readonly operationRunner?: ConversationAttachmentStoreOperationRunner;
}

interface StoreDirectoryAuthority {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: string | null;
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

function sameExactIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
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
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const directoryOnly = "O_DIRECTORY" in constants
      ? constants.O_DIRECTORY
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

const STORE_CHILD_TIMEOUT_MS = 30_000;
const MAX_PERSIST_CHILD_OUTPUT_BYTES = 4_096;
const MAX_PERSIST_CHILD_INPUT_BYTES = 16 * 1024 * 1024;
const ATTACHMENT_STORAGE_EXTENSIONS = [...new Set(
  CHAT_ATTACHMENT_MIME_TYPES.map(chatAttachmentStorageExtension),
)];
const PERSIST_CHILD_SOURCE = `
  const { constants } = require("node:fs");
  const { chmod, lstat, mkdir, open, realpath, rename, rm } = require("node:fs/promises");
  const { join } = require("node:path");

  const MAX_INPUT_BYTES = ${MAX_PERSIST_CHILD_INPUT_BYTES};
  const MAX_ATTACHMENT_BYTES = ${MAX_CHAT_ATTACHMENT_BYTES};
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const PENDING = /^\\.pending-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
  const EXTENSIONS = new Set(${JSON.stringify(ATTACHMENT_STORAGE_EXTENSIONS)});

  async function readInput() {
    process.stdin.setEncoding("utf8");
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) {
        throw new Error("Input exceeded the persistence bound.");
      }
    }
    return JSON.parse(raw);
  }

  async function syncDirectory(path) {
    if (process.platform === "win32") return;
    const directoryOnly = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
    const directory = await open(path, constants.O_RDONLY | directoryOnly);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async function verifyRoot(input) {
    const root = await lstat(".", { bigint: true });
    const canonical = await realpath(".");
    if (
      !root.isDirectory()
      || root.isSymbolicLink()
      || typeof input.root !== "string"
      || canonical !== input.root
      || String(root.dev) !== input.rootDev
      || String(root.ino) !== input.rootIno
      || (
        process.platform !== "win32"
        && (
          Number(root.mode & 0o777n) !== 0o700
          || String(root.uid) !== input.rootUid
        )
      )
    ) throw new Error("The attachment root authority changed.");
  }

  async function persist(input) {
    if (
      !input
      || typeof input !== "object"
      || input.operation !== "persist"
      || !UUID.test(input.id)
      || !PENDING.test(input.stagingName)
      || !EXTENSIONS.has(input.extension)
      || typeof input.metadata !== "string"
      || Buffer.byteLength(input.metadata, "utf8") > ${MAX_METADATA_BYTES}
      || typeof input.bytesBase64 !== "string"
      || typeof input.rootDev !== "string"
      || typeof input.rootIno !== "string"
      || !(
        input.rootUid === null
        || typeof input.rootUid === "string"
      )
      || !Number.isSafeInteger(input.stallBeforePublishMs)
      || input.stallBeforePublishMs < 0
      || input.stallBeforePublishMs > 60_000
    ) throw new Error("The persistence request is invalid.");
    const bytes = Buffer.from(input.bytesBase64, "base64");
    if (
      bytes.length < 1
      || bytes.length > MAX_ATTACHMENT_BYTES
      || bytes.toString("base64") !== input.bytesBase64
    ) throw new Error("The persistence bytes are invalid.");
    const metadata = JSON.parse(input.metadata);
    if (metadata.id !== input.id || metadata.extension !== input.extension) {
      throw new Error("The persistence metadata is invalid.");
    }
    await verifyRoot(input);
    let published = false;
    try {
      await mkdir(input.stagingName, { mode: 0o700 });
      if (process.platform !== "win32") {
        await chmod(input.stagingName, 0o700);
      }
      const contentPath = join(
        input.stagingName,
        input.id + "." + input.extension,
      );
      const content = await open(
        contentPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await content.writeFile(bytes);
        await content.sync();
      } finally {
        await content.close();
      }
      if (process.platform !== "win32") await chmod(contentPath, 0o600);
      const metadataPath = join(input.stagingName, ${JSON.stringify(METADATA_FILE)});
      const manifest = await open(
        metadataPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await manifest.writeFile(input.metadata, "utf8");
        await manifest.sync();
      } finally {
        await manifest.close();
      }
      if (process.platform !== "win32") await chmod(metadataPath, 0o600);
      await syncDirectory(input.stagingName);
      if (input.stallBeforePublishMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, input.stallBeforePublishMs);
        });
      }
      await verifyRoot(input);
      await rename(input.stagingName, input.id);
      published = true;
      await syncDirectory(".");
    } catch (error) {
      await rm(published ? input.id : input.stagingName, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      }).catch(() => undefined);
      await syncDirectory(".").catch(() => undefined);
      throw error;
    }
  }

  async function removeEntry(input) {
    if (
      !input
      || typeof input !== "object"
      || input.operation !== "remove"
      || typeof input.name !== "string"
      || input.name.length < 1
      || input.name.length > 255
      || input.name === "."
      || input.name === ".."
      || /[\\/\\\\\\0\\r\\n]/u.test(input.name)
      || typeof input.rootDev !== "string"
      || typeof input.rootIno !== "string"
      || !(
        input.rootUid === null
        || typeof input.rootUid === "string"
      )
    ) throw new Error("The cleanup request is invalid.");
    await verifyRoot(input);
    await rm(input.name, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
    await syncDirectory(".");
  }

  void readInput().then((input) => (
    input && input.operation === "remove"
      ? removeEntry(input)
      : persist(input)
  )).then(
    () => process.stdout.write(JSON.stringify({ ok: true })),
    () => process.stdout.write(JSON.stringify({ ok: false })),
  );
`;

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Conversation attachment retention was cancelled.");
}

function persistenceChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR"] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function runStoreChild(
  input: ConversationAttachmentStoreOperation,
  signal?: AbortSignal,
): { readonly result: Promise<void>; readonly stopped: Promise<void> } {
  let stopReceipt!: () => void;
  const stopped = new Promise<void>((resolveStopped) => {
    stopReceipt = resolveStopped;
  });
  if (signal?.aborted) {
    stopReceipt();
    return {
      result: Promise.reject(cancellationError(signal)),
      stopped,
    };
  }
  const encodedInput = JSON.stringify(input.operation === "persist"
    ? {
        ...input,
        bytes: undefined,
        bytesBase64: Buffer.from(input.bytes).toString("base64"),
      }
    : input);
  if (Buffer.byteLength(encodedInput, "utf8") > MAX_PERSIST_CHILD_INPUT_BYTES) {
    stopReceipt();
    return {
      result: Promise.reject(new Error("Conversation attachment persistence input is too large.")),
      stopped,
    };
  }
  const child = spawn(process.execPath, ["--no-warnings", "-e", PERSIST_CHILD_SOURCE], {
    cwd: input.root,
    env: persistenceChildEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const result = new Promise<void>((resolvePersist, rejectPersist) => {
    let output = "";
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPersist(error);
      else resolvePersist();
    };
    const kill = (): void => {
      child.stdin.destroy();
      child.unref();
      if (process.platform === "win32") child.kill();
      else child.kill("SIGKILL");
    };
    const abort = (): void => {
      const error = signal
        ? cancellationError(signal)
        : new Error("Conversation attachment retention was cancelled.");
      finish(error);
      kill();
    };
    const timer = setTimeout(() => {
      finish(new Error("Conversation attachment persistence timed out."));
      kill();
    }, STORE_CHILD_TIMEOUT_MS);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > MAX_PERSIST_CHILD_OUTPUT_BYTES) {
        finish(new Error("Conversation attachment persistence returned too much output."));
        kill();
      }
    });
    child.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (code) => {
      stopReceipt();
      if (settled) return;
      let receipt: unknown;
      try {
        receipt = JSON.parse(output);
      } catch {
        receipt = null;
      }
      finish(
        code === 0
          && typeof receipt === "object"
          && receipt !== null
          && "ok" in receipt
          && receipt.ok === true
          ? undefined
          : new Error("Conversation attachment persistence failed."),
      );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(encodedInput, "utf8");
  });
  return { result, stopped };
}

export class ConversationAttachmentStore {
  readonly directory: string;
  private readonly directoryAuthority: StoreDirectoryAuthority;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private readonly validate?: ConversationAttachmentValidator;
  private readonly persistenceFault?: ConversationAttachmentStoreOptions["persistenceFault"];
  private readonly operationRunner: ConversationAttachmentStoreOperationRunner;
  private readonly authoritativeRecords = new Set<string>();
  private readonly retentionRecords = new Map<string, Set<string>>();
  private readonly recordRetentions = new Map<string, Set<string>>();
  private readonly activeStagingRecords = new Map<string, string>();
  private readonly pendingRecordBytes = new Map<string, number>();
  private readonly pendingRetentionRecords = new Map<string, Set<string>>();
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
    this.operationRunner = process.env.NODE_ENV === "test"
      ? options.operationRunner ?? runStoreChild
      : runStoreChild;
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
      const reserved = this.reservedUsage();
      if (
        usage.records + reserved.records + newPayloads.length > this.maxRecords
        || usage.bytes + reserved.bytes + newBytes > this.maxBytes
      ) {
        throw new Error("Conversation attachment storage is full.");
      }
      if (newPayloads.length > 0) {
        if (newPayloads.some(({ attachment }) =>
          this.pendingRecordBytes.has(attachment.id))) {
          throw new Error("Conversation attachment storage is still cleaning up.");
        }
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
    if (!this.retentionRecords.has(retentionId)) return;
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
        if (this.activeStagingRecords.has(name)) continue;
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
      this.reconcilePendingRecords(records);
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
    const stagingName = `.pending-${randomUUID()}`;
    signal?.throwIfAborted();
    this.activeStagingRecords.set(stagingName, metadata.id);
    const configuredStall = process.env.NODE_ENV === "test"
      && this.persistenceFault?.attachmentId === metadata.id
      ? this.persistenceFault.stallBeforePublishMs
      : 0;
    let persistence: ReturnType<ConversationAttachmentStoreOperationRunner>;
    try {
      persistence = this.operationRunner({
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
      }, signal);
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
        if (recordRemoved) this.records?.delete(id);
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
          this.clearPendingRecord(id);
        }
      }
    });
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
    const cleanup = this.operationRunner({
      operation: "remove",
      root: this.directory,
      rootDev: this.directoryAuthority.dev,
      rootIno: this.directoryAuthority.ino,
      rootUid: this.directoryAuthority.uid,
      name,
    });
    await cleanup.result;
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
}
