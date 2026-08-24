import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import * as XLSX from "xlsx";

import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  MAX_SPREADSHEET_ATTACHMENT_EXPANDED_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  chatAttachmentMimeTypeForName,
  chatAttachmentKind,
  chatAttachmentStorageExtension,
  isPotentialChatAttachment,
  isSpreadsheetAttachmentMimeType,
  type ChatAttachmentMimeType,
  type DocumentAttachmentMimeType,
  type ImageAttachmentMimeType,
} from "../shared/attachments.js";
import type { AttachmentPickerMode } from "../shared/desktop.js";
import { hasSafeImageAttachment } from "./attachment-image-validation.js";
import { hasSafePdfAttachment } from "./attachment-pdf-validation.js";

const IMAGE_ATTACHMENT_EXTENSIONS = [
  "png", "jpg", "jpeg", "webp", "gif",
] as const;
const DOCUMENT_ATTACHMENT_EXTENSIONS = [
  "pdf", "txt", "md", "markdown", "csv", "json", "xlsx", "xls",
] as const;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const MAX_SPREADSHEET_ARCHIVE_ENTRIES = 4_096;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_DEFLATE_OPTION_FLAGS = 0x0006;
const ZIP_ALLOWED_FLAGS = ZIP_UTF8_FLAG
  | ZIP_DATA_DESCRIPTOR_FLAG
  | ZIP_DEFLATE_OPTION_FLAGS;
const ZIP64_EXTRA_FIELD = 0x0001;
const REQUIRED_XLSX_ENTRIES = new Set([
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
]);
const OLE_COMPOUND_FILE_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let checksum = value;
  for (let bit = 0; bit < 8; bit += 1) {
    checksum = (checksum & 1) === 1
      ? 0xedb88320 ^ (checksum >>> 1)
      : checksum >>> 1;
  }
  return checksum >>> 0;
});

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
        title: "Attach images, documents, or spreadsheets",
        filterName: "Images, documents, and spreadsheets",
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

export type PreparedAttachmentMetadata = Omit<
  ValidatedAttachmentImport,
  "bytes" | "digest"
>;

export interface PreparedAttachmentImport extends PreparedAttachmentMetadata {
  readonly bytes: Buffer;
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

function decodedSafeText(bytes: Buffer): string | null {
  if (bytes.length > MAX_TEXT_ATTACHMENT_BYTES) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) ? null : text;
  } catch {
    return null;
  }
}

function zipEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(
    0,
    bytes.length
      - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES
      - ZIP_MAX_COMMENT_BYTES,
  );
  for (
    let offset = bytes.length - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES;
    offset >= minimum;
    offset -= 1
  ) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50
      && offset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES
        + bytes.readUInt16LE(offset + 20) === bytes.length
    ) return offset;
  }
  return -1;
}

function safeArchiveEntryName(bytes: Buffer): string | null {
  try {
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const segments = name.split("/");
    if (
      !name
      || /[\0-\x1f\x7f]/u.test(name)
      || name.includes("\\")
      || name.includes(":")
      || name.startsWith("/")
      || segments.some((segment, index) =>
        segment === ".."
        || segment === "."
        || (segment === "" && index !== segments.length - 1))
    ) return null;
    return name;
  } catch {
    return null;
  }
}

function archiveExtraFieldsAreSafe(bytes: Buffer): boolean {
  let cursor = 0;
  while (cursor < bytes.length) {
    if (cursor + 4 > bytes.length) return false;
    const id = bytes.readUInt16LE(cursor);
    const size = bytes.readUInt16LE(cursor + 2);
    cursor += 4;
    if (id === ZIP64_EXTRA_FIELD || cursor + size > bytes.length) return false;
    cursor += size;
  }
  return cursor === bytes.length;
}

