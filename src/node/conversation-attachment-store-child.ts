import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENT_BYTES,
  chatAttachmentStorageExtension,
} from "../shared/attachments.js";
import {
  FILE_OPEN_DIRECTORY,
  FILE_OPEN_NO_FOLLOW,
} from "./platform-file-open-flags.js";

const STORE_CHILD_TIMEOUT_MS = 30_000;
const MAX_METADATA_BYTES = 4 * 1024;
const MAX_MUTATION_CHILD_OUTPUT_BYTES = 4_096;
const MAX_READ_CHILD_OUTPUT_BYTES = Math.ceil(MAX_CHAT_ATTACHMENT_BYTES / 3)
  * 4 + MAX_METADATA_BYTES * 2 + 1_024;
export const MAX_CONVERSATION_ATTACHMENT_STORE_OPERATION_BYTES =
  16 * 1024 * 1024;
const METADATA_FILE = "metadata.json";
const ATTACHMENT_STORAGE_EXTENSIONS = [...new Set(
  CHAT_ATTACHMENT_MIME_TYPES.map(chatAttachmentStorageExtension),
)];

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

export interface ConversationAttachmentStoreReadOperation {
  readonly operation: "read";
  readonly root: string;
  readonly rootDev: string;
  readonly rootIno: string;
  readonly rootUid: string | null;
  readonly id: string;
  readonly stallBeforeRecordRevalidateMs: number;
}

export type ConversationAttachmentStoreReadReceipt = {
  readonly missing: true;
} | {
  readonly missing: false;
  readonly metadata: string;
  readonly bytes: Uint8Array;
};

export interface ConversationAttachmentStoreOperationRunner {
  (
    operation: ConversationAttachmentStoreOperation,
    signal?: AbortSignal,
  ): {
    readonly result: Promise<void>;
    readonly stopped: Promise<void>;
    /** Resolves only after the exact spawned helper has exited. */
    readonly termination?: Promise<void>;
    readonly ready?: Promise<boolean>;
  };
}

export interface ConversationAttachmentStoreReadOperationRunner {
  (
    operation: ConversationAttachmentStoreReadOperation,
    signal?: AbortSignal,
  ): {
    readonly result: Promise<ConversationAttachmentStoreReadReceipt>;
    readonly stopped: Promise<void>;
    /** Resolves only after the exact spawned helper has exited. */
    readonly termination?: Promise<void>;
    readonly ready?: Promise<boolean>;
  };
}

export type ConversationAttachmentStoreAnyOperationRunner =
  ConversationAttachmentStoreOperationRunner
  & ConversationAttachmentStoreReadOperationRunner;

export interface ConversationAttachmentStoreAuthority {
  readonly root: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: string | null;
}

