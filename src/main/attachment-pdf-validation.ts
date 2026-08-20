import { inflateSync } from "node:zlib";

const MAX_PDF_XREF_ENTRIES = 100_000;
const MAX_PDF_XREF_BYTES = 4 * 1024 * 1024;
const MAX_PDF_DICTIONARY_BYTES = 1024 * 1024;
const MAX_PDF_OBJECT_DEPTH = 64;
const MAX_PDF_INCREMENTAL_UPDATES = 32;
const MAX_PDF_STRUCTURE_OPERATIONS = 500_000;
const MAX_PDF_TAIL_BYTES = 64 * 1024;

interface PdfReference {
  readonly object: number;
  readonly generation: number;
}

type PdfXrefRecord =
  | { readonly kind: "free" }
  | { readonly kind: "normal"; readonly offset: number; readonly generation: number }
  | { readonly kind: "compressed"; readonly container: number };

interface ParsedXrefSection {
  readonly records: ReadonlyMap<number, PdfXrefRecord>;
  readonly root: PdfReference | null;
  readonly previous: number | null;
  readonly supplemental: number | null;
}

interface ParsedDictionary {
  readonly entries: ReadonlyMap<string, Buffer>;
  readonly end: number;
}

interface ParsedInteger {
  readonly value: number;
  readonly end: number;
}

class PdfInspectionBudget {
  private operations = 0;

  consume(count = 1): void {
    this.operations += count;
    if (this.operations > MAX_PDF_STRUCTURE_OPERATIONS) {
      throw new Error("The PDF exceeds the structural inspection budget.");
    }
  }
}

function isPdfWhitespace(byte: number | undefined): boolean {
  return byte === 0x00
    || byte === 0x09
    || byte === 0x0a
    || byte === 0x0c
    || byte === 0x0d
    || byte === 0x20;
}

function isPdfDelimiter(byte: number | undefined): boolean {
  return isPdfWhitespace(byte)
    || byte === undefined
    || byte === 0x28
    || byte === 0x29
    || byte === 0x3c
    || byte === 0x3e
    || byte === 0x5b
    || byte === 0x5d
    || byte === 0x7b
    || byte === 0x7d
    || byte === 0x2f
    || byte === 0x25;
}

function startsWithKeyword(bytes: Buffer, position: number, keyword: string): boolean {
  const end = position + keyword.length;
  return end <= bytes.byteLength
    && bytes.subarray(position, end).toString("ascii") === keyword
    && isPdfDelimiter(bytes[position - 1])
    && isPdfDelimiter(bytes[end]);
}

function skipWhitespaceAndComments(
  bytes: Buffer,
  start: number,
  limit = bytes.byteLength,
): number {
  let position = start;
  while (position < limit) {
    if (isPdfWhitespace(bytes[position])) {
      position += 1;
      continue;
    }
    if (bytes[position] !== 0x25) return position;
    position += 1;
    while (
      position < limit
      && bytes[position] !== 0x0a
      && bytes[position] !== 0x0d
    ) position += 1;
  }
  return position;
}

function readRegularToken(
  bytes: Buffer,
  start: number,
  limit: number,
): { readonly value: string; readonly end: number } {
  let end = start;
  while (end < limit && !isPdfDelimiter(bytes[end])) end += 1;
  if (end === start) throw new Error("The PDF contains an invalid token.");
  return {
    value: bytes.subarray(start, end).toString("ascii"),
    end,
  };
}

function readUnsignedInteger(
  bytes: Buffer,
  start: number,
  limit = bytes.byteLength,
): ParsedInteger {
  const position = skipWhitespaceAndComments(bytes, start, limit);
  const token = readRegularToken(bytes, position, limit);
  if (!/^\d+$/u.test(token.value)) {
    throw new Error("The PDF contains an invalid integer.");
  }
  const value = Number(token.value);
  if (!Number.isSafeInteger(value)) {
    throw new Error("The PDF contains an unsafe integer.");
  }
  return { value, end: token.end };
}

