import { crc32, inflateRawSync } from "node:zlib";

import {
  DocumentExtractionError,
  MAX_DOCUMENT_ARCHIVE_ENTRIES,
  MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES,
  MAX_DOCUMENT_ARCHIVE_RATIO,
  MAX_DOCUMENT_ARCHIVE_RATIO_FLOOR_BYTES,
} from "./document-text-errors.js";

const EOCD_MIN_BYTES = 22;
const EOCD_MAX_COMMENT_BYTES = 65_535;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP64_EXTRA_ID = 0x0001;
const TEXT_ARCHIVE_ENTRY = /\.(?:xml|rels|xhtml|html|htm|opf|svg)$/iu;
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

interface ZipCentralEntry {
  readonly name: string;
  readonly nameBytes: Buffer;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function findEocdOffset(bytes: Buffer): number {
  const minOffset = Math.max(0, bytes.length - EOCD_MIN_BYTES - EOCD_MAX_COMMENT_BYTES);
  for (let offset = bytes.length - EOCD_MIN_BYTES; offset >= minOffset; offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === EOCD_SIGNATURE
      && offset + EOCD_MIN_BYTES + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      return offset;
    }
  }
  return -1;
}

function decodeArchiveEntryName(nameBytes: Buffer): string | null {
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch {
    return null;
  }
  if (
    !name
    || /[\0-\x1f\x7f]/u.test(name)
    || name.includes("\\")
    || name.includes(":")
    || name.startsWith("/")
  ) {
    return null;
  }
  const segments = name.split("/");
  if (
    segments.some(
      (segment, index) =>
        segment === "."
        || segment === ".."
        || (segment === "" && index !== segments.length - 1),
    )
  ) {
    return null;
  }
  return name;
}

function hasSafeExtraFields(extra: Buffer): boolean {
  let cursor = 0;
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) return false;
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (id === ZIP64_EXTRA_ID || cursor + size > extra.length) return false;
    cursor += size;
  }
  return cursor === extra.length;
}

function decodeXmlBytes(data: Buffer): string {
  const encoding =
    (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0x3c && data[1] === 0x00)
      ? "utf-16le"
      : (data[0] === 0xfe && data[1] === 0xff) || (data[0] === 0x00 && data[1] === 0x3c)
        ? "utf-16be"
        : "utf-8";
  return new TextDecoder(encoding).decode(data);
}

function isEncryptedOleOffice(bytes: Buffer): boolean {
  if (bytes.length < OLE_SIGNATURE.length) return false;
  if (!bytes.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)) return false;
  const ascii = bytes.toString("latin1");
  const utf16 = bytes.toString("utf16le");
  return (
    ascii.includes("EncryptedPackage")
    || ascii.includes("EncryptionInfo")
    || utf16.includes("EncryptedPackage")
    || utf16.includes("EncryptionInfo")
  );
}

