import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import {
  ACCEPTED_ATTACHMENT_MIME_TYPES,
  chatAttachmentStorageExtension,
} from "../../shared/attachments";

export const TAR_BLOCK_BYTES = 512;
export const TAR_STREAM_CHUNK_BYTES = 256 * 1024;
const TAR_MAX_OCTAL_SIZE = 0o77777777777;
const FILE_MODE = 0o600;
const ATTACHMENT_STORAGE_EXTENSIONS = new Set(
  ACCEPTED_ATTACHMENT_MIME_TYPES.map(chatAttachmentStorageExtension),
);
const ATTACHMENT_ENTRY_PATTERN =
  /^attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([a-z0-9]{1,8})$/iu;

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

function isZeroBuffer(buffer: Uint8Array): boolean {
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

function parseStrictOctal(field: Uint8Array, maxDigits: number): number | null {
  let end = field.length;
  while (end > 0 && (field[end - 1] === 0 || field[end - 1] === 0x20)) {
    end -= 1;
  }
  let start = 0;
  while (start < end && field[start] === 0x20) {
    start += 1;
  }
  const length = end - start;
  if (length < 1 || length > maxDigits) return null;
  let value = 0;
  for (let index = start; index < end; index += 1) {
    const byte = field[index]!;
    if (byte < 0x30 || byte > 0x37) return null;
    value = value * 8 + (byte - 0x30);
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
}

function computeHeaderChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return sum;
}

export function validateRecoveryTarEntryName(name: string): string {
  if (
    name.length < 1
    || Buffer.byteLength(name, "utf8") > 100
    || /[\0-\x1f\x7f\\]/u.test(name)
    || name.startsWith("/")
    || name.endsWith("/")
  ) {
    throw new Error("The recovery bundle contains an invalid entry path.");
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("The recovery bundle contains an unsafe entry path.");
  }
  if (name === "export.json" || name === "manifest.json") {
    return name;
  }
  const match = ATTACHMENT_ENTRY_PATTERN.exec(name);
  if (!match || !ATTACHMENT_STORAGE_EXTENSIONS.has(match[2]!.toLowerCase())) {
    throw new Error("The recovery bundle contains an unsupported entry path.");
  }
  return name;
}

function buildTarHeader(name: string, size: number): Buffer {
  validateRecoveryTarEntryName(name);
  if (!Number.isSafeInteger(size) || size < 0 || size > TAR_MAX_OCTAL_SIZE) {
    throw new Error("The recovery bundle entry size is invalid.");
  }
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  header.write(name, 0, 100, "ascii");
  header.write("0000600\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  const mtime = Math.max(0, Math.floor(Date.now() / 1000));
  header.write(`${mtime.toString(8).padStart(11, "0")}\0`, 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = computeHeaderChecksum(header);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

export function isTarBundleHeader(block: Uint8Array): boolean {
  if (block.length < TAR_BLOCK_BYTES || isZeroBuffer(block.subarray(0, TAR_BLOCK_BYTES))) {
    return false;
  }
  const header = block.subarray(0, TAR_BLOCK_BYTES);
  if (Buffer.from(header.subarray(257, 262)).toString("ascii") !== "ustar") {
    return false;
  }
  const storedChecksum = parseStrictOctal(header.subarray(148, 156), 7);
  return storedChecksum !== null && storedChecksum === computeHeaderChecksum(header);
}

type ParsedTarHeader =
  | { readonly kind: "eof" }
  | { readonly kind: "entry"; readonly name: string; readonly size: number };

function parseTarHeader(block: Buffer): ParsedTarHeader {
  if (block.length !== TAR_BLOCK_BYTES) {
    throw new Error("The recovery bundle is truncated.");
  }
  if (isZeroBuffer(block)) {
    return { kind: "eof" };
  }
  if (block.subarray(257, 262).toString("ascii") !== "ustar") {
    throw new Error("The recovery bundle header is invalid.");
  }
  const storedChecksum = parseStrictOctal(block.subarray(148, 156), 7);
  if (storedChecksum === null || storedChecksum !== computeHeaderChecksum(block)) {
    throw new Error("The recovery bundle header checksum is invalid.");
  }
  const typeflag = block[156]!;
  if (typeflag !== 0x30 && typeflag !== 0x00) {
    throw new Error("The recovery bundle contains an unsupported entry type.");
  }
  if (!isZeroBuffer(block.subarray(345, 500))) {
    throw new Error("The recovery bundle contains an unsupported extended path.");
  }
  const nameField = block.subarray(0, 100);
  const nulIndex = nameField.indexOf(0);
  const nameEnd = nulIndex === -1 ? 100 : nulIndex;
  if (nulIndex !== -1 && !isZeroBuffer(nameField.subarray(nulIndex))) {
    throw new Error("The recovery bundle contains a malformed entry name.");
  }
  const name = validateRecoveryTarEntryName(nameField.subarray(0, nameEnd).toString("utf8"));
  const size = parseStrictOctal(block.subarray(124, 136), 11);
  if (size === null) {
    throw new Error("The recovery bundle contains an invalid entry size.");
  }
  return { kind: "entry", name, size };
}

async function removeRegularFile(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      await unlink(path);
    }
  } catch {
    return;
  }
}

async function writeBufferComplete(
  file: FileHandle,
  buffer: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal, "The database recovery export was cancelled.");
    const { bytesWritten } = await file.write(
      buffer,
      offset,
      buffer.length - offset,
    );
    if (bytesWritten < 1) {
      throw new Error("The recovery bundle write stopped unexpectedly.");
    }
    offset += bytesWritten;
  }
}