function readPdfName(
  bytes: Buffer,
  start: number,
  limit: number,
): { readonly value: string; readonly end: number } {
  if (bytes[start] !== 0x2f) throw new Error("The PDF dictionary key is invalid.");
  let end = start + 1;
  while (end < limit && !isPdfDelimiter(bytes[end])) end += 1;
  const encoded = bytes.subarray(start + 1, end).toString("ascii");
  const value = encoded.replace(/#([0-9a-fA-F]{2})/gu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)));
  if (!value) throw new Error("The PDF contains an empty name.");
  return { value, end };
}

function skipLiteralString(bytes: Buffer, start: number, limit: number): number {
  let position = start + 1;
  let depth = 1;
  while (position < limit) {
    const byte = bytes[position]!;
    position += 1;
    if (byte === 0x5c) {
      if (position >= limit) break;
      if (bytes[position] === 0x0d && bytes[position + 1] === 0x0a) {
        position += 2;
      } else {
        position += 1;
      }
    } else if (byte === 0x28) {
      depth += 1;
      if (depth > MAX_PDF_OBJECT_DEPTH) {
        throw new Error("The PDF string nesting is too deep.");
      }
    } else if (byte === 0x29) {
      depth -= 1;
      if (depth === 0) return position;
    }
  }
  throw new Error("The PDF contains an unterminated string.");
}

function skipHexString(bytes: Buffer, start: number, limit: number): number {
  for (let position = start + 1; position < limit; position += 1) {
    if (bytes[position] === 0x3e) return position + 1;
  }
  throw new Error("The PDF contains an unterminated hex string.");
}

function skipPdfObject(
  bytes: Buffer,
  start: number,
  limit: number,
  budget: PdfInspectionBudget,
  depth: number,
): number {
  budget.consume();
  if (depth > MAX_PDF_OBJECT_DEPTH) {
    throw new Error("The PDF object nesting is too deep.");
  }
  const position = skipWhitespaceAndComments(bytes, start, limit);
  const byte = bytes[position];
  if (byte === undefined) throw new Error("The PDF object is truncated.");
  if (byte === 0x28) return skipLiteralString(bytes, position, limit);
  if (byte === 0x2f) return readPdfName(bytes, position, limit).end;
  if (byte === 0x3c && bytes[position + 1] !== 0x3c) {
    return skipHexString(bytes, position, limit);
  }
  if (byte === 0x5b) {
    let cursor = position + 1;
    while (true) {
      cursor = skipWhitespaceAndComments(bytes, cursor, limit);
      if (bytes[cursor] === 0x5d) return cursor + 1;
      cursor = skipPdfObject(bytes, cursor, limit, budget, depth + 1);
    }
  }
  if (byte === 0x3c && bytes[position + 1] === 0x3c) {
    return parseDictionary(bytes, position, limit, budget, depth + 1).end;
  }
  const token = readRegularToken(bytes, position, limit);
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(token.value)) return token.end;
  try {
    const generation = readUnsignedInteger(bytes, token.end, limit);
    const reference = skipWhitespaceAndComments(bytes, generation.end, limit);
    if (startsWithKeyword(bytes, reference, "R")) return reference + 1;
  } catch {
    // A numeric value need not be an indirect reference.
  }
  return token.end;
}

function parseDictionary(
  bytes: Buffer,
  start: number,
  limit: number,
  budget: PdfInspectionBudget,
  depth = 0,
): ParsedDictionary {
  if (
    bytes[start] !== 0x3c
    || bytes[start + 1] !== 0x3c
    || limit - start > MAX_PDF_DICTIONARY_BYTES
  ) throw new Error("The PDF dictionary is invalid or too large.");
  const entries = new Map<string, Buffer>();
  let position = start + 2;
  while (true) {
    budget.consume();
    position = skipWhitespaceAndComments(bytes, position, limit);
    if (bytes[position] === 0x3e && bytes[position + 1] === 0x3e) {
      return { entries, end: position + 2 };
    }
    const name = readPdfName(bytes, position, limit);
    if (entries.has(name.value)) {
      throw new Error("The PDF dictionary contains duplicate keys.");
    }
    const valueStart = skipWhitespaceAndComments(bytes, name.end, limit);
    const valueEnd = skipPdfObject(
      bytes,
      valueStart,
      limit,
      budget,
      depth + 1,
    );
    entries.set(name.value, bytes.subarray(valueStart, valueEnd));
    position = valueEnd;
  }
}

