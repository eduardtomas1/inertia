import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

import { MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES } from "../node/document-text-errors.js";
import { readBoundedDocumentArchive } from "../node/document-text-zip.js";
import type { OpenProjectPathRequest } from "../shared/desktop.js";
import {
  MAX_WORKSPACE_IMAGE_PREVIEW_BYTES,
  maxWorkspaceImagePreviewBytesForPath,
} from "../shared/workspace-image-preview.js";
import {
  classifyWorkspaceMediaPath,
  MAX_WORKSPACE_MEDIA_AV_BYTES,
  MAX_WORKSPACE_MEDIA_PDF_BYTES,
  MAX_WORKSPACE_MEDIA_SPREADSHEET_BYTES,
  MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES,
  type WorkspaceMediaDescriptor,
} from "../shared/workspace-media-preview.js";
import {
  inspectWorkspaceImageMetadata,
  inspectWorkspaceSvg,
} from "./workspace-image-metadata.js";
import {
  openContainedWorkspaceFile,
  verifyOpenFileIdentity,
  WORKSPACE_SVG_CONTENT_SECURITY_POLICY,
  type ProjectPathResolver,
} from "./workspace-image-preview.js";

const MAX_ACTIVE_WORKSPACE_MEDIA_STREAMS = 32;
const MAX_PENDING_WORKSPACE_MEDIA_STREAMS = 64;
const WORKSPACE_MEDIA_STREAM_CHUNK_BYTES = 128 * 1024;
const PDF_HEADER_PROBE_BYTES = 1_024;
const AV_HEADER_PROBE_BYTES = 4_096;
const DEV_LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u;
const EXPOSED_MEDIA_HEADERS =
  "Content-Length, Content-Range, Accept-Ranges, X-Workspace-Media-Truncated";

const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");
const ZIP_LOCAL_HEADER_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const EBML_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const OGG_SIGNATURE = Buffer.from("OggS", "ascii");
const FLAC_SIGNATURE = Buffer.from("fLaC", "ascii");
const RIFF_SIGNATURE = Buffer.from("RIFF", "ascii");
const WAVE_SIGNATURE = Buffer.from("WAVE", "ascii");
const ID3_SIGNATURE = Buffer.from("ID3", "ascii");
const ISOBMFF_PRIMARY_BOXES = new Set(["ftyp", "moov", "mdat"]);
const ISOBMFF_PRELUDE_BOXES = new Set(["free", "skip", "wide", "pnot"]);
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_COMMENT_BYTES = 65_535;

export interface WorkspaceMediaPreviewOptions {
  readonly allowDevLoopbackCors?: boolean;
}

interface StreamWaiter {
  readonly resolve: (release: () => void) => void;
}

let activeWorkspaceMediaStreams = 0;
const workspaceMediaStreamWaiters: StreamWaiter[] = [];

function drainWorkspaceMediaStreamWaiters(): void {
  while (
    workspaceMediaStreamWaiters.length > 0
    && activeWorkspaceMediaStreams < MAX_ACTIVE_WORKSPACE_MEDIA_STREAMS
  ) {
    const next = workspaceMediaStreamWaiters.shift()!;
    activeWorkspaceMediaStreams += 1;
    next.resolve(releaseWorkspaceMediaStream());
  }
}

function releaseWorkspaceMediaStream(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWorkspaceMediaStreams -= 1;
    drainWorkspaceMediaStreamWaiters();
  };
}

function assertRequestActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("The workspace media request was cancelled.");
  }
}