async function readExactBytes(
  file: FileHandle,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    throwIfAborted(signal, "The database recovery import was cancelled.");
    const { bytesRead } = await file.read(buffer, offset, length - offset, null);
    if (bytesRead === 0) {
      throw new Error("The recovery bundle is truncated.");
    }
    offset += bytesRead;
  }
  return buffer;
}

export class RecoveryTarWriter {
  private file: FileHandle | null;
  private published = false;
  private closed = false;

  private constructor(
    file: FileHandle,
    private readonly targetPath: string,
    private readonly partialPath: string,
  ) {
    this.file = file;
  }

  static async open(
    targetPath: string,
    signal?: AbortSignal,
  ): Promise<RecoveryTarWriter> {
    throwIfAborted(signal, "The database recovery export was cancelled.");
    try {
      const target = await lstat(targetPath);
      if (!target.isFile() || target.isSymbolicLink()) {
        throw new Error("The recovery export target is not a local file.");
      }
    } catch (error) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "ENOENT"
      ) throw error;
    }
    const partialPath = join(
      dirname(targetPath),
      `.inertia-recovery-${randomUUID()}.partial`,
    );
    const file = await open(
      partialPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      FILE_MODE,
    );
    return new RecoveryTarWriter(file, targetPath, partialPath);
  }

  async writeBufferEntry(
    name: string,
    data: Buffer,
    signal?: AbortSignal,
  ): Promise<{ readonly size: number; readonly sha256: string }> {
    const file = this.requireOpen();
    throwIfAborted(signal, "The database recovery export was cancelled.");
    const header = buildTarHeader(name, data.byteLength);
    await writeBufferComplete(file, header, signal);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < data.byteLength) {
      const end = Math.min(data.byteLength, offset + TAR_STREAM_CHUNK_BYTES);
      const slice = data.subarray(offset, end);
      hash.update(slice);
      await writeBufferComplete(file, slice, signal);
      offset = end;
    }
    const remainder = data.byteLength % TAR_BLOCK_BYTES;
    if (remainder !== 0) {
      await writeBufferComplete(file, Buffer.alloc(TAR_BLOCK_BYTES - remainder), signal);
    }
    return { size: data.byteLength, sha256: hash.digest("hex") };
  }

  async writeFileStreamEntry(
    name: string,
    source: FileHandle,
    expectedSize: number,
    signal?: AbortSignal,
  ): Promise<{ readonly size: number; readonly sha256: string }> {
    const file = this.requireOpen();
    throwIfAborted(signal, "The database recovery export was cancelled.");
    const header = buildTarHeader(name, expectedSize);
    await writeBufferComplete(file, header, signal);
    const chunk = Buffer.allocUnsafe(TAR_STREAM_CHUNK_BYTES);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < expectedSize) {
      throwIfAborted(signal, "The database recovery export was cancelled.");
      const toRead = Math.min(chunk.length, expectedSize - offset);
      const { bytesRead } = await source.read(chunk, 0, toRead, offset);
      if (bytesRead === 0) {
        throw new Error("The attachment file changed while exporting.");
      }
      const slice = chunk.subarray(0, bytesRead);
      hash.update(slice);
      await writeBufferComplete(file, slice, signal);
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await source.read(overflow, 0, 1, expectedSize);
    if (overflowBytes !== 0) {
      throw new Error("The attachment file changed while exporting.");
    }
    const remainder = expectedSize % TAR_BLOCK_BYTES;
    if (remainder !== 0) {
      await writeBufferComplete(file, Buffer.alloc(TAR_BLOCK_BYTES - remainder), signal);
    }
    return { size: expectedSize, sha256: hash.digest("hex") };
  }

  async finish(signal?: AbortSignal): Promise<void> {
    const file = this.requireOpen();
    throwIfAborted(signal, "The database recovery export was cancelled.");
    await writeBufferComplete(file, Buffer.alloc(TAR_BLOCK_BYTES * 2), signal);
    await file.chmod(FILE_MODE);
    await file.sync();
    await file.close();
    this.file = null;
    this.closed = true;
    throwIfAborted(signal, "The database recovery export was cancelled.");
    await rename(this.partialPath, this.targetPath);
    this.published = true;
  }

  async abort(): Promise<void> {
    if (this.file) {
      const handle = this.file;
      this.file = null;
      this.closed = true;
      await handle.close().catch(() => undefined);
    }
    if (!this.published) {
      await removeRegularFile(this.partialPath);
    }
  }

  private requireOpen(): FileHandle {
    if (!this.file || this.closed) {
      throw new Error("The recovery bundle writer is closed.");
    }
    return this.file;
  }
}