export const CONVERSATION_ATTACHMENT_STORE_OPERATION_SOURCE = `
  const { constants } = require("node:fs");
  const { chmod, lstat, mkdir, open, realpath, rename, rm } = require("node:fs/promises");
  const { join } = require("node:path");

  const MAX_INPUT_BYTES = ${MAX_CONVERSATION_ATTACHMENT_STORE_OPERATION_BYTES};
  const MAX_ATTACHMENT_BYTES = ${MAX_CHAT_ATTACHMENT_BYTES};
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const PENDING = /^\\.pending-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
  const EXTENSIONS = new Set(${JSON.stringify(ATTACHMENT_STORAGE_EXTENSIONS)});

  async function syncDirectory(path) {
    if (process.platform === "win32") return;
    const directoryOnly = ${FILE_OPEN_DIRECTORY};
    const directory = await open(path, constants.O_RDONLY | directoryOnly);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  function privateEntry(entry, mode) {
    return process.platform === "win32"
      || (
        Number(entry.mode & 0o777n) === mode
        && (
          typeof process.getuid !== "function"
          || entry.uid === BigInt(process.getuid())
        )
      );
  }

  async function verifyRoot(input, path = ".") {
    const root = await lstat(path, { bigint: true });
    const canonical = await realpath(path);
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
          !privateEntry(root, 0o700)
          || String(root.uid) !== input.rootUid
        )
      )
    ) throw new Error("The attachment root authority changed.");
  }

  async function readBoundedFile(
    path,
    maximum,
    nonBlocking = false,
    minimum = 1,
  ) {
    const named = await lstat(path, { bigint: true });
    if (
      !named.isFile()
      || named.isSymbolicLink()
      || !privateEntry(named, 0o600)
      || named.size < BigInt(minimum)
      || named.size > BigInt(maximum)
    ) throw new Error("The attachment file is unsafe.");
    const noFollow = ${FILE_OPEN_NO_FOLLOW};
    const nonBlock = nonBlocking && "O_NONBLOCK" in constants
      ? constants.O_NONBLOCK
      : 0;
    const file = await open(path, constants.O_RDONLY | noFollow | nonBlock);
    try {
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile()
        || before.dev !== named.dev
        || before.ino !== named.ino
        || before.size !== named.size
        || before.mode !== named.mode
        || before.uid !== named.uid
        || before.mtimeNs !== named.mtimeNs
        || before.ctimeNs !== named.ctimeNs
        || !privateEntry(before, 0o600)
      ) throw new Error("The attachment file changed.");
      const expectedSize = Number(before.size);
      const bytes = Buffer.alloc(expectedSize);
      let offset = 0;
      while (offset < expectedSize) {
        const { bytesRead } = await file.read(
          bytes,
          offset,
          expectedSize - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const overflow = Buffer.alloc(1);
      const { bytesRead: overflowBytes } = await file.read(
        overflow,
        0,
        1,
        expectedSize,
      );
      const after = await file.stat({ bigint: true });
      if (
        offset !== expectedSize
        || overflowBytes !== 0
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mode !== before.mode
        || after.uid !== before.uid
        || after.mtimeNs !== before.mtimeNs
        || after.ctimeNs !== before.ctimeNs
        || !privateEntry(after, 0o600)
      ) throw new Error("The attachment file changed.");
      return { bytes, named };
    } finally {
      await file.close();
    }
  }

  async function verifyNamedFile(path, expected) {
    const current = await lstat(path, { bigint: true });
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.dev !== expected.dev
      || current.ino !== expected.ino
      || current.size !== expected.size
      || current.mode !== expected.mode
      || current.uid !== expected.uid
      || current.mtimeNs !== expected.mtimeNs
      || current.ctimeNs !== expected.ctimeNs
      || !privateEntry(current, 0o600)
    ) throw new Error("The attachment file name changed.");
  }

  async function readRecord(input, onReadReady) {
    if (
      !input
      || typeof input !== "object"
      || input.operation !== "read"
      || !UUID.test(input.id)
      || typeof input.rootDev !== "string"
      || typeof input.rootIno !== "string"
      || !(input.rootUid === null || typeof input.rootUid === "string")
      || !Number.isSafeInteger(input.stallBeforeRecordRevalidateMs)
      || input.stallBeforeRecordRevalidateMs < 0
      || input.stallBeforeRecordRevalidateMs > 60_000
    ) throw new Error("The read request is invalid.");
    await verifyRoot(input);
    let named;
    try {
      named = await lstat(input.id, { bigint: true });
    } catch (error) {
      if (error && error.code === "ENOENT") return { missing: true };
      throw error;
    }
    if (
      !named.isDirectory()
      || named.isSymbolicLink()
      || !privateEntry(named, 0o700)
    ) throw new Error("The attachment record is unsafe.");
    process.chdir(input.id);
    const opened = await lstat(".", { bigint: true });
    if (
      !opened.isDirectory()
      || opened.isSymbolicLink()
      || opened.dev !== named.dev
      || opened.ino !== named.ino
      || !privateEntry(opened, 0o700)
    ) throw new Error("The attachment record changed.");
    await verifyRoot(input, "..");
    const metadataRead = await readBoundedFile(
      ${JSON.stringify(METADATA_FILE)},
      ${MAX_METADATA_BYTES},
      false,
      0,
    );
    const metadata = metadataRead.bytes.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return { missing: true };
    }
    if (
      !parsed
      || typeof parsed !== "object"
      || parsed.id !== input.id
      || !EXTENSIONS.has(parsed.extension)
      || !Number.isSafeInteger(parsed.size)
      || parsed.size < 1
      || parsed.size > MAX_ATTACHMENT_BYTES
    ) return { missing: true };
    const contentPath = input.id + "." + parsed.extension;
    const contentRead = await readBoundedFile(
      contentPath,
      MAX_ATTACHMENT_BYTES,
      true,
    );
    const bytes = contentRead.bytes;
    if (bytes.length !== parsed.size) {
      throw new Error("The attachment content changed.");
    }
    if (input.stallBeforeRecordRevalidateMs > 0) {
      onReadReady();
      await new Promise((resolve) => {
        setTimeout(resolve, input.stallBeforeRecordRevalidateMs);
      });
    }
    const rebound = await lstat(join("..", input.id), { bigint: true });
    if (
      !rebound.isDirectory()
      || rebound.isSymbolicLink()
      || rebound.dev !== named.dev
      || rebound.ino !== named.ino
      || !privateEntry(rebound, 0o700)
    ) throw new Error("The attachment record name changed.");
    await verifyRoot(input, "..");
    await verifyNamedFile(${JSON.stringify(METADATA_FILE)}, metadataRead.named);
    await verifyNamedFile(contentPath, contentRead.named);
    return {
      missing: false,
      metadata,
      bytesBase64: bytes.toString("base64"),
    };
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
      || !(input.rootUid === null || typeof input.rootUid === "string")
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
      if (process.platform !== "win32") await chmod(input.stagingName, 0o700);
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
      || !(input.rootUid === null || typeof input.rootUid === "string")
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

  async function performConversationAttachmentStoreOperation(
    input,
    onReadReady = () => undefined,
  ) {
    return (
    input && input.operation === "remove"
      ? removeEntry(input)
      : input && input.operation === "read"
        ? readRecord(input, onReadReady)
        : persist(input)
    );
  }
`;