async function acquireWorkspaceMediaStream(
  signal?: AbortSignal,
): Promise<() => void> {
  assertRequestActive(signal);
  if (
    workspaceMediaStreamWaiters.length === 0
    && activeWorkspaceMediaStreams < MAX_ACTIVE_WORKSPACE_MEDIA_STREAMS
  ) {
    activeWorkspaceMediaStreams += 1;
    return releaseWorkspaceMediaStream();
  }
  if (workspaceMediaStreamWaiters.length >= MAX_PENDING_WORKSPACE_MEDIA_STREAMS) {
    throw new Error("Too many workspace media streams are waiting to open.");
  }
  return await new Promise<() => void>((resolvePermit, rejectPermit) => {
    let waiter: StreamWaiter;
    const removeAbortListener = (): void => {
      signal?.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      const index = workspaceMediaStreamWaiters.indexOf(waiter);
      if (index >= 0) workspaceMediaStreamWaiters.splice(index, 1);
      removeAbortListener();
      rejectPermit(new Error("The workspace media request was cancelled."));
      drainWorkspaceMediaStreamWaiters();
    };
    waiter = {
      resolve: (release) => {
        removeAbortListener();
        resolvePermit(release);
      },
    };
    workspaceMediaStreamWaiters.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function allowedDevLoopbackOrigin(
  webRequest: Request,
  options?: WorkspaceMediaPreviewOptions,
): string | null {
  if (!options?.allowDevLoopbackCors) return null;
  const origin = webRequest.headers?.get?.("origin");
  return origin && DEV_LOOPBACK_ORIGIN.test(origin) ? origin : null;
}

function baseHeaders(
  webRequest: Request,
  options?: WorkspaceMediaPreviewOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const origin = allowedDevLoopbackOrigin(webRequest, options);
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
    headers["Access-Control-Expose-Headers"] = EXPOSED_MEDIA_HEADERS;
  }
  return headers;
}

interface ParsedByteRange {
  readonly start: number;
  readonly end: number;
}

type ByteRangeParseResult =
  | { readonly kind: "none" }
  | { readonly kind: "range"; readonly range: ParsedByteRange }
  | { readonly kind: "invalid" };

function parseByteRangeHeader(
  rangeHeader: string | null | undefined,
  size: number,
): ByteRangeParseResult {
  if (!rangeHeader) return { kind: "none" };
  const trimmed = rangeHeader.trim();
  if (!/^bytes=/iu.test(trimmed)) return { kind: "invalid" };
  const spec = trimmed.slice(6).trim();
  if (spec.includes(",")) return { kind: "invalid" };
  const match = /^(\d*)-(\d*)$/u.exec(spec);
  if (!match) return { kind: "invalid" };
  const startText = match[1]!;
  const endText = match[2]!;
  if (startText === "" && endText === "") return { kind: "invalid" };
  if (size <= 0) return { kind: "invalid" };

  if (startText === "") {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: "invalid" };
    }
    const start = Math.max(0, size - suffixLength);
    return { kind: "range", range: { start, end: size - 1 } };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
    return { kind: "invalid" };
  }
  if (endText === "") {
    return { kind: "range", range: { start, end: size - 1 } };
  }
  const rawEnd = Number(endText);
  if (!Number.isSafeInteger(rawEnd) || rawEnd < start) {
    return { kind: "invalid" };
  }
  return { kind: "range", range: { start, end: Math.min(rawEnd, size - 1) } };
}