export interface StreamRecoveryTarOptions {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalPayloadBytes: number;
  readonly signal?: AbortSignal;
}

export interface StreamedRecoveryTarEntry {
  readonly name: string;
  readonly size: number;
  readonly chunks: () => AsyncGenerator<Buffer, void, void>;
}

export async function streamRecoveryTarEntries(
  filePath: string,
  options: StreamRecoveryTarOptions,
  onEntry: (entry: StreamedRecoveryTarEntry) => Promise<void>,
): Promise<{ readonly bundleSha256: string; readonly totalSize: number }> {
  throwIfAborted(options.signal, "The database recovery import was cancelled.");
  const metadata = await lstat(filePath);
  throwIfAborted(options.signal, "The database recovery import was cancelled.");
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < TAR_BLOCK_BYTES * 2
    || metadata.size > options.maxArchiveBytes
  ) {
    throw new Error("The recovery bundle file is unavailable, truncated, or too large.");
  }
  if (metadata.size % TAR_BLOCK_BYTES !== 0) {
    throw new Error("The recovery bundle is truncated.");
  }
  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  const file = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== metadata.size) {
      throw new Error("The recovery bundle file changed while opening.");
    }
    const bundleHash = createHash("sha256");
    const seenNames = new Set<string>();
    let entryCount = 0;
    let totalPayloadBytes = 0;
    let totalRead = 0;
    let eofReached = false;

    while (totalRead < before.size) {
      throwIfAborted(options.signal, "The database recovery import was cancelled.");
      const headerBlock = await readExactBytes(file, TAR_BLOCK_BYTES, options.signal);
      bundleHash.update(headerBlock);
      totalRead += TAR_BLOCK_BYTES;
      const parsed = parseTarHeader(headerBlock);
      if (parsed.kind === "eof") {
        const secondEof = await readExactBytes(file, TAR_BLOCK_BYTES, options.signal);
        bundleHash.update(secondEof);
        totalRead += TAR_BLOCK_BYTES;
        if (!isZeroBuffer(secondEof)) {
          throw new Error("The recovery bundle is truncated or corrupted.");
        }
        while (totalRead < before.size) {
          const trailing = await readExactBytes(file, TAR_BLOCK_BYTES, options.signal);
          bundleHash.update(trailing);
          totalRead += TAR_BLOCK_BYTES;
          if (!isZeroBuffer(trailing)) {
            throw new Error("The recovery bundle contains unexpected trailing data.");
          }
        }
        eofReached = true;
        break;
      }
      if (seenNames.has(parsed.name)) {
        throw new Error("The recovery bundle contains a duplicate entry.");
      }
      seenNames.add(parsed.name);
      entryCount += 1;
      if (entryCount > options.maxEntries) {
        throw new Error("The recovery bundle contains too many entries.");
      }
      if (parsed.size > options.maxEntryBytes) {
        throw new Error("A recovery bundle entry exceeds the maximum allowed size.");
      }
      totalPayloadBytes += parsed.size;
      if (!Number.isSafeInteger(totalPayloadBytes) || totalPayloadBytes > options.maxTotalPayloadBytes) {
        throw new Error("The recovery bundle exceeds the maximum allowed total size.");
      }
      let remaining = parsed.size;
      let started = false;
      const chunks = async function* (): AsyncGenerator<Buffer, void, void> {
        if (started) {
          throw new Error("The recovery bundle entry stream was read twice.");
        }
        started = true;
        const scratch = Buffer.allocUnsafe(Math.min(TAR_STREAM_CHUNK_BYTES, Math.max(1, remaining)));
        while (remaining > 0) {
          throwIfAborted(options.signal, "The database recovery import was cancelled.");
          const toRead = Math.min(scratch.length, remaining);
          const { bytesRead } = await file.read(scratch, 0, toRead, null);
          if (bytesRead === 0) {
            throw new Error("The recovery bundle is truncated.");
          }
          const slice = Buffer.from(scratch.subarray(0, bytesRead));
          bundleHash.update(slice);
          totalRead += bytesRead;
          remaining -= bytesRead;
          yield slice;
        }
      };
      await onEntry({ name: parsed.name, size: parsed.size, chunks });
      if (remaining !== 0) {
        throw new Error("The recovery bundle entry was not read completely.");
      }
      const remainder = parsed.size % TAR_BLOCK_BYTES;
      if (remainder !== 0) {
        const padding = await readExactBytes(
          file,
          TAR_BLOCK_BYTES - remainder,
          options.signal,
        );
        bundleHash.update(padding);
        totalRead += padding.length;
        if (!isZeroBuffer(padding)) {
          throw new Error("The recovery bundle contains invalid entry padding.");
        }
      }
    }
    if (!eofReached || totalRead !== before.size) {
      throw new Error("The recovery bundle is truncated.");
    }
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await file.read(overflow, 0, 1, null);
    const after = await file.stat();
    if (
      overflowBytes !== 0
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("The recovery bundle file changed while reading.");
    }
    return {
      bundleSha256: bundleHash.digest("hex"),
      totalSize: before.size,
    };
  } finally {
    await file.close();
  }
}
