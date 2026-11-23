import { attachmentTextValidator } from "../node/attachment-text-validation.js";
import { compressAttachmentImage } from "./attachment-image-compression.js";
import { readAttachment } from "../node/read-attachment.js";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { FILE_OPEN_NO_FOLLOW } from
  "../node/platform-file-open-flags.js";
import {
  ACCEPTED_ATTACHMENT_MIME_TYPES,
  ATTACHMENT_PREVIEW_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_FILE_PREVIEW_BYTES,
  chatAttachmentStorageExtension,
  isExtractedDocumentAttachmentMimeType,
  type ChatAttachmentMimeType,
  type ExtractedDocumentAttachmentMimeType,
  type ImageAttachmentMimeType,
} from "../shared/attachments.js";
import {
  DOCUMENT_EXTRACTION_ERROR_MESSAGES,
  DocumentExtractionError,
} from "../node/document-text-errors.js";
import { extractStructuredDocumentText } from "../node/document-text-extract.js";
import {
  ImageAttachmentTooLargeError,
  imageAttachmentTooLargeMessage,
} from "./attachment-image-validation.js";
import { prepareAttachmentImportMetadata, validateAttachmentImport } from "./attachment-import.js";
import { TextAttachmentError } from "../shared/text-attachment.js";

const STAGED_ATTACHMENT_EXTENSIONS = new Set(
  ACCEPTED_ATTACHMENT_MIME_TYPES.map(chatAttachmentStorageExtension),
);
const OWNED_STAGED_ATTACHMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.([a-z0-9]{1,8})$/iu;
const DECIMAL_IDENTITY = /^\d{1,40}$/u;
const SHA256_DIGEST = /^[0-9a-f]{64}$/u;

function isAllowedStagedFileName(fileName: string): boolean {
  const extension = OWNED_STAGED_ATTACHMENT.exec(fileName)?.[1]?.toLowerCase();
  return extension !== undefined && STAGED_ATTACHMENT_EXTENSIONS.has(extension);
}

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
  readonly normalizeImage?: boolean;
  readonly extractText?: boolean;
}

export interface AttachmentImportValidationReceipt {
  readonly displayName: string;
  readonly mimeType: ChatAttachmentMimeType;
  readonly extension: string;
  readonly size: number;
  readonly digest: string;
  readonly normalized?: true;
  readonly extractedText?: string;
  readonly extractedTruncated?: boolean;
}

export interface AttachmentImportDocumentExtractOperation {
  readonly mimeType: ExtractedDocumentAttachmentMimeType;
  readonly bytes: Uint8Array;
}

export interface AttachmentImportDocumentExtractResult {
  readonly text: string;
  readonly truncated: boolean;
}

export interface AttachmentImportDocumentExtractExecution {
  readonly result: Promise<AttachmentImportDocumentExtractResult>;
  readonly stopped: Promise<void>;
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
  extract?(
    operation: AttachmentImportDocumentExtractOperation,
    signal?: AbortSignal,
  ): AttachmentImportDocumentExtractExecution;
  shutdown?(): Promise<boolean>;
}

export type AttachmentImportValidationFailure =
  | "content"
  | "document-corrupt"
  | "document-empty"
  | "document-encrypted"
  | "document-limit"
  | "image-too-large"
  | "text-content"
  | "text-size"
  | "unsafe";

export interface AttachmentImportImageSize {
  readonly width: number;
  readonly height: number;
}

const MAX_REPORTED_IMAGE_SIDE = 0x7fff_ffff;

export function isReportedImageSide(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_REPORTED_IMAGE_SIDE;
}

function validationFailureMessage(
  code: AttachmentImportValidationFailure,
  image: AttachmentImportImageSize | null,
): string {
  if (code === "text-content" || code === "text-size") {
    return new TextAttachmentError(code).message;
  }
  if (code === "image-too-large" && image) {
    return imageAttachmentTooLargeMessage(image.width, image.height);
  }
  if (
    code === "document-encrypted"
    || code === "document-corrupt"
    || code === "document-empty"
    || code === "document-limit"
  ) {
    return DOCUMENT_EXTRACTION_ERROR_MESSAGES[code];
  }
  return code === "unsafe"
    ? "Temporary attachment storage could not be verified safely."
    : "Attachment content does not match its safe file type.";
}

export class AttachmentImportValidationError extends Error {
  readonly image: AttachmentImportImageSize | null;

  constructor(
    code:
      | "content"
      | "unsafe"
      | "text-content"
      | "text-size"
      | "document-encrypted"
      | "document-corrupt"
      | "document-empty"
      | "document-limit",
  );
  constructor(code: "image-too-large", image: AttachmentImportImageSize);
  constructor(
    readonly code: AttachmentImportValidationFailure,
    image?: AttachmentImportImageSize,
  ) {
    const size = code === "image-too-large" && image
      ? { width: image.width, height: image.height }
      : null;
    super(validationFailureMessage(code, size));
    this.image = size;
  }
}

