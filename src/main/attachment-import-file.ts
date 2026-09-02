import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { FILE_OPEN_NO_FOLLOW } from
  "../node/platform-file-open-flags.js";
import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENT_BYTES,
  type ChatAttachmentMimeType,
} from "../shared/attachments.js";
import { validateAttachmentImport } from "./attachment-import.js";

const OWNED_STAGED_ATTACHMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp|gif|pdf|txt|md|csv|json|xlsx|xls)$/iu;
const DECIMAL_IDENTITY = /^\d{1,40}$/u;
const SHA256_DIGEST = /^[0-9a-f]{64}$/u;

export interface AttachmentImportFileOperation {
  readonly root: string;
  readonly rootDev: string;
  readonly rootIno: string;
  readonly rootUid: string | null;
  readonly fileName: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly stallBeforeValidationMs: number;
}

export interface AttachmentImportValidationReceipt {
  readonly displayName: string;
  readonly mimeType: ChatAttachmentMimeType;
  readonly extension: string;
  readonly size: number;
  readonly digest: string;
}

export interface AttachmentImportValidationExecution {
  readonly result: Promise<AttachmentImportValidationReceipt>;
  readonly stopped: Promise<void>;
}

export interface AttachmentImportValidationRunner {
  (
    operation: AttachmentImportFileOperation,
    signal?: AbortSignal,
  ): AttachmentImportValidationExecution;
  shutdown?(): Promise<boolean>;
}

export type AttachmentImportValidationFailure = "content" | "unsafe";