const STORE_CHILD_SOURCE = `
  const { writeSync } = require("node:fs");
  ${CONVERSATION_ATTACHMENT_STORE_OPERATION_SOURCE}

  async function readInput() {
    process.stdin.setEncoding("utf8");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_INPUT_BYTES) {
        throw new Error("Input exceeded the attachment-operation bound.");
      }
    }
    return JSON.parse(chunks.join(""));
  }

  void readInput().then((input) =>
    performConversationAttachmentStoreOperation(
      input,
      () => writeSync(3, ${JSON.stringify("read-ready\n")}),
    )
  ).then(
    (receipt) => process.stdout.write(JSON.stringify({
      ok: true,
      ...(receipt || {}),
    })),
    () => process.stdout.write(JSON.stringify({ ok: false })),
  );
`;

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Conversation attachment retention was cancelled.");
}

export function encodeConversationAttachmentStoreOperation(
  input: ConversationAttachmentStoreOperation
    | ConversationAttachmentStoreReadOperation,
): string {
  return JSON.stringify(input.operation === "persist"
    ? {
        ...input,
        bytes: undefined,
        bytesBase64: Buffer.from(input.bytes).toString("base64"),
      }
    : input);
}

export function decodeConversationAttachmentStoreOperation(
  encoded: string,
): ConversationAttachmentStoreOperation
  | ConversationAttachmentStoreReadOperation
  | null {
  if (
    Buffer.byteLength(encoded, "utf8")
      > MAX_CONVERSATION_ATTACHMENT_STORE_OPERATION_BYTES
  ) return null;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const operation = value as Record<string, unknown>;
  if (
    operation.operation !== "persist"
    && operation.operation !== "read"
    && operation.operation !== "remove"
  ) return null;
  if (operation.operation !== "persist") {
    return operation as unknown as ConversationAttachmentStoreReadOperation
      | ConversationAttachmentStoreOperation;
  }
  if (typeof operation.bytesBase64 !== "string") return null;
  const bytes = Buffer.from(operation.bytesBase64, "base64");
  if (
    bytes.length < 1
    || bytes.length > MAX_CHAT_ATTACHMENT_BYTES
    || bytes.toString("base64") !== operation.bytesBase64
  ) return null;
  const { bytesBase64: _bytesBase64, ...rest } = operation;
  return {
    ...rest,
    bytes,
  } as unknown as ConversationAttachmentStoreOperation;
}

function storeChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR"] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