function crc32(bytes: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum = CRC32_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

interface XlsxCentralDirectoryEntry {
  readonly compressedBytes: number;
  readonly compression: 0 | 8;
  readonly crc: number;
  readonly flags: number;
  readonly localOffset: number;
  readonly name: string;
  readonly nameBytes: Buffer;
  readonly uncompressedBytes: number;
}

interface XlsxLocalEntryResult {
  readonly end: number;
  readonly output: Buffer;
  readonly start: number;
}

function parseXlsxCentralDirectory(
  bytes: Buffer,
  directoryOffset: number,
  endOffset: number,
  totalEntries: number,
): XlsxCentralDirectoryEntry[] | null {
  const entries: XlsxCentralDirectoryEntry[] = [];
  const names = new Set<string>();
  let claimedExpandedBytes = 0;
  let cursor = directoryOffset;
  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    if (
      cursor + 46 > endOffset
      || bytes.readUInt32LE(cursor) !== 0x02014b50
    ) return null;
    const flags = bytes.readUInt16LE(cursor + 8);
    const compression = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const uncompressedBytes = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    const entryEnd = extraStart + extraLength + commentLength;
    if (
      (flags & ~ZIP_ALLOWED_FLAGS) !== 0
      || (compression !== 0 && compression !== 8)
      || (compression === 0 && (flags & ZIP_DEFLATE_OPTION_FLAGS) !== 0)
      || compressedBytes === 0xffffffff
      || uncompressedBytes === 0xffffffff
      || localOffset >= directoryOffset
      || diskStart !== 0
      || entryEnd > endOffset
      || !archiveExtraFieldsAreSafe(
        bytes.subarray(extraStart, extraStart + extraLength),
      )
    ) return null;
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const name = safeArchiveEntryName(nameBytes);
    const normalizedName = name?.normalize("NFC").toLocaleLowerCase("en-US");
    if (!name || !normalizedName || names.has(normalizedName)) return null;
    names.add(normalizedName);
    claimedExpandedBytes += uncompressedBytes;
    if (
      claimedExpandedBytes > MAX_SPREADSHEET_ATTACHMENT_EXPANDED_BYTES
    ) return null;
    entries.push({
      compressedBytes,
      compression,
      crc,
      flags,
      localOffset,
      name,
      nameBytes,
      uncompressedBytes,
    });
    cursor = entryEnd;
  }
  return cursor === endOffset ? entries : null;
}