function createFileRangeStream(
  handle: FileHandle,
  info: Stats,
  start: number,
  end: number,
  release: () => void,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let offset = start;
  let remaining = end - start + 1;
  let disposed = false;
  let closeStarted = false;
  let inFlightRead: Promise<unknown> | null = null;
  let removeAbortListener = (): void => undefined;

  const dispose = async (): Promise<void> => {
    disposed = true;
    removeAbortListener();
    if (closeStarted) return;
    closeStarted = true;
    try {
      await inFlightRead?.catch(() => undefined);
    } finally {
      try {
        await handle.close();
      } finally {
        release();
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const abort = (): void => {
        if (disposed) return;
        disposed = true;
        try {
          controller.error(new Error("The workspace media request was cancelled."));
        } catch {
          // Controller may already be closed or errored.
        }
        void dispose().catch(() => undefined);
      };
      removeAbortListener = (): void => {
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    pull: async (controller) => {
      if (disposed) return;
      try {
        if (remaining <= 0) {
          const verifyPromise = verifyOpenFileIdentity(handle, info);
          inFlightRead = verifyPromise;
          try {
            await verifyPromise;
          } finally {
            inFlightRead = null;
          }
          if (disposed) return;
          controller.close();
          await dispose();
          return;
        }
        const chunkBytes = Math.min(WORKSPACE_MEDIA_STREAM_CHUNK_BYTES, remaining);
        const buffer = Buffer.allocUnsafe(chunkBytes);
        const readPromise = handle.read(buffer, 0, chunkBytes, offset);
        inFlightRead = readPromise;
        let bytesRead: number;
        try {
          ({ bytesRead } = await readPromise);
        } finally {
          inFlightRead = null;
        }
        if (disposed) return;
        if (bytesRead <= 0) {
          throw new Error("The workspace media file changed while streaming.");
        }
        offset += bytesRead;
        remaining -= bytesRead;
        controller.enqueue(
          bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
        );
      } catch (error) {
        if (disposed) return;
        try {
          controller.error(error);
        } catch {
          // Controller may already be closed or errored.
        } finally {
          await dispose().catch(() => undefined);
        }
      }
    },
    cancel: () => dispose().catch(() => undefined),
  }, { highWaterMark: 1 });
}

async function readProbeBytes(
  handle: FileHandle,
  size: number,
  maxProbeBytes: number,
): Promise<Buffer> {
  const length = Math.min(size, maxProbeBytes);
  const buffer = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalRead,
      length - totalRead,
      totalRead,
    );
    if (bytesRead <= 0) {
      throw new Error("The workspace media file is truncated.");
    }
    totalRead += bytesRead;
  }
  return buffer;
}

function hasValidIsoBmffHeader(probe: Buffer, totalSize: number): boolean {
  let offset = 0;
  for (let boxes = 0; boxes < 8 && offset + 8 <= probe.length; boxes += 1) {
    const size32 = probe.readUInt32BE(offset);
    const boxType = probe.subarray(offset + 4, offset + 8).toString("ascii");
    let boxSize = size32;
    if (size32 === 1) {
      if (offset + 16 > probe.length) return false;
      const size64 = probe.readBigUInt64BE(offset + 8);
      if (size64 < 16n || size64 > BigInt(totalSize)) return false;
      boxSize = Number(size64);
    } else if (size32 === 0) {
      boxSize = totalSize - offset;
    } else if (size32 < 8) {
      return false;
    }
    if (offset + boxSize > totalSize) return false;
    if (ISOBMFF_PRIMARY_BOXES.has(boxType)) return true;
    if (!ISOBMFF_PRELUDE_BOXES.has(boxType)) return false;
    offset += boxSize;
  }
  return false;
}

function validateAvContainerMagic(
  extension: string,
  probe: Buffer,
  totalSize: number,
): void {
  switch (extension) {
    case "mp4":
    case "m4v":
    case "mov":
    case "m4a":
      if (!hasValidIsoBmffHeader(probe, totalSize)) {
        throw new Error("The workspace media file does not match an MP4/QuickTime container.");
      }
      return;
    case "webm":
    case "mkv":
      if (probe.length < 4 || !probe.subarray(0, 4).equals(EBML_SIGNATURE)) {
        throw new Error("The workspace media file does not match a WebM/Matroska container.");
      }
      return;
    case "ogv":
    case "ogg":
    case "oga":
    case "opus":
      if (probe.length < 4 || !probe.subarray(0, 4).equals(OGG_SIGNATURE)) {
        throw new Error("The workspace media file does not match an Ogg container.");
      }
      return;
    case "wav":
      if (
        probe.length < 12
        || !probe.subarray(0, 4).equals(RIFF_SIGNATURE)
        || !probe.subarray(8, 12).equals(WAVE_SIGNATURE)
      ) {
        throw new Error("The workspace media file does not match a WAV container.");
      }
      return;
    case "flac":
      if (probe.length < 4 || !probe.subarray(0, 4).equals(FLAC_SIGNATURE)) {
        throw new Error("The workspace media file does not match a FLAC container.");
      }
      return;
    case "mp3":
    case "aac": {
      const hasId3 = probe.length >= 5
        && probe.subarray(0, 3).equals(ID3_SIGNATURE)
        && probe[3] !== 0xff
        && probe[4] !== 0xff;
      const hasFrameSync = probe.length >= 2
        && probe[0] === 0xff
        && (probe[1]! & 0xe0) === 0xe0
        && probe[1] !== 0xff;
      if (!hasId3 && !hasFrameSync) {
        throw new Error("The workspace media file does not match an MP3/AAC audio stream.");
      }
      return;
    }
    default:
      throw new Error("The workspace audio/video format is not supported.");
  }
}