function parseCentralEntries(
  bytes: Buffer,
  directoryOffset: number,
  endOffset: number,
  totalEntries: number,
): ZipCentralEntry[] {
  const entries: ZipCentralEntry[] = [];
  const seen = new Set<string>();
  let cursor = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new DocumentExtractionError("document-corrupt");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new DocumentExtractionError("document-encrypted");
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const entryCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    const entryEnd = extraStart + extraLength + commentLength;
    if (
      diskStart !== 0
      || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localOffset >= directoryOffset
      || entryEnd > endOffset
      || !hasSafeExtraFields(bytes.subarray(extraStart, extraStart + extraLength))
    ) {
      throw new DocumentExtractionError("document-corrupt");
    }
    const nameBytes = bytes.subarray(nameStart, extraStart);
    const name = decodeArchiveEntryName(nameBytes);
    if (!name || seen.has(name)) {
      throw new DocumentExtractionError("document-corrupt");
    }
    seen.add(name);
    entries.push({
      name,
      nameBytes,
      flags,
      method,
      crc: entryCrc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    cursor = entryEnd;
  }
  if (cursor !== endOffset) {
    throw new DocumentExtractionError("document-corrupt");
  }
  return entries;
}

function shouldExtractArchiveEntry(name: string): boolean {
  return name === "mimetype" || TEXT_ARCHIVE_ENTRY.test(name);
}

function localEntryEnd(
  bytes: Buffer,
  entry: ZipCentralEntry,
  dataEnd: number,
  directoryOffset: number,
): number {
  if ((entry.flags & FLAG_DATA_DESCRIPTOR) === 0) return dataEnd;
  let cursor = dataEnd;
  if (
    cursor + 4 <= directoryOffset
    && bytes.readUInt32LE(cursor) === DATA_DESCRIPTOR_SIGNATURE
  ) {
    cursor += 4;
  }
  if (cursor + 12 > directoryOffset) {
    throw new DocumentExtractionError("document-corrupt");
  }
  if (
    bytes.readUInt32LE(cursor) !== entry.crc
    || bytes.readUInt32LE(cursor + 4) !== entry.compressedSize
    || bytes.readUInt32LE(cursor + 8) !== entry.uncompressedSize
  ) {
    throw new DocumentExtractionError("document-corrupt");
  }
  return cursor + 12;
}

export function readBoundedDocumentArchive(
  source: Uint8Array,
  options: { readonly allowOleEncryptedDetection?: boolean } = {},
): Map<string, string> {
  const bytes = Buffer.isBuffer(source)
    ? source
    : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  if (options.allowOleEncryptedDetection && isEncryptedOleOffice(bytes)) {
    throw new DocumentExtractionError("document-encrypted");
  }
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
    throw new DocumentExtractionError("content");
  }
  if (bytes.length < EOCD_MIN_BYTES) {
    throw new DocumentExtractionError("document-corrupt");
  }
  const endOffset = findEocdOffset(bytes);
  if (endOffset < 0) {
    throw new DocumentExtractionError("document-corrupt");
  }
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const directoryDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const directoryBytes = bytes.readUInt32LE(endOffset + 12);
  const directoryOffset = bytes.readUInt32LE(endOffset + 16);
  if (totalEntries > MAX_DOCUMENT_ARCHIVE_ENTRIES || diskEntries > MAX_DOCUMENT_ARCHIVE_ENTRIES) {
    throw new DocumentExtractionError("document-limit");
  }
  if (
    diskNumber !== 0
    || directoryDisk !== 0
    || diskEntries !== totalEntries
    || directoryBytes === 0xffffffff
    || directoryOffset === 0xffffffff
    || directoryOffset + directoryBytes !== endOffset
  ) {
    throw new DocumentExtractionError("document-corrupt");
  }
  const entries = parseCentralEntries(bytes, directoryOffset, endOffset, totalEntries);
  const files = new Map<string, string>();
  const ranges: Array<{ start: number; end: number }> = [];
  let expandedBytes = 0;

  for (const entry of entries) {
    const start = entry.localOffset;
    if (start + 30 > directoryOffset || bytes.readUInt32LE(start) !== LOCAL_HEADER_SIGNATURE) {
      throw new DocumentExtractionError("document-corrupt");
    }
    const localFlags = bytes.readUInt16LE(start + 6);
    if ((localFlags & FLAG_ENCRYPTED) !== 0) {
      throw new DocumentExtractionError("document-encrypted");
    }
    const localMethod = bytes.readUInt16LE(start + 8);
    const localCrc = bytes.readUInt32LE(start + 14);
    const localCompressed = bytes.readUInt32LE(start + 18);
    const localUncompressed = bytes.readUInt32LE(start + 22);
    const nameLength = bytes.readUInt16LE(start + 26);
    const extraLength = bytes.readUInt16LE(start + 28);
    const nameStart = start + 30;
    const extraStart = nameStart + nameLength;
    const dataStart = extraStart + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    const usesDescriptor = (entry.flags & FLAG_DATA_DESCRIPTOR) !== 0;
    if (
      localFlags !== entry.flags
      || localMethod !== entry.method
      || dataEnd > directoryOffset
      || !bytes.subarray(nameStart, extraStart).equals(entry.nameBytes)
      || !hasSafeExtraFields(bytes.subarray(extraStart, dataStart))
      || (
        usesDescriptor
          ? (
              (localCrc !== 0 && localCrc !== entry.crc)
              || (localCompressed !== 0 && localCompressed !== entry.compressedSize)
              || (localUncompressed !== 0 && localUncompressed !== entry.uncompressedSize)
            )
          : (
              localCrc !== entry.crc
              || localCompressed !== entry.compressedSize
              || localUncompressed !== entry.uncompressedSize
            )
      )
    ) {
      throw new DocumentExtractionError("document-corrupt");
    }
    const end = localEntryEnd(bytes, entry, dataEnd, directoryOffset);
    ranges.push({ start, end });

    if (!shouldExtractArchiveEntry(entry.name)) {
      continue;
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new DocumentExtractionError("document-corrupt");
    }
    const ratioCeiling = Math.max(
      MAX_DOCUMENT_ARCHIVE_RATIO_FLOOR_BYTES,
      entry.compressedSize * MAX_DOCUMENT_ARCHIVE_RATIO,
    );
    if (
      entry.uncompressedSize > MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES
      || entry.uncompressedSize > ratioCeiling
    ) {
      throw new DocumentExtractionError("document-limit");
    }
    if (expandedBytes + entry.uncompressedSize > MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES) {
      throw new DocumentExtractionError("document-limit");
    }
    const remaining = MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES - expandedBytes;
    const maxOutput = Math.min(entry.uncompressedSize, ratioCeiling, remaining);
    const compressed = bytes.subarray(dataStart, dataEnd);
    let output: Buffer;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new DocumentExtractionError("document-corrupt");
      }
      output = Buffer.from(compressed);
    } else {
      try {
        output = inflateRawSync(compressed, { maxOutputLength: maxOutput + 1 });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code === "ERR_BUFFER_TOO_LARGE") {
          throw new DocumentExtractionError("document-limit");
        }
        throw new DocumentExtractionError("document-corrupt");
      }
    }
    if (output.byteLength > maxOutput) {
      throw new DocumentExtractionError("document-limit");
    }
    if (output.byteLength !== entry.uncompressedSize || crc32(output) !== entry.crc) {
      throw new DocumentExtractionError("document-corrupt");
    }
    expandedBytes += output.byteLength;
    files.set(entry.name, decodeXmlBytes(output));
  }

  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1]!.end > ranges[index]!.start) {
      throw new DocumentExtractionError("document-corrupt");
    }
  }
  return files;
}