function directUnsignedInteger(value: Buffer | undefined): number | null {
  if (!value) return null;
  const text = value.toString("ascii").trim();
  if (!/^\d+$/u.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function indirectReference(value: Buffer | undefined): PdfReference | null {
  if (!value) return null;
  const match = /^(\d+)\s+(\d+)\s+R$/u.exec(value.toString("ascii").trim());
  if (!match) return null;
  const object = Number(match[1]);
  const generation = Number(match[2]);
  return Number.isSafeInteger(object)
    && Number.isSafeInteger(generation)
    && object > 0
    && object < MAX_PDF_XREF_ENTRIES
    && generation >= 0
    && generation <= 65_535
    ? { object, generation }
    : null;
}

function optionalUnsignedInteger(
  dictionary: ParsedDictionary,
  key: string,
): number | null {
  if (!dictionary.entries.has(key)) return null;
  const value = directUnsignedInteger(dictionary.entries.get(key));
  if (value === null) throw new Error(`The PDF ${key} value is invalid.`);
  return value;
}

function optionalIndirectReference(
  dictionary: ParsedDictionary,
  key: string,
): PdfReference | null {
  if (!dictionary.entries.has(key)) return null;
  const value = indirectReference(dictionary.entries.get(key));
  if (!value) throw new Error(`The PDF ${key} reference is invalid.`);
  return value;
}

function integerArray(value: Buffer | undefined): number[] | null {
  if (!value) return null;
  const text = value.toString("ascii").replace(/%[^\r\n]*/gu, "").trim();
  if (!/^\[\s*\d+(?:\s+\d+)*\s*\]$/u.test(text)) return null;
  const values = text.slice(1, -1).trim().split(/\s+/u).map(Number);
  return values.every(Number.isSafeInteger) ? values : null;
}

function parseIndirectObjectHeader(
  bytes: Buffer,
  offset: number,
): { readonly reference: PdfReference; readonly body: number } | null {
  try {
    const object = readUnsignedInteger(bytes, offset);
    const generation = readUnsignedInteger(bytes, object.end);
    const keyword = skipWhitespaceAndComments(bytes, generation.end);
    if (!startsWithKeyword(bytes, keyword, "obj")) return null;
    return {
      reference: { object: object.value, generation: generation.value },
      body: skipWhitespaceAndComments(bytes, keyword + 3),
    };
  } catch {
    return null;
  }
}

function verifyNormalRecord(
  bytes: Buffer,
  object: number,
  generation: number,
  offset: number,
): boolean {
  if (offset <= 0 || offset >= bytes.byteLength) return false;
  const header = parseIndirectObjectHeader(bytes, offset);
  return header?.reference.object === object
    && header.reference.generation === generation;
}

function parseXrefTable(
  bytes: Buffer,
  offset: number,
  budget: PdfInspectionBudget,
): ParsedXrefSection {
  if (!startsWithKeyword(bytes, offset, "xref")) {
    throw new Error("The PDF cross-reference table is missing.");
  }
  const records = new Map<number, PdfXrefRecord>();
  let position = offset + 4;
  let entries = 0;
  while (true) {
    position = skipWhitespaceAndComments(bytes, position);
    if (startsWithKeyword(bytes, position, "trailer")) {
      position = skipWhitespaceAndComments(bytes, position + 7);
      break;
    }
    const first = readUnsignedInteger(bytes, position);
    const count = readUnsignedInteger(bytes, first.end);
    if (
      count.value < 1
      || first.value + count.value > MAX_PDF_XREF_ENTRIES
      || entries + count.value > MAX_PDF_XREF_ENTRIES
    ) throw new Error("The PDF cross-reference range is unsafe.");
    position = count.end;
    entries += count.value;
    for (let index = 0; index < count.value; index += 1) {
      budget.consume();
      const object = first.value + index;
      const entryOffset = readUnsignedInteger(bytes, position);
      const generation = readUnsignedInteger(bytes, entryOffset.end);
      const statusPosition = skipWhitespaceAndComments(bytes, generation.end);
      const status = readRegularToken(bytes, statusPosition, bytes.byteLength);
      if (
        generation.value > 65_535
        || (status.value !== "n" && status.value !== "f")
        || records.has(object)
      ) throw new Error("The PDF cross-reference entry is invalid.");
      if (status.value === "n") {
        if (!verifyNormalRecord(
          bytes,
          object,
          generation.value,
          entryOffset.value,
        )) throw new Error("The PDF cross-reference offset is invalid.");
        records.set(object, {
          kind: "normal",
          offset: entryOffset.value,
          generation: generation.value,
        });
      } else {
        records.set(object, { kind: "free" });
      }
      position = status.end;
    }
  }
  if (entries === 0) throw new Error("The PDF cross-reference table is empty.");
  const trailer = parseDictionary(
    bytes,
    position,
    Math.min(bytes.byteLength, position + MAX_PDF_DICTIONARY_BYTES),
    budget,
  );
  const size = directUnsignedInteger(trailer.entries.get("Size"));
  if (size === null || size < 1 || size > MAX_PDF_XREF_ENTRIES) {
    throw new Error("The PDF trailer size is invalid.");
  }
  if ([...records.keys()].some((object) => object >= size)) {
    throw new Error("The PDF cross-reference exceeds its declared size.");
  }
  if (trailer.entries.has("Encrypt")) {
    throw new Error("Encrypted PDF attachments are not supported.");
  }
  return {
    records,
    root: optionalIndirectReference(trailer, "Root"),
    previous: optionalUnsignedInteger(trailer, "Prev"),
    supplemental: optionalUnsignedInteger(trailer, "XRefStm"),
  };
}

function decodeBigEndianInteger(bytes: Buffer, offset: number, width: number): number {
  let value = 0;
  for (let index = 0; index < width; index += 1) {
    value = value * 256 + bytes[offset + index]!;
    if (!Number.isSafeInteger(value)) {
      throw new Error("The PDF cross-reference value is unsafe.");
    }
  }
  return value;
}

function xrefStreamPayload(
  bytes: Buffer,
  dictionary: ParsedDictionary,
): Buffer {
  const length = directUnsignedInteger(dictionary.entries.get("Length"));
  if (length === null || length < 1 || length > MAX_PDF_XREF_BYTES) {
    throw new Error("The PDF cross-reference stream length is invalid.");
  }
  let position = skipWhitespaceAndComments(bytes, dictionary.end);
  if (!startsWithKeyword(bytes, position, "stream")) {
    throw new Error("The PDF cross-reference stream is missing.");
  }
  position += 6;
  if (bytes[position] === 0x0d && bytes[position + 1] === 0x0a) {
    position += 2;
  } else if (bytes[position] === 0x0a || bytes[position] === 0x0d) {
    position += 1;
  } else {
    throw new Error("The PDF cross-reference stream delimiter is invalid.");
  }
  const end = position + length;
  if (end > bytes.byteLength) {
    throw new Error("The PDF cross-reference stream is truncated.");
  }
  const endstream = skipWhitespaceAndComments(bytes, end);
  if (!startsWithKeyword(bytes, endstream, "endstream")) {
    throw new Error("The PDF cross-reference stream length is inconsistent.");
  }
  const filter = dictionary.entries.get("Filter")?.toString("ascii").trim();
  const decodeParameters = dictionary.entries.get("DecodeParms")
    ?.toString("ascii").trim();
  if (decodeParameters && decodeParameters !== "null") {
    throw new Error("The PDF cross-reference predictor is unsupported.");
  }
  const payload = bytes.subarray(position, end);
  if (!filter) return payload;
  if (filter !== "/FlateDecode" && filter !== "/Fl") {
    throw new Error("The PDF cross-reference filter is unsupported.");
  }
  try {
    return inflateSync(payload, { maxOutputLength: MAX_PDF_XREF_BYTES });
  } catch {
    throw new Error("The PDF cross-reference stream cannot be decoded.");
  }
}

function parseXrefStream(
  bytes: Buffer,
  offset: number,
  budget: PdfInspectionBudget,
): ParsedXrefSection {
  const header = parseIndirectObjectHeader(bytes, offset);
  if (!header) throw new Error("The PDF cross-reference stream object is invalid.");
  const dictionary = parseDictionary(
    bytes,
    header.body,
    Math.min(bytes.byteLength, header.body + MAX_PDF_DICTIONARY_BYTES),
    budget,
  );
  if (dictionary.entries.get("Type")?.toString("ascii").trim() !== "/XRef") {
    throw new Error("The PDF cross-reference stream type is invalid.");
  }
  if (dictionary.entries.has("Encrypt")) {
    throw new Error("Encrypted PDF attachments are not supported.");
  }
  const size = directUnsignedInteger(dictionary.entries.get("Size"));
  const widths = integerArray(dictionary.entries.get("W"));
  if (
    size === null
    || size < 1
    || size > MAX_PDF_XREF_ENTRIES
    || !widths
    || widths.length !== 3
    || widths.some((width) => width < 0 || width > 8)
    || widths[0]! + widths[1]! + widths[2]! < 1
  ) throw new Error("The PDF cross-reference stream layout is invalid.");
  const indexes = dictionary.entries.has("Index")
    ? integerArray(dictionary.entries.get("Index"))
    : [0, size];
  if (!indexes || indexes.length === 0 || (indexes.length & 1) !== 0) {
    throw new Error("The PDF cross-reference stream index is invalid.");
  }
  let totalEntries = 0;
  let previousEnd = 0;
  for (let index = 0; index < indexes.length; index += 2) {
    const first = indexes[index]!;
    const count = indexes[index + 1]!;
    if (
      count < 1
      || first < previousEnd
      || first + count > size
      || totalEntries + count > MAX_PDF_XREF_ENTRIES
    ) throw new Error("The PDF cross-reference stream index is unsafe.");
    previousEnd = first + count;
    totalEntries += count;
  }
  const rowWidth = widths[0]! + widths[1]! + widths[2]!;
  const expectedBytes = rowWidth * totalEntries;
  if (expectedBytes < 1 || expectedBytes > MAX_PDF_XREF_BYTES) {
    throw new Error("The PDF cross-reference stream is too large.");
  }
  const payload = xrefStreamPayload(bytes, dictionary);
  if (payload.byteLength !== expectedBytes) {
    throw new Error("The PDF cross-reference stream has an invalid decoded size.");
  }
  const records = new Map<number, PdfXrefRecord>();
  let payloadOffset = 0;
  for (let range = 0; range < indexes.length; range += 2) {
    const first = indexes[range]!;
    const count = indexes[range + 1]!;
    for (let index = 0; index < count; index += 1) {
      budget.consume();
      const type = widths[0] === 0
        ? 1
        : decodeBigEndianInteger(payload, payloadOffset, widths[0]!);
      payloadOffset += widths[0]!;
      const field1 = decodeBigEndianInteger(payload, payloadOffset, widths[1]!);
      payloadOffset += widths[1]!;
      const field2 = decodeBigEndianInteger(payload, payloadOffset, widths[2]!);
      payloadOffset += widths[2]!;
      const object = first + index;
      if (type === 0) {
        records.set(object, { kind: "free" });
      } else if (type === 1) {
        if (field2 > 65_535 || !verifyNormalRecord(bytes, object, field2, field1)) {
          throw new Error("The PDF cross-reference stream offset is invalid.");
        }
        records.set(object, {
          kind: "normal",
          offset: field1,
          generation: field2,
        });
      } else if (type === 2) {
        if (field1 < 1 || field1 >= size) {
          throw new Error("The PDF object stream reference is invalid.");
        }
        records.set(object, { kind: "compressed", container: field1 });
      } else {
        throw new Error("The PDF cross-reference stream entry type is invalid.");
      }
    }
  }
  return {
    records,
    root: optionalIndirectReference(dictionary, "Root"),
    previous: optionalUnsignedInteger(dictionary, "Prev"),
    supplemental: null,
  };
}

function parseXrefSection(
  bytes: Buffer,
  offset: number,
  budget: PdfInspectionBudget,
): ParsedXrefSection {
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= bytes.byteLength) {
    throw new Error("The PDF startxref offset is invalid.");
  }
  return startsWithKeyword(bytes, offset, "xref")
    ? parseXrefTable(bytes, offset, budget)
    : parseXrefStream(bytes, offset, budget);
}

function trailingStartXref(bytes: Buffer): number {
  let end = bytes.byteLength;
  while (end > 0 && isPdfWhitespace(bytes[end - 1])) end -= 1;
  if (end < 5 || bytes.subarray(end - 5, end).toString("ascii") !== "%%EOF") {
    throw new Error("The PDF end marker is missing or has trailing data.");
  }
  const tailStart = Math.max(0, end - MAX_PDF_TAIL_BYTES);
  const tail = bytes.subarray(tailStart, end).toString("ascii");
  const match = /startxref[\x00\x09\x0a\x0c\x0d\x20]+(\d+)[\x00\x09\x0a\x0c\x0d\x20]+%%EOF$/u.exec(tail);
  if (!match) throw new Error("The PDF startxref marker is missing.");
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset)) throw new Error("The PDF startxref is unsafe.");
  return offset;
}