export class AttachmentImportValidationError extends Error {
  constructor(readonly code: AttachmentImportValidationFailure) {
    super(code === "content"
      ? "Attachment content does not match its safe file type."
      : "Temporary attachment storage could not be verified safely.");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAttachmentImportFileOperation(
  value: unknown,
): AttachmentImportFileOperation | null {
  if (!record(value) || Object.keys(value).length !== 9) return null;
  if (
    typeof value.root !== "string"
    || !isAbsolute(value.root)
    || value.root.length > 4_096
    || /[\0\r\n]/u.test(value.root)
    || typeof value.rootDev !== "string"
    || !DECIMAL_IDENTITY.test(value.rootDev)
    || typeof value.rootIno !== "string"
    || !DECIMAL_IDENTITY.test(value.rootIno)
    || !(
      value.rootUid === null
      || (typeof value.rootUid === "string"
        && DECIMAL_IDENTITY.test(value.rootUid))
    )
    || typeof value.fileName !== "string"
    || !OWNED_STAGED_ATTACHMENT.test(value.fileName)
    || typeof value.name !== "string"
    || value.name.length < 1
    || value.name.length > 255
    || /[\0-\x1f\x7f]/u.test(value.name)
    || typeof value.mimeType !== "string"
    || value.mimeType.length > 255
    || /[\0-\x1f\x7f]/u.test(value.mimeType)
    || typeof value.size !== "number"
    || !Number.isSafeInteger(value.size)
    || value.size < 1
    || value.size > MAX_CHAT_ATTACHMENT_BYTES
    || typeof value.stallBeforeValidationMs !== "number"
    || !Number.isSafeInteger(value.stallBeforeValidationMs)
    || value.stallBeforeValidationMs < 0
    || value.stallBeforeValidationMs > 60_000
  ) return null;
  return {
    root: value.root,
    rootDev: value.rootDev,
    rootIno: value.rootIno,
    rootUid: value.rootUid,
    fileName: value.fileName,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
    stallBeforeValidationMs: value.stallBeforeValidationMs,
  };
}

export function parseAttachmentImportValidationReceipt(
  value: unknown,
): AttachmentImportValidationReceipt | null {
  if (!record(value) || Object.keys(value).length !== 5) return null;
  if (
    typeof value.displayName !== "string"
    || value.displayName.length < 1
    || value.displayName.length > 255
    || /[\0-\x1f\x7f]/u.test(value.displayName)
    || typeof value.mimeType !== "string"
    || !(CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
      value.mimeType,
    )
    || typeof value.extension !== "string"
    || !/^(?:png|jpg|webp|gif|pdf|txt|md|csv|json|xlsx|xls)$/u.test(
      value.extension,
    )
    || typeof value.size !== "number"
    || !Number.isSafeInteger(value.size)
    || value.size < 1
    || value.size > MAX_CHAT_ATTACHMENT_BYTES
    || typeof value.digest !== "string"
    || !SHA256_DIGEST.test(value.digest)
  ) return null;
  return {
    displayName: value.displayName,
    mimeType: value.mimeType as ChatAttachmentMimeType,
    extension: value.extension,
    size: value.size,
    digest: value.digest,
  };
}

function sameIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateEntry(
  entry: { mode: bigint; uid: bigint },
  mode: 0o600 | 0o700,
): boolean {
  return process.platform === "win32"
    || (
      (entry.mode & 0o777n) === BigInt(mode)
      && (
        typeof process.getuid !== "function"
        || entry.uid === BigInt(process.getuid())
      )
    );
}

async function assertRoot(
  operation: AttachmentImportFileOperation,
  requirePinnedCwd: boolean,
): Promise<void> {
  const named = await lstat(operation.root, { bigint: true });
  const canonical = await realpath(operation.root);
  if (
    !named.isDirectory()
    || named.isSymbolicLink()
    || canonical !== operation.root
    || String(named.dev) !== operation.rootDev
    || String(named.ino) !== operation.rootIno
    || !privateEntry(named, 0o700)
    || (
      process.platform !== "win32"
      && String(named.uid) !== operation.rootUid
    )
  ) throw new AttachmentImportValidationError("unsafe");
  if (!requirePinnedCwd) return;
  const [pinned, pinnedCanonical] = await Promise.all([
    stat(".", { bigint: true }),
    realpath("."),
  ]);
  if (
    !pinned.isDirectory()
    || !sameIdentity(named, pinned)
    || pinnedCanonical !== canonical
  ) throw new AttachmentImportValidationError("unsafe");
}

export async function validateAttachmentImportFile(
  value: unknown,
  options: {
    readonly requirePinnedCwd?: boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<AttachmentImportValidationReceipt> {
  const operation = parseAttachmentImportFileOperation(value);
  if (!operation) throw new AttachmentImportValidationError("unsafe");
  const signal = options.signal;
  signal?.throwIfAborted();
  await assertRoot(operation, options.requirePinnedCwd === true);
  const path = join(operation.root, operation.fileName);
  const named = await lstat(path, { bigint: true });
  const canonical = await realpath(path);
  if (
    !named.isFile()
    || named.isSymbolicLink()
    || named.nlink !== 1n
    || named.size !== BigInt(operation.size)
    || !privateEntry(named, 0o600)
    || canonical !== path
  ) throw new AttachmentImportValidationError("unsafe");

  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  const nonBlocking = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
  const file = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || !sameIdentity(named, before)
      || before.size !== BigInt(operation.size)
      || !privateEntry(before, 0o600)
    ) throw new AttachmentImportValidationError("unsafe");
    signal?.throwIfAborted();
    if (operation.stallBeforeValidationMs > 0) {
      await wait(operation.stallBeforeValidationMs, undefined, { signal });
    }
    const bytes = Buffer.allocUnsafe(operation.size);
    let readOffset = 0;
    while (readOffset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        bytes,
        readOffset,
        bytes.length - readOffset,
        readOffset,
      );
      if (bytesRead === 0) break;
      readOffset += bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const { bytesRead: overflowBytes } = await file.read(
      overflowProbe,
      0,
      overflowProbe.length,
      operation.size,
    );
    if (readOffset !== operation.size || overflowBytes !== 0) {
      throw new AttachmentImportValidationError("unsafe");
    }
    const after = await file.stat({ bigint: true });
    signal?.throwIfAborted();
    if (
      !after.isFile()
      || after.nlink !== 1n
      || !sameIdentity(before, after)
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || !privateEntry(after, 0o600)
    ) throw new AttachmentImportValidationError("unsafe");
    await assertRoot(operation, options.requirePinnedCwd === true);
    let validated;
    try {
      validated = validateAttachmentImport({
        name: operation.name,
        mimeType: operation.mimeType,
        data: bytes,
      });
    } catch {
      throw new AttachmentImportValidationError("content");
    }
    if (
      validated.size !== operation.size
      || operation.fileName !== `${operation.fileName.slice(0, 36)}.${validated.extension}`
    ) throw new AttachmentImportValidationError("unsafe");
    signal?.throwIfAborted();
    const [finalPinned, finalNamed, finalCanonical] = await Promise.all([
      file.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    if (
      !finalPinned.isFile()
      || !finalNamed.isFile()
      || finalNamed.isSymbolicLink()
      || finalPinned.nlink !== 1n
      || finalNamed.nlink !== 1n
      || !sameIdentity(after, finalPinned)
      || !sameIdentity(finalPinned, finalNamed)
      || finalPinned.size !== after.size
      || finalPinned.mtimeNs !== after.mtimeNs
      || finalPinned.ctimeNs !== after.ctimeNs
      || finalNamed.size !== finalPinned.size
      || finalNamed.mtimeNs !== finalPinned.mtimeNs
      || finalNamed.ctimeNs !== finalPinned.ctimeNs
      || !privateEntry(finalPinned, 0o600)
      || !privateEntry(finalNamed, 0o600)
      || finalCanonical !== path
    ) throw new AttachmentImportValidationError("unsafe");
    await assertRoot(operation, options.requirePinnedCwd === true);
    return {
      displayName: validated.displayName,
      mimeType: validated.mimeType,
      extension: validated.extension,
      size: validated.size,
      digest: validated.digest,
    };
  } finally {
    await file.close();
  }
}

export const inProcessAttachmentImportValidationRunner:
AttachmentImportValidationRunner = (operation, signal) => ({
  result: validateAttachmentImportFile(operation, { signal }),
  stopped: Promise.resolve(),
});