export function boundExtractedPreviewText(
  text: string,
  alreadyTruncated: boolean,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= ATTACHMENT_PREVIEW_BYTES) {
    return { text, truncated: alreadyTruncated };
  }
  let output = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > ATTACHMENT_PREVIEW_BYTES) break;
    output += ch;
    bytes += size;
  }
  return { text: output, truncated: true };
}

export function extractAttachmentDocumentBytes(
  value: unknown,
): AttachmentImportDocumentExtractResult {
  const operation = parseAttachmentImportDocumentExtractOperation(value);
  if (!operation) throw new AttachmentImportValidationError("unsafe");
  try {
    const extracted = extractStructuredDocumentText(operation.bytes, operation.mimeType);
    return boundExtractedPreviewText(extracted.text, extracted.truncated);
  } catch (error) {
    if (error instanceof DocumentExtractionError) {
      throw new AttachmentImportValidationError(error.code);
    }
    throw new AttachmentImportValidationError("document-corrupt");
  }
}

export function parseAttachmentImportDocumentExtractOperation(
  value: unknown,
): AttachmentImportDocumentExtractOperation | null {
  if (!record(value) || Object.keys(value).length !== 2) return null;
  if (
    typeof value.mimeType !== "string"
    || !isExtractedDocumentAttachmentMimeType(value.mimeType)
    || !(value.bytes instanceof Uint8Array)
    || value.bytes.byteLength < 1
    || value.bytes.byteLength > MAX_FILE_PREVIEW_BYTES
  ) return null;
  return {
    mimeType: value.mimeType,
    bytes: value.bytes,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_OPERATION_KEYS = new Set([
  "root",
  "rootDev",
  "rootIno",
  "rootUid",
  "fileName",
  "name",
  "mimeType",
  "size",
  "stallBeforeValidationMs",
  "normalizeImage",
  "extractText",
]);

export function parseAttachmentImportFileOperation(
  value: unknown,
): AttachmentImportFileOperation | null {
  if (!record(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length < 9
    || keys.length > 11
    || keys.some((key) => !ALLOWED_OPERATION_KEYS.has(key))
    || ("normalizeImage" in value && typeof value.normalizeImage !== "boolean")
    || ("extractText" in value && typeof value.extractText !== "boolean")
  ) return null;
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
    || !isAllowedStagedFileName(value.fileName)
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
    || value.size > MAX_ATTACHMENT_BYTES
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
    ...(value.normalizeImage === true ? { normalizeImage: true } : {}),
    ...(value.extractText === true ? { extractText: true } : {}),
  };
}

const ALLOWED_RECEIPT_KEYS = new Set([
  "displayName",
  "mimeType",
  "extension",
  "size",
  "digest",
  "normalized",
  "extractedText",
  "extractedTruncated",
]);

export function parseAttachmentImportValidationReceipt(
  value: unknown,
): AttachmentImportValidationReceipt | null {
  if (!record(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length < 5
    || keys.length > 8
    || keys.some((key) => !ALLOWED_RECEIPT_KEYS.has(key))
    || ("normalized" in value && value.normalized !== true)
  ) return null;
  const hasExtractedText = "extractedText" in value;
  const hasExtractedTruncated = "extractedTruncated" in value;
  if (hasExtractedText !== hasExtractedTruncated) return null;
  if (
    hasExtractedText
    && (
      typeof value.extractedText !== "string"
      || value.extractedText.includes("\0")
      || Buffer.byteLength(value.extractedText, "utf8") > ATTACHMENT_PREVIEW_BYTES
      || typeof value.extractedTruncated !== "boolean"
    )
  ) return null;
  if (
    typeof value.displayName !== "string"
    || value.displayName.length < 1
    || value.displayName.length > 255
    || /[\0-\x1f\x7f]/u.test(value.displayName)
    || typeof value.mimeType !== "string"
    || !(ACCEPTED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
      value.mimeType,
    )
    || typeof value.extension !== "string"
    || !STAGED_ATTACHMENT_EXTENSIONS.has(value.extension)
    || typeof value.size !== "number"
    || !Number.isSafeInteger(value.size)
    || value.size < 1
    || value.size > MAX_ATTACHMENT_BYTES
    || typeof value.digest !== "string"
    || !SHA256_DIGEST.test(value.digest)
  ) return null;
  return {
    displayName: value.displayName,
    mimeType: value.mimeType as ChatAttachmentMimeType,
    extension: value.extension,
    size: value.size,
    digest: value.digest,
    ...(value.normalized === true ? { normalized: true as const } : {}),
    ...(hasExtractedText
      ? {
          extractedText: value.extractedText as string,
          extractedTruncated: value.extractedTruncated as boolean,
        }
      : {}),
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
    const metadata = prepareAttachmentImportMetadata(operation);
    const text = metadata.mimeType.startsWith("text/") || metadata.mimeType === "application/json" || metadata.mimeType === "application/octet-stream";
    const opaqueRecord = operation.mimeType === "application/octet-stream";
    const validator = text && metadata.mimeType !== "application/octet-stream" && !opaqueRecord
      ? attachmentTextValidator()
      : undefined;
    let readable = validator !== undefined;
    const inspect = validator
      ? (chunk: Buffer): void => {
          if (!readable) return;
          try {
            validator.chunk(chunk);
          } catch {
            readable = false;
          }
        }
      : undefined;
    let read: Awaited<ReturnType<typeof readAttachment>>;
    try {
      read = await readAttachment(file, operation.size, text ? 0 : operation.size, signal, inspect);
    } catch {
      throw new AttachmentImportValidationError("unsafe");
    }
    if (validator && readable) {
      try {
        validator.finish();
      } catch {
        readable = false;
      }
    }
    const opaque = text && (opaqueRecord || (validator !== undefined && !readable));
    const { bytes, digest } = read;
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
    let normalized: Buffer | null = null;
    try {
      if (operation.normalizeImage && metadata.mimeType.startsWith("image/")) {
        normalized = await compressAttachmentImage(bytes, metadata.mimeType as ImageAttachmentMimeType);
      }
      validated = text ? {
        ...metadata,
        ...(opaque ? { mimeType: "application/octet-stream" as const, extension: "bin" } : {}),
        digest,
      } : await validateAttachmentImport({
        name: normalized ? operation.name.replace(/\.[^.]+$/u, "") + ".jpg" : operation.name,
        mimeType: normalized ? "image/jpeg" : operation.mimeType,
        data: normalized ?? bytes,
      });
    } catch (error) {
      if (error instanceof TextAttachmentError) {
        throw new AttachmentImportValidationError(error.code);
      }
      if (error instanceof DocumentExtractionError) {
        throw new AttachmentImportValidationError(error.code);
      }
      if (
        error instanceof ImageAttachmentTooLargeError
        && isReportedImageSide(error.width)
        && isReportedImageSide(error.height)
      ) {
        throw new AttachmentImportValidationError("image-too-large", {
          width: error.width,
          height: error.height,
        });
      }
      throw new AttachmentImportValidationError("content");
    }
    if (
      !normalized && (validated.size !== operation.size
      || (!opaque && operation.fileName !== `${operation.fileName.slice(0, 36)}.${validated.extension}`))
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
    if (normalized) {
      signal?.throwIfAborted();
      const writer = await open(path, constants.O_WRONLY | noFollow | nonBlocking);
      try {
        const target = await writer.stat({ bigint: true });
        if (!target.isFile() || target.nlink !== 1n || !sameIdentity(finalPinned, target)) {
          throw new AttachmentImportValidationError("unsafe");
        }
        let offset = 0;
        while (offset < normalized.length) {
          const { bytesWritten } = await writer.write(normalized, offset, normalized.length - offset, offset);
          if (bytesWritten === 0) throw new AttachmentImportValidationError("unsafe");
          offset += bytesWritten;
        }
        await writer.truncate(normalized.length);
        await writer.sync();
      } finally {
        await writer.close();
      }
    }
    const previewExtraction = operation.extractText === true
      && "extractedText" in validated
      && typeof validated.extractedText === "string"
      ? boundExtractedPreviewText(
          validated.extractedText,
          "extractedTruncated" in validated && validated.extractedTruncated === true,
        )
      : null;
    return {
      displayName: validated.displayName,
      mimeType: validated.mimeType,
      extension: validated.extension,
      size: validated.size,
      digest: validated.digest,
      ...(normalized ? { normalized: true as const } : {}),
      ...(previewExtraction
        ? {
            extractedText: previewExtraction.text,
            extractedTruncated: previewExtraction.truncated,
          }
        : {}),
    };
  } finally {
    await file.close();
  }
}

export const inProcessAttachmentImportValidationRunner:
AttachmentImportValidationRunner = Object.assign(
  (operation: AttachmentImportFileOperation, signal?: AbortSignal) => ({
    result: validateAttachmentImportFile(operation, { signal }),
    stopped: Promise.resolve(),
  }),
  {
    extract: (
      operation: AttachmentImportDocumentExtractOperation,
      signal?: AbortSignal,
    ): AttachmentImportDocumentExtractExecution => ({
      result: Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return extractAttachmentDocumentBytes(operation);
      }),
      stopped: Promise.resolve(),
    }),
  },
);