function xlsxDataDescriptorEnd(
  bytes: Buffer,
  entry: XlsxCentralDirectoryEntry,
  dataEnd: number,
  directoryOffset: number,
): number | null {
  if ((entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0) return dataEnd;
  let cursor = dataEnd;
  if (
    cursor + 4 <= directoryOffset
    && bytes.readUInt32LE(cursor) === 0x08074b50
  ) cursor += 4;
  if (cursor + 12 > directoryOffset) return null;
  if (
    bytes.readUInt32LE(cursor) !== entry.crc
    || bytes.readUInt32LE(cursor + 4) !== entry.compressedBytes
    || bytes.readUInt32LE(cursor + 8) !== entry.uncompressedBytes
  ) return null;
  return cursor + 12;
}

function validateXlsxLocalEntry(
  bytes: Buffer,
  entry: XlsxCentralDirectoryEntry,
  directoryOffset: number,
  remainingExpandedBytes: number,
): XlsxLocalEntryResult | null {
  const cursor = entry.localOffset;
  if (
    cursor + 30 > directoryOffset
    || bytes.readUInt32LE(cursor) !== 0x04034b50
  ) return null;
  const flags = bytes.readUInt16LE(cursor + 6);
  const compression = bytes.readUInt16LE(cursor + 8);
  const localCrc = bytes.readUInt32LE(cursor + 14);
  const localCompressedBytes = bytes.readUInt32LE(cursor + 18);
  const localUncompressedBytes = bytes.readUInt32LE(cursor + 22);
  const nameLength = bytes.readUInt16LE(cursor + 26);
  const extraLength = bytes.readUInt16LE(cursor + 28);
  const nameStart = cursor + 30;
  const extraStart = nameStart + nameLength;
  const dataStart = extraStart + extraLength;
  const dataEnd = dataStart + entry.compressedBytes;
  const usesDescriptor = (entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;
  if (
    flags !== entry.flags
    || compression !== entry.compression
    || dataEnd > directoryOffset
    || !bytes.subarray(nameStart, extraStart).equals(entry.nameBytes)
    || !archiveExtraFieldsAreSafe(
      bytes.subarray(extraStart, dataStart),
    )
    || (
      usesDescriptor
        ? (
            (localCrc !== 0 && localCrc !== entry.crc)
            || (
              localCompressedBytes !== 0
              && localCompressedBytes !== entry.compressedBytes
            )
            || (
              localUncompressedBytes !== 0
              && localUncompressedBytes !== entry.uncompressedBytes
            )
          )
        : (
            localCrc !== entry.crc
            || localCompressedBytes !== entry.compressedBytes
            || localUncompressedBytes !== entry.uncompressedBytes
          )
    )
  ) return null;

  const compressed = bytes.subarray(dataStart, dataEnd);
  let output: Buffer;
  try {
    output = entry.compression === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, {
          maxOutputLength: Math.max(
            1,
            Math.min(
              entry.uncompressedBytes + 1,
              remainingExpandedBytes + 1,
            ),
          ),
        });
  } catch {
    return null;
  }
  if (
    output.byteLength !== entry.uncompressedBytes
    || (entry.compression === 0
      && entry.compressedBytes !== entry.uncompressedBytes)
    || crc32(output) !== entry.crc
  ) return null;
  const end = xlsxDataDescriptorEnd(
    bytes,
    entry,
    dataEnd,
    directoryOffset,
  );
  return end === null ? null : { start: cursor, end, output };
}

function advertisesXlsxMacros(bytes: Buffer): boolean {
  const searchable = bytes.toString("utf8")
    .replaceAll("\0", "")
    .toLocaleLowerCase("en-US");
  // Some ordinary XLSX producers declare a generic `.bin` default using a
  // macro-enabled content type even when the archive contains no macro part.
  // A real OOXML VBA payload must identify a vbaProject part explicitly.
  return searchable.includes("vbaproject");
}

function hasReadableSpreadsheetContainer(bytes: Buffer): boolean {
  try {
    const workbook = XLSX.read(bytes, {
      type: "buffer",
      bookSheets: true,
      bookVBA: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      dense: true,
      sheetRows: 1,
      WTF: false,
    });
    return Array.isArray(workbook.SheetNames)
      && workbook.SheetNames.length > 0
      && !("vbaraw" in workbook && workbook.vbaraw);
  } catch {
    return false;
  }
}

function hasExpectedXlsxContainer(bytes: Buffer): boolean {
  if (
    bytes.length < ZIP_END_OF_CENTRAL_DIRECTORY_BYTES
    || bytes.readUInt32LE(0) !== 0x04034b50
  ) return false;
  const endOffset = zipEndOfCentralDirectory(bytes);
  if (endOffset < 0) return false;
  const disk = bytes.readUInt16LE(endOffset + 4);
  const directoryDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const directoryBytes = bytes.readUInt32LE(endOffset + 12);
  const directoryOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    disk !== 0
    || directoryDisk !== 0
    || diskEntries !== totalEntries
    || totalEntries < 3
    || totalEntries > MAX_SPREADSHEET_ARCHIVE_ENTRIES
    || directoryBytes === 0xffffffff
    || directoryOffset === 0xffffffff
    || directoryOffset + directoryBytes !== endOffset
  ) return false;

  const entries = parseXlsxCentralDirectory(
    bytes,
    directoryOffset,
    endOffset,
    totalEntries,
  );
  if (!entries) return false;
  const required = new Set(REQUIRED_XLSX_ENTRIES);
  const occupied: Array<{ start: number; end: number }> = [];
  let actualExpandedBytes = 0;
  for (const entry of entries) {
    if (entry.name.toLocaleLowerCase("en-US").endsWith("vbaproject.bin")) {
      return false;
    }
    const local = validateXlsxLocalEntry(
      bytes,
      entry,
      directoryOffset,
      MAX_SPREADSHEET_ATTACHMENT_EXPANDED_BYTES - actualExpandedBytes,
    );
    if (!local) return false;
    actualExpandedBytes += local.output.byteLength;
    if (actualExpandedBytes > MAX_SPREADSHEET_ATTACHMENT_EXPANDED_BYTES) {
      return false;
    }
    occupied.push({ start: local.start, end: local.end });
    if (required.has(entry.name)) {
      if (local.output.byteLength === 0) return false;
      required.delete(entry.name);
      if (
        entry.name === "[Content_Types].xml"
        && advertisesXlsxMacros(local.output)
      ) return false;
    }
  }
  occupied.sort((left, right) => left.start - right.start);
  if (occupied.some((range, index) =>
    range.end > directoryOffset
    || (index > 0 && occupied[index - 1]!.end > range.start))) {
    return false;
  }
  return required.size === 0 && hasReadableSpreadsheetContainer(bytes);
}