function validateCentralDirectoryExpandedBudget(bytes: Buffer): void {
  const minOffset = Math.max(0, bytes.length - EOCD_MIN_BYTES - EOCD_MAX_COMMENT_BYTES);
  let eocdOffset = -1;
  for (let offset = bytes.length - EOCD_MIN_BYTES; offset >= minOffset; offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === EOCD_SIGNATURE
      && offset + EOCD_MIN_BYTES + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("The workspace spreadsheet archive is malformed.");
  }
  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  const directoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  let cursor = directoryOffset;
  let totalUncompressedBytes = 0;
  const entries: { method: number; compressedSize: number; uncompressedSize: number; localOffset: number }[] = [];
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocdOffset || bytes.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error("The workspace spreadsheet archive is malformed.");
    }
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES) {
      throw new Error("The workspace spreadsheet archive exceeds expanded size limits.");
    }
    entries.push({
      method: bytes.readUInt16LE(cursor + 10),
      compressedSize: bytes.readUInt32LE(cursor + 20),
      uncompressedSize,
      localOffset: bytes.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  for (const entry of entries) {
    if (
      entry.localOffset + 30 > directoryOffset
      || bytes.readUInt32LE(entry.localOffset) !== ZIP_LOCAL_HEADER_SIGNATURE.readUInt32LE(0)
    ) {
      throw new Error("The workspace spreadsheet archive is malformed.");
    }
    const dataStart = entry.localOffset + 30
      + bytes.readUInt16LE(entry.localOffset + 26)
      + bytes.readUInt16LE(entry.localOffset + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > directoryOffset) {
      throw new Error("The workspace spreadsheet archive is malformed.");
    }
    let expandedSize: number;
    if (entry.method === 0) {
      expandedSize = entry.compressedSize;
    } else if (entry.method === 8) {
      try {
        expandedSize = inflateRawSync(bytes.subarray(dataStart, dataEnd), {
          maxOutputLength: entry.uncompressedSize + 1,
        }).byteLength;
      } catch {
        throw new Error("The workspace spreadsheet archive is malformed.");
      }
    } else {
      throw new Error("The workspace spreadsheet archive is malformed.");
    }
    if (expandedSize !== entry.uncompressedSize) {
      throw new Error("The workspace spreadsheet archive is malformed.");
    }
  }
}

function trimIncompleteUtf8Tail(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  const lastIndex = buffer.length - 1;
  if (buffer[lastIndex]! < 0x80) return buffer;
  let index = lastIndex;
  const minIndex = Math.max(0, buffer.length - 4);
  while (index > minIndex && (buffer[index]! & 0xc0) === 0x80) {
    index -= 1;
  }
  const lead = buffer[index]!;
  let expectedLength = 0;
  if ((lead & 0xe0) === 0xc0) expectedLength = 2;
  else if ((lead & 0xf0) === 0xe0) expectedLength = 3;
  else if ((lead & 0xf8) === 0xf0) expectedLength = 4;
  else return buffer;
  const actualLength = buffer.length - index;
  return actualLength < expectedLength ? buffer.subarray(0, index) : buffer;
}

async function serveRangeOrFullStream(options: {
  handle: FileHandle;
  info: Stats;
  mimeType: string;
  method: string;
  webRequest: Request;
  previewOptions?: WorkspaceMediaPreviewOptions;
  extraHeaders?: Record<string, string>;
  allowRanges: boolean;
}): Promise<Response> {
  const { handle, info, mimeType, method, webRequest, previewOptions, extraHeaders, allowRanges } = options;
  const signal = webRequest.signal;
  const headers: Record<string, string> = {
    ...baseHeaders(webRequest, previewOptions),
    ...extraHeaders,
    "Content-Type": mimeType,
  };
  let streamOwnsHandle = false;
  let releaseSlot: (() => void) | null = null;

  try {
    let status = 200;
    let start = 0;
    let end = info.size - 1;
    if (allowRanges) {
      headers["Accept-Ranges"] = "bytes";
      const parsed = parseByteRangeHeader(webRequest.headers?.get?.("range"), info.size);
      if (parsed.kind === "invalid") {
        return new Response(method === "HEAD" ? null : "Range Not Satisfiable", {
          status: 416,
          headers: {
            ...baseHeaders(webRequest, previewOptions),
            "Content-Range": `bytes */${info.size}`,
          },
        });
      }
      if (parsed.kind === "range") {
        status = 206;
        start = parsed.range.start;
        end = parsed.range.end;
        headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
      }
    }

    headers["Content-Length"] = String(end - start + 1);
    if (method === "HEAD") {
      await verifyOpenFileIdentity(handle, info);
      return new Response(null, { status, headers });
    }
    releaseSlot = await acquireWorkspaceMediaStream(signal);
    assertRequestActive(signal);
    await verifyOpenFileIdentity(handle, info);
    const release = releaseSlot;
    const stream = createFileRangeStream(handle, info, start, end, release, signal);
    streamOwnsHandle = true;
    releaseSlot = null;
    return new Response(stream, { status, headers });
  } finally {
    if (!streamOwnsHandle) {
      try {
        await handle.close();
      } finally {
        releaseSlot?.();
      }
    }
  }
}

async function resolveImageMedia(
  path: string,
  requestedRelativePath: string,
  descriptor: WorkspaceMediaDescriptor,
  method: string,
  webRequest: Request,
  options?: WorkspaceMediaPreviewOptions,
): Promise<Response> {
  const signal = webRequest.signal;
  const { handle, info } = await openContainedWorkspaceFile(path, {
    maxBytes: Math.max(
      maxWorkspaceImagePreviewBytesForPath(requestedRelativePath),
      maxWorkspaceImagePreviewBytesForPath(path),
    ),
    allowEmpty: false,
    signal,
  });
  let mimeType: string;
  let extraHeaders: Record<string, string> | undefined;
  try {
    if (descriptor.extension === "svg") {
      await inspectWorkspaceSvg(handle, info.size);
      mimeType = "image/svg+xml";
      extraHeaders = {
        "Content-Security-Policy": WORKSPACE_SVG_CONTENT_SECURITY_POLICY,
      };
    } else {
      const metadata = await inspectWorkspaceImageMetadata(handle, info.size);
      mimeType = metadata.mimeType;
    }
    if (info.size > MAX_WORKSPACE_IMAGE_PREVIEW_BYTES && mimeType !== "image/bmp") {
      throw new Error("The workspace image exceeds the preview size limit.");
    }
    assertRequestActive(signal);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return await serveRangeOrFullStream({
    handle,
    info,
    mimeType,
    method,
    webRequest,
    previewOptions: options,
    extraHeaders,
    allowRanges: false,
  });
}

async function resolveAvMedia(
  path: string,
  descriptor: WorkspaceMediaDescriptor,
  method: string,
  webRequest: Request,
  options?: WorkspaceMediaPreviewOptions,
): Promise<Response> {
  const signal = webRequest.signal;
  const { handle, info } = await openContainedWorkspaceFile(path, {
    maxBytes: MAX_WORKSPACE_MEDIA_AV_BYTES,
    allowEmpty: false,
    signal,
  });
  try {
    const probe = await readProbeBytes(handle, info.size, AV_HEADER_PROBE_BYTES);
    validateAvContainerMagic(descriptor.extension, probe, info.size);
    assertRequestActive(signal);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return await serveRangeOrFullStream({
    handle,
    info,
    mimeType: descriptor.mimeType,
    method,
    webRequest,
    previewOptions: options,
    allowRanges: true,
  });
}

async function resolvePdfMedia(
  path: string,
  descriptor: WorkspaceMediaDescriptor,
  method: string,
  webRequest: Request,
  options?: WorkspaceMediaPreviewOptions,
): Promise<Response> {
  const signal = webRequest.signal;
  const { handle, info } = await openContainedWorkspaceFile(path, {
    maxBytes: MAX_WORKSPACE_MEDIA_PDF_BYTES,
    allowEmpty: false,
    signal,
  });
  try {
    const probe = await readProbeBytes(handle, info.size, PDF_HEADER_PROBE_BYTES);
    if (!probe.includes(PDF_SIGNATURE)) {
      throw new Error("The workspace PDF file is missing a valid %PDF- header.");
    }
    assertRequestActive(signal);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return await serveRangeOrFullStream({
    handle,
    info,
    mimeType: descriptor.mimeType,
    method,
    webRequest,
    previewOptions: options,
    allowRanges: true,
  });
}

async function resolveZipSpreadsheetMedia(
  path: string,
  descriptor: WorkspaceMediaDescriptor,
  method: string,
  webRequest: Request,
  options?: WorkspaceMediaPreviewOptions,
): Promise<Response> {
  const signal = webRequest.signal;
  const { handle, info } = await openContainedWorkspaceFile(path, {
    maxBytes: MAX_WORKSPACE_MEDIA_SPREADSHEET_BYTES,
    allowEmpty: false,
    signal,
  });
  let bytes: Buffer;
  try {
    bytes = await readProbeBytes(handle, info.size, info.size);
    if (
      bytes.length < ZIP_LOCAL_HEADER_SIGNATURE.length
      || !bytes.subarray(0, 4).equals(ZIP_LOCAL_HEADER_SIGNATURE)
    ) {
      throw new Error("The workspace spreadsheet archive does not have a ZIP signature.");
    }
    validateCentralDirectoryExpandedBudget(bytes);
    readBoundedDocumentArchive(bytes);
    assertRequestActive(signal);
    await verifyOpenFileIdentity(handle, info);
  } finally {
    await handle.close();
  }
  const headers: Record<string, string> = {
    ...baseHeaders(webRequest, options),
    "Content-Type": descriptor.mimeType,
    "Content-Length": String(bytes.byteLength),
  };
  if (method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

async function resolveOleSpreadsheetMedia(
  path: string,
  descriptor: WorkspaceMediaDescriptor,
  method: string,
  webRequest: Request,
  options?: WorkspaceMediaPreviewOptions,
): Promise<Response> {
  const signal = webRequest.signal;
  const { handle, info } = await openContainedWorkspaceFile(path, {
    maxBytes: MAX_WORKSPACE_MEDIA_SPREADSHEET_BYTES,
    allowEmpty: false,
    signal,
  });
  try {
    const probe = await readProbeBytes(handle, info.size, OLE2_SIGNATURE.length);
    if (probe.length < OLE2_SIGNATURE.length || !probe.equals(OLE2_SIGNATURE)) {
      throw new Error("The workspace XLS file does not have an OLE2 header.");
    }
    assertRequestActive(signal);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return await serveRangeOrFullStream({
    handle,
    info,
    mimeType: descriptor.mimeType,
    method,
    webRequest,
    previewOptions: options,
    allowRanges: false,
  });
}

function decodeBoundedTextSpreadsheet(
  raw: Buffer,
  sourceTruncated: boolean,
): { readonly bytes: Buffer; readonly truncated: boolean } {
  if (raw.length >= 2 && ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff))) {
    const littleEndian = raw[0] === 0xff;
    let payload = raw.subarray(2);
    if (sourceTruncated && payload.length % 2 !== 0) {
      payload = payload.subarray(0, payload.length - 1);
    }
    if (payload.length % 2 !== 0) {
      throw new Error("The workspace text spreadsheet has truncated UTF-16 bytes.");
    }
    if (sourceTruncated && payload.length >= 2) {
      const lastUnit = littleEndian
        ? payload.readUInt16LE(payload.length - 2)
        : payload.readUInt16BE(payload.length - 2);
      if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
        payload = payload.subarray(0, payload.length - 2);
      }
    }
    let decoded: string;
    try {
      decoded = new TextDecoder(littleEndian ? "utf-16le" : "utf-16be", { fatal: true }).decode(payload);
    } catch {
      throw new Error("The workspace text spreadsheet is not valid UTF-16.");
    }
    if (decoded.includes("\0")) {
      throw new Error("The workspace text spreadsheet contains NUL bytes.");
    }
    const utf8 = Buffer.from(decoded, "utf8");
    if (utf8.byteLength > MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES) {
      return {
        bytes: trimIncompleteUtf8Tail(utf8.subarray(0, MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES)),
        truncated: true,
      };
    }
    return { bytes: utf8, truncated: sourceTruncated };
  }
  if (raw.includes(0)) {
    throw new Error("The workspace text spreadsheet contains NUL bytes.");
  }
  const slice = sourceTruncated ? trimIncompleteUtf8Tail(raw) : raw;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    throw new Error("The workspace text spreadsheet is not valid UTF-8.");
  }
  return { bytes: slice, truncated: sourceTruncated };
}

async function resolveTextSpreadsheetMedia(
  path: string,
  descriptor: WorkspaceMediaDescriptor,
  method: string,
  webRequest: Request,
  options?: WorkspaceMediaPreviewOptions,
): Promise<Response> {
  const signal = webRequest.signal;
  const { handle, info } = await openContainedWorkspaceFile(path, {
    maxBytes: Number.MAX_SAFE_INTEGER,
    allowEmpty: true,
    signal,
  });
  let truncated = info.size > MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES;
  const bytesToRead = Math.min(info.size, MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES);
  let slice: Buffer;
  try {
    if (bytesToRead === 0) {
      slice = Buffer.alloc(0);
    } else {
      const raw = await readProbeBytes(handle, bytesToRead, bytesToRead);
      const decoded = decodeBoundedTextSpreadsheet(raw, truncated);
      slice = decoded.bytes;
      truncated = decoded.truncated;
    }
    assertRequestActive(signal);
    await verifyOpenFileIdentity(handle, info);
  } finally {
    await handle.close();
  }
  const headers: Record<string, string> = {
    ...baseHeaders(webRequest, options),
    "Content-Type": `${descriptor.mimeType}; charset=utf-8`,
    "Content-Length": String(slice.byteLength),
    ...(truncated ? { "X-Workspace-Media-Truncated": "true" } : {}),
  };
  if (method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(new Uint8Array(slice), { status: 200, headers });
}

export async function resolveWorkspaceMediaPreviewResponse(
  runtimeSupervisor: ProjectPathResolver,
  request: OpenProjectPathRequest,
  webRequest: Request,
  options?: WorkspaceMediaPreviewOptions,
): Promise<Response> {
  const signal = webRequest.signal;
  assertRequestActive(signal);

  const descriptor = classifyWorkspaceMediaPath(request.relativePath);
  if (!descriptor) {
    return new Response("Not found", {
      status: 404,
      headers: {
        ...baseHeaders(webRequest, options),
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const method = (webRequest.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") {
    const devOrigin = allowedDevLoopbackOrigin(webRequest, options);
    if (devOrigin) {
      return new Response(null, {
        status: 204,
        headers: {
          ...baseHeaders(webRequest, options),
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range",
        },
      });
    }
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        ...baseHeaders(webRequest, options),
        Allow: "GET, HEAD",
      },
    });
  }
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        ...baseHeaders(webRequest, options),
        Allow: "GET, HEAD",
      },
    });
  }

  const path = await runtimeSupervisor.resolveProjectPath(request);
  assertRequestActive(signal);

  switch (descriptor.kind) {
    case "image":
      return await resolveImageMedia(path, request.relativePath, descriptor, method, webRequest, options);
    case "video":
    case "audio":
      return await resolveAvMedia(path, descriptor, method, webRequest, options);
    case "pdf":
      return await resolvePdfMedia(path, descriptor, method, webRequest, options);
    case "spreadsheet":
      if (
        descriptor.extension === "xlsx"
        || descriptor.extension === "xlsm"
        || descriptor.extension === "ods"
      ) {
        return await resolveZipSpreadsheetMedia(path, descriptor, method, webRequest, options);
      }
      if (descriptor.extension === "xls") {
        return await resolveOleSpreadsheetMedia(path, descriptor, method, webRequest, options);
      }
      return await resolveTextSpreadsheetMedia(path, descriptor, method, webRequest, options);
  }
}