function validateCatalog(
  bytes: Buffer,
  root: PdfReference,
  records: ReadonlyMap<number, PdfXrefRecord>,
  budget: PdfInspectionBudget,
): void {
  const rootRecord = records.get(root.object);
  if (
    !rootRecord
    || rootRecord.kind === "free"
    || (rootRecord.kind === "normal" && rootRecord.generation !== root.generation)
    || (rootRecord.kind === "compressed" && root.generation !== 0)
  ) throw new Error("The PDF catalog reference is unresolved.");
  if (rootRecord.kind === "compressed") return;
  const rootHeader = parseIndirectObjectHeader(bytes, rootRecord.offset);
  if (!rootHeader) throw new Error("The PDF catalog object is invalid.");
  const catalog = parseDictionary(
    bytes,
    rootHeader.body,
    Math.min(bytes.byteLength, rootHeader.body + MAX_PDF_DICTIONARY_BYTES),
    budget,
  );
  if (catalog.entries.get("Type")?.toString("ascii").trim() !== "/Catalog") {
    throw new Error("The PDF root object is not a catalog.");
  }
  const pages = indirectReference(catalog.entries.get("Pages"));
  if (!pages) throw new Error("The PDF catalog has no page tree.");
  const pagesRecord = records.get(pages.object);
  if (
    !pagesRecord
    || pagesRecord.kind === "free"
    || (pagesRecord.kind === "normal" && pagesRecord.generation !== pages.generation)
    || (pagesRecord.kind === "compressed" && pages.generation !== 0)
  ) throw new Error("The PDF page tree reference is unresolved.");
  if (pagesRecord.kind === "compressed") return;
  const pagesHeader = parseIndirectObjectHeader(bytes, pagesRecord.offset);
  if (!pagesHeader) throw new Error("The PDF page tree object is invalid.");
  const pageTree = parseDictionary(
    bytes,
    pagesHeader.body,
    Math.min(bytes.byteLength, pagesHeader.body + MAX_PDF_DICTIONARY_BYTES),
    budget,
  );
  const count = directUnsignedInteger(pageTree.entries.get("Count"));
  if (
    pageTree.entries.get("Type")?.toString("ascii").trim() !== "/Pages"
    || count === null
    || count < 1
    || !/\d+\s+\d+\s+R/u.test(
      pageTree.entries.get("Kids")?.toString("ascii") ?? "",
    )
  ) throw new Error("The PDF page tree is incomplete.");
}