function hasExpectedXlsContainer(bytes: Buffer): boolean {
  if (
    bytes.length < 1_024
    || !bytes.subarray(0, OLE_COMPOUND_FILE_SIGNATURE.length)
      .equals(OLE_COMPOUND_FILE_SIGNATURE)
    || bytes.readUInt16LE(0x1c) !== 0xfffe
    || bytes.readUInt16LE(0x20) !== 6
  ) return false;
  const majorVersion = bytes.readUInt16LE(0x1a);
  const sectorShift = bytes.readUInt16LE(0x1e);
  if (
    !(
      (majorVersion === 3 && sectorShift === 9)
      || (majorVersion === 4 && sectorShift === 12)
    )
    || bytes.length % (2 ** sectorShift) !== 0
  ) return false;
  return hasReadableSpreadsheetContainer(bytes);
}

function hasExpectedDocumentSignature(
  bytes: Buffer,
  mimeType: DocumentAttachmentMimeType,
): boolean {
  if (mimeType === "application/pdf") {
    return hasSafePdfAttachment(bytes);
  }
  if (isSpreadsheetAttachmentMimeType(mimeType)) {
    return mimeType
      === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ? hasExpectedXlsxContainer(bytes)
      : hasExpectedXlsContainer(bytes);
  }
  const text = decodedSafeText(bytes);
  if (text === null) return false;
  if (mimeType !== "application/json") return text.trim().length > 0;
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
  const prepared = prepareAttachmentImport(value);
  const validSignature = prepared.mimeType.startsWith("image/")
    ? hasSafeImageAttachment(
        prepared.bytes,
        prepared.mimeType as ImageAttachmentMimeType,
      )
    : hasExpectedDocumentSignature(
        prepared.bytes,
        prepared.mimeType as DocumentAttachmentMimeType,
      );
  if (!validSignature) {
    throw new Error("Attachment content does not match its safe file type.");
  }

  return {
    ...prepared,
    digest: createHash("sha256").update(prepared.bytes).digest("hex"),
  };
}

/**
 * Performs only the bounded envelope checks needed before private staging.
 * Structural parsing deliberately remains in `validateAttachmentImport`,
 * which production invokes inside the supervised attachment utility.
 */
export function prepareAttachmentImport(value: unknown): PreparedAttachmentImport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid attachment.");
  }
  const item = value as { name?: unknown; mimeType?: unknown; data?: unknown };
  const bytes = bytesFromUnknown(item.data);
  if (!bytes) throw new Error("Invalid attachment.");
  const metadata = prepareAttachmentImportMetadata({
    name: item.name,
    mimeType: item.mimeType,
    size: bytes.length,
  });

  return {
    ...metadata,
    bytes,
  };
}

export function prepareAttachmentImportMetadata(
  value: unknown,
): PreparedAttachmentMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid attachment.");
  }
  const item = value as {
    name?: unknown;
    mimeType?: unknown;
    size?: unknown;
  };
  const declaredMimeType = typeof item.mimeType === "string" ? item.mimeType : "";
  const suppliedName = typeof item.name === "string" ? item.name : "";
  const mimeType = chatAttachmentMimeTypeForName(suppliedName);
  if (
    !mimeType
    || !isPotentialChatAttachment(suppliedName, declaredMimeType)
    || typeof item.size !== "number"
    || !Number.isSafeInteger(item.size)
    || item.size < 1
    || item.size > MAX_CHAT_ATTACHMENT_BYTES
  ) throw new Error("Invalid attachment.");
  return {
    displayName: safeDisplayName(item.name, mimeType),
    mimeType,
    extension: chatAttachmentStorageExtension(mimeType),
    size: item.size,
  };
}