export function runConversationAttachmentStoreChild(
  input: ConversationAttachmentStoreOperation,
  signal?: AbortSignal,
): {
  readonly result: Promise<void>;
  readonly stopped: Promise<void>;
  readonly ready: Promise<boolean>;
};
export function runConversationAttachmentStoreChild(
  input: ConversationAttachmentStoreReadOperation,
  signal?: AbortSignal,
): {
  readonly result: Promise<ConversationAttachmentStoreReadReceipt>;
  readonly stopped: Promise<void>;
  readonly ready: Promise<boolean>;
};
export function runConversationAttachmentStoreChild(
  input:
    | ConversationAttachmentStoreOperation
    | ConversationAttachmentStoreReadOperation,
  signal?: AbortSignal,
): {
  readonly result: Promise<void | ConversationAttachmentStoreReadReceipt>;
  readonly stopped: Promise<void>;
  readonly ready: Promise<boolean>;
} {
  let stopReceipt!: () => void;
  let readyReceipt!: (observed: boolean) => void;
  const stopped = new Promise<void>((resolveStopped) => {
    stopReceipt = resolveStopped;
  });
  const ready = new Promise<boolean>((resolveReady) => {
    readyReceipt = resolveReady;
  });
  if (signal?.aborted) {
    stopReceipt();
    readyReceipt(false);
    return {
      result: Promise.reject(cancellationError(signal)),
      stopped,
      ready,
    };
  }
  const encodedInput = encodeConversationAttachmentStoreOperation(input);
  if (
    Buffer.byteLength(encodedInput, "utf8")
      > MAX_CONVERSATION_ATTACHMENT_STORE_OPERATION_BYTES
  ) {
    stopReceipt();
    readyReceipt(false);
    return {
      result: Promise.reject(new Error("Conversation attachment operation input is too large.")),
      stopped,
      ready,
    };
  }
  const child = spawn(process.execPath, ["--no-warnings", "-e", STORE_CHILD_SOURCE], {
    cwd: input.root,
    env: storeChildEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "ignore", "pipe"] as const,
    windowsHide: true,
  });
  const childInput = child.stdin as Writable;
  const childOutput = child.stdout as Readable;
  const readiness = child.stdio[3] as Readable;
  const result = new Promise<void | ConversationAttachmentStoreReadReceipt>((
    resolveOperation,
    rejectOperation,
  ) => {
    const outputChunks: string[] = [];
    let outputBytes = 0;
    let readReadyObserved = false;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (
      error?: Error,
      receipt?: ConversationAttachmentStoreReadReceipt,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectOperation(error);
      else resolveOperation(receipt);
    };
    const kill = (): void => {
      childInput.destroy();
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
    childOutput.setEncoding("utf8");
    readiness.setEncoding("utf8");
    readiness.once("data", () => {
      readReadyObserved = true;
      readyReceipt(true);
    });
    childOutput.on("data", (chunk: string) => {
      if (settled) return;
      outputChunks.push(chunk);
      outputBytes += Buffer.byteLength(chunk, "utf8");
      const maximumOutput = input.operation === "read"
        ? MAX_READ_CHILD_OUTPUT_BYTES
        : MAX_MUTATION_CHILD_OUTPUT_BYTES;
      if (outputBytes > maximumOutput) {
        finish(new Error("Conversation attachment operation returned too much output."));
        kill();
      }
    });
    child.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (code) => {
      stopReceipt();
      readyReceipt(readReadyObserved);
      if (settled) return;
      let receipt: unknown;
      try {
        receipt = JSON.parse(outputChunks.join(""));
      } catch {
        receipt = null;
      }
      if (
        code !== 0
        || typeof receipt !== "object"
        || receipt === null
        || !("ok" in receipt)
        || receipt.ok !== true
      ) {
        finish(new Error(input.operation === "read"
          ? "Conversation attachment read failed because storage is unsafe."
          : `Conversation attachment ${input.operation} failed.`));
        return;
      }
      if (input.operation !== "read") {
        finish();
        return;
      }
      if ("missing" in receipt && receipt.missing === true) {
        finish(undefined, { missing: true });
        return;
      }
      if (
        !("missing" in receipt)
        || receipt.missing !== false
        || !("metadata" in receipt)
        || typeof receipt.metadata !== "string"
        || Buffer.byteLength(receipt.metadata, "utf8") > MAX_METADATA_BYTES
        || !("bytesBase64" in receipt)
        || typeof receipt.bytesBase64 !== "string"
      ) {
        finish(new Error("Conversation attachment read returned an invalid receipt."));
        return;
      }
      const bytes = Buffer.from(receipt.bytesBase64, "base64");
      if (
        bytes.length < 1
        || bytes.length > MAX_CHAT_ATTACHMENT_BYTES
        || bytes.toString("base64") !== receipt.bytesBase64
      ) {
        finish(new Error("Conversation attachment read returned invalid bytes."));
        return;
      }
      finish(undefined, {
        missing: false,
        metadata: receipt.metadata,
        bytes,
      });
    });
    childInput.on("error", () => undefined);
    childInput.end(encodedInput, "utf8");
  });
  return { result, stopped, ready };
}