export function hasSafePdfAttachment(bytes: Buffer): boolean {
  try {
    if (
      bytes.byteLength < 32
      || !/^%PDF-[12]\.[0-9](?:[\x00\x09\x0a\x0c\x0d\x20]|$)/u.test(
        bytes.subarray(0, 9).toString("ascii"),
      )
    ) return false;
    const budget = new PdfInspectionBudget();
    const records = new Map<number, PdfXrefRecord>();
    const visited = new Set<number>();
    let root: PdfReference | null = null;
    let offset: number | null = trailingStartXref(bytes);
    for (let depth = 0; offset !== null; depth += 1) {
      if (depth >= MAX_PDF_INCREMENTAL_UPDATES || visited.has(offset)) {
        throw new Error("The PDF cross-reference chain is cyclic or too deep.");
      }
      visited.add(offset);
      const section = parseXrefSection(bytes, offset, budget);
      root ??= section.root;
      for (const [object, record] of section.records) {
        if (!records.has(object)) records.set(object, record);
      }
      if (section.supplemental !== null) {
        if (visited.has(section.supplemental)) {
          throw new Error("The PDF supplemental cross-reference is cyclic.");
        }
        visited.add(section.supplemental);
        const supplemental = parseXrefStream(bytes, section.supplemental, budget);
        root ??= supplemental.root;
        for (const [object, record] of supplemental.records) {
          if (!records.has(object)) records.set(object, record);
        }
      }
      if (section.previous !== null && section.previous >= offset) {
        throw new Error("The PDF incremental cross-reference chain is invalid.");
      }
      offset = section.previous;
    }
    if (!root || records.size === 0) return false;
    for (const record of records.values()) {
      if (
        record.kind === "compressed"
        && records.get(record.container)?.kind !== "normal"
      ) throw new Error("The PDF compressed object container is unresolved.");
    }
    validateCatalog(bytes, root, records, budget);
    return true;
  } catch {
    return false;
  }
}
