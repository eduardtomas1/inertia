import { createHash } from "node:crypto";

import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  chatAttachmentMimeTypeForName,
  chatAttachmentKind,
  chatAttachmentStorageExtension,
  isPotentialChatAttachment,
  type ChatAttachmentMimeType,
  type DocumentAttachmentMimeType,
  type ImageAttachmentMimeType,
} from "../shared/attachments.js";
import type { AttachmentPickerMode } from "../shared/desktop.js";

const IMAGE_ATTACHMENT_EXTENSIONS = [
  "png", "jpg", "jpeg", "webp", "gif",
] as const;
const DOCUMENT_ATTACHMENT_EXTENSIONS = [
  "pdf", "txt", "md", "markdown", "csv", "json",
] as const;

export function attachmentPickerConfiguration(mode: AttachmentPickerMode): {
  title: string;
  filterName: string;
  extensions: string[];
} {
  return mode === "images"
    ? {
        title: "Attach follow-up images",
        filterName: "Images",
        extensions: [...IMAGE_ATTACHMENT_EXTENSIONS],
      }
    : {
        title: "Attach images or documents",
        filterName: "Images and safe documents",
        extensions: [
          ...IMAGE_ATTACHMENT_EXTENSIONS,
          ...DOCUMENT_ATTACHMENT_EXTENSIONS,
        ],
      };
}

export function validateAttachmentPickerName(
  mode: AttachmentPickerMode,
  name: string,
): void {
  const mimeType = chatAttachmentMimeTypeForName(name);
  if (
    mode === "images"
    && (mimeType === null || chatAttachmentKind(mimeType) !== "image")
  ) throw new Error("Follow-up attachments must be images.");
}

export interface ValidatedAttachmentImport {
  readonly displayName: string;
  readonly mimeType: ChatAttachmentMimeType;
  readonly extension: string;
  readonly bytes: Buffer;
  readonly size: number;
  readonly digest: string;
}

export interface SelectedAttachmentStat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface SelectedAttachmentIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface SelectedAttachmentReadSnapshot
  extends SelectedAttachmentIdentity {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export function validateSelectedAttachmentOpen(
  selected: SelectedAttachmentIdentity,
  opened: SelectedAttachmentIdentity,
): void {
  if (
    !selected.isFile
    || selected.isSymbolicLink
    || !opened.isFile
    || opened.isSymbolicLink
  ) {
    throw new Error("The selected attachment is not a safe regular file.");
  }
  if (selected.dev !== opened.dev || selected.ino !== opened.ino) {
    throw new Error("A selected attachment changed while it was being opened.");
  }
}

export function validateSelectedAttachmentRead(
  before: SelectedAttachmentReadSnapshot,
  after: SelectedAttachmentReadSnapshot,
): void {
  if (
    !after.isFile
    || after.isSymbolicLink
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("A selected attachment changed while it was being read.");
  }
}

export function validateSelectedAttachmentCount(count: number): void {
  if (
    !Number.isSafeInteger(count)
    || count < 0
    || count > MAX_CHAT_ATTACHMENTS
  ) {
    throw new Error(`Select at most ${MAX_CHAT_ATTACHMENTS} attachments.`);
  }
}

export function validateSelectedAttachmentStats(
  files: readonly SelectedAttachmentStat[],
): void {
  validateSelectedAttachmentCount(files.length);
  let selectedBytes = 0;
  for (const file of files) {
    if (!file.isFile || file.isSymbolicLink) {
      throw new Error("The selected attachment is not a safe regular file.");
    }
    if (file.size < 1 || file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new Error("A selected attachment is empty or exceeds the 10 MB file limit.");
    }
    selectedBytes += file.size;
    if (selectedBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
      throw new Error("Selected attachments exceed the 20 MB turn limit.");
    }
  }
}

function fallbackName(mimeType: ChatAttachmentMimeType): string {
  const kind = mimeType.startsWith("image/") ? "image" : "document";
  return `${kind}.${chatAttachmentStorageExtension(mimeType)}`;
}

function safeDisplayName(value: unknown, mimeType: ChatAttachmentMimeType): string {
  if (typeof value !== "string") return fallbackName(mimeType);
  const leaf = value.split(/[\\/]/u).at(-1)?.normalize("NFC").trim() ?? "";
  if (
    !leaf
    || leaf.length > 255
    || /[\0-\x1f\x7f]/u.test(leaf)
  ) return fallbackName(mimeType);
  return leaf;
}

function hasExpectedImageSignature(
  bytes: Buffer,
  mimeType: ImageAttachmentMimeType,
): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
  }
  if (mimeType === "image/jpeg") {
    const endMarker = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]));
    return bytes.length >= 4
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[2] === 0xff
      && endMarker !== -1
      && endMarker >= bytes.length - 1_024;
  }
  if (mimeType === "image/gif") {
    const header = bytes.subarray(0, 6).toString("ascii");
    const trailer = bytes.lastIndexOf(0x3b);
    return bytes.length >= 7
      && (header === "GIF87a" || header === "GIF89a")
      && trailer !== -1
      && trailer >= bytes.length - 16;
  }
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function decodedSafeText(bytes: Buffer): string | null {
  if (bytes.length > MAX_TEXT_ATTACHMENT_BYTES) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) ? null : text;
  } catch {
    return null;
  }
}

function hasExpectedDocumentSignature(
  bytes: Buffer,
  mimeType: DocumentAttachmentMimeType,
): boolean {
  if (mimeType === "application/pdf") {
    if (!/^%PDF-[12]\.[0-9]/u.test(bytes.subarray(0, 8).toString("ascii"))) {
      return false;
    }
    const endMarker = bytes.lastIndexOf(Buffer.from("%%EOF", "ascii"));
    return endMarker !== -1 && endMarker >= bytes.length - 2_048;
  }
  const text = decodedSafeText(bytes);
  if (text === null) return false;
  if (mimeType !== "application/json") return true;
  try {
    JSON.parse(text.replace(/^\uFEFF/u, ""));
    return true;
  } catch {
    return false;
  }
}

function bytesFromUnknown(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

export function validateAttachmentImport(value: unknown): ValidatedAttachmentImport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid attachment.");
  }
  const item = value as { name?: unknown; mimeType?: unknown; data?: unknown };
  const declaredMimeType = typeof item.mimeType === "string" ? item.mimeType : "";
  const suppliedName = typeof item.name === "string" ? item.name : "";
  const mimeType = chatAttachmentMimeTypeForName(suppliedName);
  const bytes = bytesFromUnknown(item.data);
  if (
    !mimeType
    || !isPotentialChatAttachment(suppliedName, declaredMimeType)
    || !bytes
    || bytes.length < 1
    || bytes.length > MAX_CHAT_ATTACHMENT_BYTES
  ) {
    throw new Error("Invalid attachment.");
  }
  const validSignature = mimeType.startsWith("image/")
    ? hasExpectedImageSignature(bytes, mimeType as ImageAttachmentMimeType)
    : hasExpectedDocumentSignature(bytes, mimeType as DocumentAttachmentMimeType);
  if (!validSignature) throw new Error("Attachment content does not match its safe file type.");

  return {
    displayName: safeDisplayName(item.name, mimeType),
    mimeType,
    extension: chatAttachmentStorageExtension(mimeType),
    bytes,
    size: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}
