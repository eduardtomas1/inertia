import type { FileHandle } from "node:fs/promises";

import { MAX_WORKSPACE_IMAGE_PREVIEW_BYTES } from "../shared/workspace-image-preview.js";

const INSPECTION_BUFFER_BYTES = 64 * 1024;
const MAX_STRUCTURE_RECORDS = 4_096;
const MAX_JPEG_MARKER_FILL_BYTES = 32;
const MAX_GIF_SUB_BLOCKS = Math.ceil(
  MAX_WORKSPACE_IMAGE_PREVIEW_BYTES / 255,
) + 4_096;

export const MAX_WORKSPACE_IMAGE_WIDTH = 8_192;
export const MAX_WORKSPACE_IMAGE_HEIGHT = 8_192;
export const MAX_WORKSPACE_IMAGE_PIXELS = 40_000_000;
export const MAX_WORKSPACE_IMAGE_FRAMES = 256;
export const MAX_WORKSPACE_IMAGE_DECODED_PIXELS = 40_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BMP_VALID_DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);
const BMP_VALID_BITS_PER_PIXEL = new Set([1, 2, 4, 8, 16, 24, 32]);
const MAX_AVIF_FTYP_BYTES = 4_096;
const MAX_AVIF_BOX_DEPTH = 8;

export interface WorkspaceImageMetadata {
  mimeType:
    | "image/avif"
    | "image/bmp"
    | "image/gif"
    | "image/jpeg"
    | "image/png"
    | "image/webp"
    | "image/x-icon";
  width: number;
  height: number;
  frames: number;
}

class InspectionBudget {
  private operations = 0;

  consume(): void {
    this.operations += 1;
    if (this.operations > MAX_STRUCTURE_RECORDS) {
      throw new Error("The workspace image exceeds the structural inspection budget.");
    }
  }
}

class GifSubBlockBudget {
  private blocks = 0;

  consume(): void {
    this.blocks += 1;
    if (this.blocks > MAX_GIF_SUB_BLOCKS) {
      throw new Error("The workspace GIF exceeds the data sub-block budget.");
    }
  }
}

class FileCursor {
  private readonly buffer = Buffer.allocUnsafe(INSPECTION_BUFFER_BYTES);
  private bufferStart = -1;
  private bufferLength = 0;
  position = 0;

  constructor(
    private readonly handle: FileHandle,
    readonly size: number,
  ) {}

  seek(position: number): void {
    if (!Number.isSafeInteger(position) || position < 0 || position > this.size) {
      throw new Error("The workspace image structure is truncated.");
    }
    this.position = position;
  }

  skip(bytes: number): void {
    this.seek(this.position + bytes);
  }

  async byte(): Promise<number> {
    await this.ensureBuffered();
    const value = this.buffer[this.position - this.bufferStart];
    if (value === undefined) {
      throw new Error("The workspace image structure is truncated.");
    }
    this.position += 1;
    return value;
  }

  async bytes(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.size) {
      throw new Error("The workspace image structure is truncated.");
    }
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      await this.ensureBuffered();
      const bufferOffset = this.position - this.bufferStart;
      const available = Math.min(
        length - written,
        this.bufferLength - bufferOffset,
      );
      if (available <= 0) {
        throw new Error("The workspace image structure is truncated.");
      }
      this.buffer.copy(result, written, bufferOffset, bufferOffset + available);
      written += available;
      this.position += available;
    }
    return result;
  }

  async skipGifSubBlocks(budget: GifSubBlockBudget): Promise<void> {
    while (true) {
      await this.ensureBuffered();
      // Payload lengths are read from the already-buffered window and skipped
      // positionally, so a normal 10 MiB GIF needs roughly 160 asynchronous
      // reads rather than one promise turn per 255-byte sub-block.
      while (
        this.position >= this.bufferStart
        && this.position < this.bufferStart + this.bufferLength
      ) {
        budget.consume();
        const length = this.buffer[this.position - this.bufferStart];
        if (length === undefined) {
          throw new Error("The workspace image structure is truncated.");
        }
        this.position += 1;
        if (length === 0) return;
        this.skip(length);
      }
    }
  }

  private async ensureBuffered(): Promise<void> {
    if (
      this.position >= this.bufferStart
      && this.position < this.bufferStart + this.bufferLength
    ) return;
    if (this.position >= this.size) {
      throw new Error("The workspace image structure is truncated.");
    }
    const { bytesRead } = await this.handle.read(
      this.buffer,
      0,
      Math.min(this.buffer.length, this.size - this.position),
      this.position,
    );
    if (bytesRead <= 0) {
      throw new Error("The workspace image structure is truncated.");
    }
    this.bufferStart = this.position;
    this.bufferLength = bytesRead;
  }
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16);
}

function validateMetadata(metadata: WorkspaceImageMetadata): WorkspaceImageMetadata {
  const { width, height, frames } = metadata;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || !Number.isSafeInteger(frames)
    || width <= 0
    || height <= 0
    || frames <= 0
    || width > MAX_WORKSPACE_IMAGE_WIDTH
    || height > MAX_WORKSPACE_IMAGE_HEIGHT
    || frames > MAX_WORKSPACE_IMAGE_FRAMES
    || width * height > MAX_WORKSPACE_IMAGE_PIXELS
    || width * height * frames > MAX_WORKSPACE_IMAGE_DECODED_PIXELS
  ) {
    throw new Error("The workspace image has unsafe decoded dimensions or frames.");
  }
  return metadata;
}

async function inspectPng(
  cursor: FileCursor,
  budget: InspectionBudget,
): Promise<WorkspaceImageMetadata> {
  cursor.seek(0);
  const signature = await cursor.bytes(8);
  if (!signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("The workspace resource is not a supported image.");
  }
  let width = 0;
  let height = 0;
  let declaredFrames: number | null = null;
  let frameControls = 0;
  let expectedSequence = 0;
  let controlledFrameData: "fdAT" | "IDAT" | "none" | null = null;
  let sawImageData = false;
  let imageDataEnded = false;
  for (let records = 0; ; records += 1) {
    budget.consume();
    const header = await cursor.bytes(8);
    const length = header.readUInt32BE(0);
    const kind = ascii(header.subarray(4, 8));
    const dataStart = cursor.position;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > cursor.size) {
      throw new Error("The workspace image structure is truncated.");
    }
    if (records === 0) {
      if (kind !== "IHDR" || length !== 13) {
        throw new Error("The workspace PNG is missing its image header.");
      }
      const dimensions = await cursor.bytes(8);
      width = dimensions.readUInt32BE(0);
      height = dimensions.readUInt32BE(4);
    } else if (kind === "acTL") {
      if (length !== 8 || declaredFrames !== null || sawImageData) {
        throw new Error("The workspace PNG animation header is invalid or misplaced.");
      }
      declaredFrames = (await cursor.bytes(4)).readUInt32BE(0);
      if (declaredFrames === 0 || declaredFrames > MAX_WORKSPACE_IMAGE_FRAMES) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
    } else if (kind === "fcTL") {
      if (declaredFrames === null || length !== 26) {
        throw new Error("The workspace PNG frame control is invalid or misplaced.");
      }
      if (controlledFrameData === "none") {
        throw new Error("The workspace PNG frame control has no frame data.");
      }
      const control = await cursor.bytes(26);
      if (control.readUInt32BE(0) !== expectedSequence) {
        throw new Error("The workspace PNG animation sequence is invalid.");
      }
      expectedSequence += 1;
      const frameWidth = control.readUInt32BE(4);
      const frameHeight = control.readUInt32BE(8);
      const frameX = control.readUInt32BE(12);
      const frameY = control.readUInt32BE(16);
      if (
        frameWidth === 0
        || frameHeight === 0
        || frameX + frameWidth > width
        || frameY + frameHeight > height
      ) throw new Error("The workspace PNG frame exceeds its canvas.");
      if (control[24]! > 2 || control[25]! > 1) {
        throw new Error("The workspace PNG frame control uses invalid operations.");
      }
      frameControls += 1;
      controlledFrameData = "none";
    } else if (kind === "fdAT") {
      if (
        declaredFrames === null
        || !sawImageData
        || controlledFrameData === null
        || controlledFrameData === "IDAT"
        || length <= 4
      ) throw new Error("The workspace PNG frame data is invalid or misplaced.");
      const sequence = (await cursor.bytes(4)).readUInt32BE(0);
      if (sequence !== expectedSequence) {
        throw new Error("The workspace PNG animation sequence is invalid.");
      }
      expectedSequence += 1;
      controlledFrameData = "fdAT";
    } else if (kind === "IDAT") {
      if (imageDataEnded) throw new Error("The workspace PNG image data is misordered.");
      sawImageData = true;
      if (controlledFrameData === "none" || controlledFrameData === "IDAT") {
        controlledFrameData = "IDAT";
      }
    }
    if (sawImageData && kind !== "IDAT") imageDataEnded = true;
    cursor.seek(dataEnd);
    cursor.skip(4);
    if (kind === "IEND") {
      if (length !== 0 || !sawImageData) {
        throw new Error("The workspace PNG has no image data.");
      }
      if (
        declaredFrames !== null
        && (
          frameControls !== declaredFrames
          || frameControls === 0
          || controlledFrameData === "none"
        )
      ) throw new Error("The workspace PNG animation frame count or ordering is invalid.");
      return validateMetadata({
        mimeType: "image/png",
        width,
        height,
        frames: declaredFrames ?? 1,
      });
    }
  }
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

async function inspectJpeg(
  cursor: FileCursor,
  budget: InspectionBudget,
): Promise<WorkspaceImageMetadata> {
  cursor.seek(0);
  if ((await cursor.byte()) !== 0xff || (await cursor.byte()) !== 0xd8) {
    throw new Error("The workspace resource is not a supported image.");
  }
  while (true) {
    budget.consume();
    if ((await cursor.byte()) !== 0xff) {
      throw new Error("The workspace JPEG marker sequence is invalid.");
    }
    let marker = await cursor.byte();
    for (
      let fillBytes = 0;
      marker === 0xff;
      fillBytes += 1
    ) {
      budget.consume();
      if (fillBytes >= MAX_JPEG_MARKER_FILL_BYTES) {
        throw new Error("The workspace JPEG marker fill is too long.");
      }
      marker = await cursor.byte();
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    const segmentLength = (await cursor.bytes(2)).readUInt16BE(0);
    if (segmentLength < 2) throw new Error("The workspace JPEG segment is invalid.");
    const payloadLength = segmentLength - 2;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (payloadLength < 5) throw new Error("The workspace JPEG frame is invalid.");
      const frame = await cursor.bytes(5);
      cursor.skip(payloadLength - 5);
      return validateMetadata({
        mimeType: "image/jpeg",
        width: frame.readUInt16BE(3),
        height: frame.readUInt16BE(1),
        frames: 1,
      });
    }
    cursor.skip(payloadLength);
  }
  throw new Error("The workspace JPEG has no bounded frame header.");
}

async function inspectGif(
  cursor: FileCursor,
  budget: InspectionBudget,
): Promise<WorkspaceImageMetadata> {
  cursor.seek(0);
  const header = ascii(await cursor.bytes(6));
  if (header !== "GIF87a" && header !== "GIF89a") {
    throw new Error("The workspace resource is not a supported image.");
  }
  const screen = await cursor.bytes(7);
  const width = screen.readUInt16LE(0);
  const height = screen.readUInt16LE(2);
  if ((screen[4]! & 0x80) !== 0) {
    cursor.skip(3 * (2 ** ((screen[4]! & 0x07) + 1)));
  }
  let frames = 0;
  const subBlockBudget = new GifSubBlockBudget();
  while (true) {
    budget.consume();
    const introducer = await cursor.byte();
    if (introducer === 0x3b) {
      if (frames === 0) throw new Error("The workspace GIF has no image frames.");
      return validateMetadata({ mimeType: "image/gif", width, height, frames });
    }
    if (introducer === 0x21) {
      await cursor.byte();
      await cursor.skipGifSubBlocks(subBlockBudget);
      continue;
    }
    if (introducer !== 0x2c) throw new Error("The workspace GIF block is invalid.");
    const descriptor = await cursor.bytes(9);
    const left = descriptor.readUInt16LE(0);
    const top = descriptor.readUInt16LE(2);
    const frameWidth = descriptor.readUInt16LE(4);
    const frameHeight = descriptor.readUInt16LE(6);
    if (
      frameWidth === 0
      || frameHeight === 0
      || left + frameWidth > width
      || top + frameHeight > height
    ) throw new Error("The workspace GIF frame exceeds its canvas.");
    frames += 1;
    if (frames > MAX_WORKSPACE_IMAGE_FRAMES) {
      throw new Error("The workspace image has unsafe decoded dimensions or frames.");
    }
    if ((descriptor[8]! & 0x80) !== 0) {
      cursor.skip(3 * (2 ** ((descriptor[8]! & 0x07) + 1)));
    }
    await cursor.byte();
    await cursor.skipGifSubBlocks(subBlockBudget);
  }
}

function webpVp8Dimensions(frame: Buffer): { width: number; height: number } {
  if (frame[3] !== 0x9d || frame[4] !== 0x01 || frame[5] !== 0x2a) {
    throw new Error("The workspace WebP frame signature is invalid.");
  }
  return {
    width: frame.readUInt16LE(6) & 0x3fff,
    height: frame.readUInt16LE(8) & 0x3fff,
  };
}

function webpVp8lDimensions(frame: Buffer): { width: number; height: number } {
  if (frame[0] !== 0x2f) {
    throw new Error("The workspace WebP lossless signature is invalid.");
  }
  return {
    width: 1 + frame[1]! + ((frame[2]! & 0x3f) << 8),
    height: 1 + (frame[2]! >> 6) + (frame[3]! << 2)
      + ((frame[4]! & 0x0f) << 10),
  };
}

async function readWebpBitstreamDimensions(
  cursor: FileCursor,
  kind: "VP8 " | "VP8L",
  length: number,
): Promise<{ width: number; height: number }> {
  if (kind === "VP8 ") {
    if (length < 10) throw new Error("The workspace WebP frame is invalid.");
    return webpVp8Dimensions(await cursor.bytes(10));
  }
  if (length < 5) throw new Error("The workspace WebP lossless frame is invalid.");
  return webpVp8lDimensions(await cursor.bytes(5));
}

async function inspectWebpAnimationFrame(
  cursor: FileCursor,
  frameEnd: number,
  frameWidth: number,
  frameHeight: number,
  budget: InspectionBudget,
): Promise<void> {
  let intrinsicDimensions: { width: number; height: number } | null = null;
  let sawAlpha = false;
  while (cursor.position < frameEnd) {
    budget.consume();
    if (frameEnd - cursor.position < 8) {
      throw new Error("The workspace WebP animation bitstream is truncated.");
    }
    const chunk = await cursor.bytes(8);
    const kind = ascii(chunk.subarray(0, 4));
    const length = chunk.readUInt32LE(4);
    const dataStart = cursor.position;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length & 1);
    if (paddedEnd > frameEnd) {
      throw new Error("The workspace WebP animation bitstream is truncated.");
    }
    if (kind === "ALPH") {
      if (sawAlpha || intrinsicDimensions) {
        throw new Error("The workspace WebP animation alpha chunk is misordered.");
      }
      sawAlpha = true;
    } else if (kind === "VP8 " || kind === "VP8L") {
      if (intrinsicDimensions) {
        throw new Error("The workspace WebP animation has duplicate bitstreams.");
      }
      intrinsicDimensions = await readWebpBitstreamDimensions(
        cursor,
        kind,
        length,
      );
    } else {
      throw new Error("The workspace WebP animation has an invalid nested chunk.");
    }
    cursor.seek(paddedEnd);
  }
  if (
    !intrinsicDimensions
    || intrinsicDimensions.width !== frameWidth
    || intrinsicDimensions.height !== frameHeight
  ) throw new Error("The workspace WebP animation bitstream dimensions do not match its frame.");
}

async function inspectWebp(
  cursor: FileCursor,
  budget: InspectionBudget,
): Promise<WorkspaceImageMetadata> {
  cursor.seek(0);
  const header = await cursor.bytes(12);
  if (ascii(header.subarray(0, 4)) !== "RIFF" || ascii(header.subarray(8, 12)) !== "WEBP") {
    throw new Error("The workspace resource is not a supported image.");
  }
  if (header.readUInt32LE(4) + 8 !== cursor.size) {
    throw new Error("The workspace WebP container length is invalid.");
  }
  let canvas: { width: number; height: number } | null = null;
  let intrinsic: { width: number; height: number } | null = null;
  let extended = false;
  let animated = false;
  let sawAnimationHeader = false;
  let animationFrames = 0;
  let sawAlpha = false;
  let chunks = 0;
  while (cursor.position < cursor.size) {
    budget.consume();
    const chunk = await cursor.bytes(8);
    const kind = ascii(chunk.subarray(0, 4));
    const length = chunk.readUInt32LE(4);
    const dataStart = cursor.position;
    const dataEnd = dataStart + length;
    if (dataEnd + (length & 1) > cursor.size) {
      throw new Error("The workspace WebP structure is truncated.");
    }
    if (kind === "VP8X") {
      if (length !== 10 || chunks !== 0 || extended) {
        throw new Error("The workspace WebP extended header is duplicate or misplaced.");
      }
      const extendedHeader = await cursor.bytes(10);
      if ((extendedHeader[0]! & 0xc1) !== 0) {
        throw new Error("The workspace WebP extended header has reserved flags.");
      }
      extended = true;
      animated = (extendedHeader[0]! & 0x02) !== 0;
      canvas = {
        width: uint24LittleEndian(extendedHeader, 4) + 1,
        height: uint24LittleEndian(extendedHeader, 7) + 1,
      };
    } else if (kind === "VP8 ") {
      if (intrinsic || animationFrames > 0 || animated || (!extended && chunks !== 0)) {
        throw new Error("The workspace WebP image bitstream is duplicate or misplaced.");
      }
      intrinsic = await readWebpBitstreamDimensions(cursor, kind, length);
    } else if (kind === "VP8L") {
      if (intrinsic || animationFrames > 0 || animated || (!extended && chunks !== 0)) {
        throw new Error("The workspace WebP image bitstream is duplicate or misplaced.");
      }
      intrinsic = await readWebpBitstreamDimensions(cursor, kind, length);
    } else if (kind === "ANIM") {
      if (!extended || !animated || sawAnimationHeader || animationFrames > 0 || length !== 6) {
        throw new Error("The workspace WebP animation header is invalid or misplaced.");
      }
      sawAnimationHeader = true;
    } else if (kind === "ANMF") {
      if (!extended || !animated || !sawAnimationHeader || intrinsic || length < 16 || !canvas) {
        throw new Error("The workspace WebP animation frame is invalid.");
      }
      const frame = await cursor.bytes(16);
      const frameX = uint24LittleEndian(frame, 0) * 2;
      const frameY = uint24LittleEndian(frame, 3) * 2;
      const frameWidth = uint24LittleEndian(frame, 6) + 1;
      const frameHeight = uint24LittleEndian(frame, 9) + 1;
      if (frameX + frameWidth > canvas.width || frameY + frameHeight > canvas.height) {
        throw new Error("The workspace WebP animation frame exceeds its canvas.");
      }
      await inspectWebpAnimationFrame(
        cursor,
        dataEnd,
        frameWidth,
        frameHeight,
        budget,
      );
      animationFrames += 1;
      if (animationFrames > MAX_WORKSPACE_IMAGE_FRAMES) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
    } else if (kind === "ALPH") {
      if (!extended || animated || intrinsic || sawAlpha) {
        throw new Error("The workspace WebP alpha chunk is duplicate or misplaced.");
      }
      sawAlpha = true;
    } else if (!extended) {
      throw new Error("The workspace WebP simple image has an invalid chunk.");
    }
    cursor.seek(dataEnd + (length & 1));
    chunks += 1;
  }
  if (animated) {
    if (!extended || !sawAnimationHeader || animationFrames === 0 || intrinsic) {
      throw new Error("The workspace WebP animation structure is incomplete.");
    }
  } else if (!intrinsic || sawAnimationHeader || animationFrames > 0) {
    throw new Error("The workspace WebP static image structure is incomplete.");
  }
  const dimensions = canvas ?? intrinsic!;
  if (
    intrinsic
    && canvas
    && (intrinsic.width !== canvas.width || intrinsic.height !== canvas.height)
  ) throw new Error("The workspace WebP intrinsic dimensions do not match its canvas.");
  const frames = animated ? animationFrames : 1;
  return validateMetadata({
    mimeType: "image/webp",
    width: dimensions.width,
    height: dimensions.height,
    frames,
  });
}

async function inspectBmp(
  cursor: FileCursor,
  budget: InspectionBudget,
): Promise<WorkspaceImageMetadata> {
  cursor.seek(0);
  budget.consume();
  const fileHeader = await cursor.bytes(14);
  if (fileHeader[0] !== 0x42 || fileHeader[1] !== 0x4d) {
    throw new Error("The workspace resource is not a supported image.");
  }
  const pixelDataOffset = fileHeader.readUInt32LE(10);
  const dibHeaderSize = (await cursor.bytes(4)).readUInt32LE(0);
  if (
    !BMP_VALID_DIB_HEADER_SIZES.has(dibHeaderSize)
    || 14 + dibHeaderSize > cursor.size
    || pixelDataOffset < 14 + dibHeaderSize
    || pixelDataOffset > cursor.size
  ) {
    throw new Error("The workspace BMP header is invalid or truncated.");
  }
  let width: number;
  let height: number;
  let planes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    const core = await cursor.bytes(8);
    width = core.readUInt16LE(0);
    height = core.readUInt16LE(2);
    planes = core.readUInt16LE(4);
    bitsPerPixel = core.readUInt16LE(6);
  } else {
    const info = await cursor.bytes(12);
    const rawWidth = info.readInt32LE(0);
    const rawHeight = info.readInt32LE(4);
    planes = info.readUInt16LE(8);
    bitsPerPixel = info.readUInt16LE(10);
    if (rawWidth <= 0 || rawHeight === 0 || rawHeight === -0x8000_0000) {
      throw new Error("The workspace image has unsafe decoded dimensions or frames.");
    }
    width = rawWidth;
    height = Math.abs(rawHeight);
  }
  if (planes !== 1 || !BMP_VALID_BITS_PER_PIXEL.has(bitsPerPixel)) {
    throw new Error("The workspace BMP pixel format is invalid.");
  }
  return validateMetadata({
    mimeType: "image/bmp",
    width,
    height,
    frames: 1,
  });
}

async function inspectIco(
  cursor: FileCursor,
  budget: InspectionBudget,
): Promise<WorkspaceImageMetadata> {
  cursor.seek(0);
  budget.consume();
  const header = await cursor.bytes(6);
  const reserved = header.readUInt16LE(0);
  const type = header.readUInt16LE(2);
  const count = header.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) {
    throw new Error("The workspace resource is not a supported image.");
  }
  if (count === 0 || count > MAX_WORKSPACE_IMAGE_FRAMES) {
    throw new Error("The workspace image has unsafe decoded dimensions or frames.");
  }
  const directoryEnd = 6 + count * 16;
  if (directoryEnd > cursor.size) {
    throw new Error("The workspace image structure is truncated.");
  }
  const entriesTable = await cursor.bytes(count * 16);
  let maxWidth = 0;
  let maxHeight = 0;
  for (let index = 0; index < count; index += 1) {
    budget.consume();
    const base = index * 16;
    let width = entriesTable[base]! === 0 ? 256 : entriesTable[base]!;
    let height = entriesTable[base + 1]! === 0 ? 256 : entriesTable[base + 1]!;
    const imageBytes = entriesTable.readUInt32LE(base + 8);
    const imageOffset = entriesTable.readUInt32LE(base + 12);
    if (
      imageBytes === 0
      || imageOffset < directoryEnd
      || imageOffset + imageBytes > cursor.size
    ) {
      throw new Error("The workspace ICO entry is invalid or truncated.");
    }
    if (imageBytes >= 24) {
      cursor.seek(imageOffset);
      const head = await cursor.bytes(Math.min(imageBytes, 40));
      if (
        head.subarray(0, 8).equals(PNG_SIGNATURE)
        && ascii(head.subarray(12, 16)) === "IHDR"
      ) {
        const pngWidth = head.readUInt32BE(16);
        const pngHeight = head.readUInt32BE(20);
        if (pngWidth === 0 || pngHeight === 0) {
          throw new Error("The workspace image has unsafe decoded dimensions or frames.");
        }
        width = Math.max(width, pngWidth);
        height = Math.max(height, pngHeight);
      } else {
        if (head.length < 40) {
          throw new Error("The workspace ICO entry is invalid or truncated.");
        }
        const dibSize = head.readUInt32LE(0);
        if (dibSize < 40 || dibSize > imageBytes) {
          throw new Error("The workspace ICO entry is invalid or truncated.");
        }
        const dibWidth = head.readInt32LE(4);
        const dibRawHeight = head.readInt32LE(8);
        const dibPlanes = head.readUInt16LE(12);
        const dibBpp = head.readUInt16LE(14);
        const dibHeight = dibRawHeight === -2_147_483_648
          ? 0
          : Math.ceil(Math.abs(dibRawHeight) / 2);
        if (dibWidth <= 0 || dibHeight <= 0 || dibPlanes !== 1 || dibBpp === 0) {
          throw new Error("The workspace image has unsafe decoded dimensions or frames.");
        }
        width = Math.max(width, dibWidth);
        height = Math.max(height, dibHeight);
      }
    } else {
      throw new Error("The workspace ICO entry is invalid or truncated.");
    }
    maxWidth = Math.max(maxWidth, width);
    maxHeight = Math.max(maxHeight, height);
  }
  return validateMetadata({
    mimeType: "image/x-icon",
    width: maxWidth,
    height: maxHeight,
    frames: count,
  });
}

interface IsoBoxHeader {
  readonly type: string;
  readonly payloadStart: number;
  readonly boxEnd: number;
}

async function readIsoBoxHeader(
  cursor: FileCursor,
  containerEnd: number,
): Promise<IsoBoxHeader> {
  if (containerEnd - cursor.position < 8) {
    throw new Error("The workspace AVIF box header is truncated.");
  }
  const boxStart = cursor.position;
  const header = await cursor.bytes(8);
  const size32 = header.readUInt32BE(0);
  const type = ascii(header.subarray(4, 8));
  let boxSize = size32;
  if (size32 === 1) {
    if (containerEnd - cursor.position < 8) {
      throw new Error("The workspace AVIF extended box header is truncated.");
    }
    const size64 = (await cursor.bytes(8)).readBigUInt64BE(0);
    if (size64 < 16n || size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("The workspace AVIF extended box size is invalid.");
    }
    boxSize = Number(size64);
  } else if (size32 === 0) {
    boxSize = containerEnd - boxStart;
  } else if (size32 < 8) {
    throw new Error("The workspace AVIF box size is invalid.");
  }
  const boxEnd = boxStart + boxSize;
  if (boxEnd > containerEnd || boxEnd < cursor.position) {
    throw new Error("The workspace AVIF box exceeds its container.");
  }
  return { type, payloadStart: cursor.position, boxEnd };
}

interface AvifSampleTableState {
  hasStsc: boolean;
  stscEntries: { firstChunk: number; samplesPerChunk: number }[];
  hasChunkTable: boolean;
  chunkCount: number;
  hasStsz: boolean;
  stszSampleSize: number;
  stszSampleCount: number;
  hasStts: boolean;
  sttsFrames: number;
}

interface AvifDimensionState {
  foundIspe: boolean;
  ispeWidth: number;
  ispeHeight: number;
  foundTkhd: boolean;
  tkhdWidth: number;
  tkhdHeight: number;
  codedWidth: number;
  codedHeight: number;
  foundMoov: boolean;
  trackFrames: number;
}

function validateAvifSampleTable(table: AvifSampleTableState): number {
  if (!table.hasStsc || !table.hasChunkTable || table.chunkCount === 0 || table.stscEntries.length === 0) {
    throw new Error("The workspace image has unsafe decoded dimensions or frames.");
  }
  let stscFrames = 0;
  let previousFirstChunk = 0;
  for (let index = 0; index < table.stscEntries.length; index += 1) {
    const entry = table.stscEntries[index]!;
    if (
      entry.firstChunk < 1
      || entry.firstChunk > table.chunkCount
      || (index === 0 ? entry.firstChunk !== 1 : entry.firstChunk <= previousFirstChunk)
      || entry.samplesPerChunk < 1
    ) {
      throw new Error("The workspace image has unsafe decoded dimensions or frames.");
    }
    const nextFirstChunk = index + 1 < table.stscEntries.length
      ? table.stscEntries[index + 1]!.firstChunk
      : table.chunkCount + 1;
    const chunks = nextFirstChunk - entry.firstChunk;
    if (chunks <= 0) {
      throw new Error("The workspace image has unsafe decoded dimensions or frames.");
    }
    stscFrames += chunks * entry.samplesPerChunk;
    if (stscFrames > MAX_WORKSPACE_IMAGE_FRAMES) {
      throw new Error("The workspace image has unsafe decoded dimensions or frames.");
    }
    previousFirstChunk = entry.firstChunk;
  }
  if (table.hasStsz && table.stszSampleCount !== stscFrames) {
    throw new Error("The workspace image has unsafe decoded dimensions or frames.");
  }
  if (table.hasStts && table.sttsFrames !== stscFrames) {
    throw new Error("The workspace image has unsafe decoded dimensions or frames.");
  }
  return stscFrames;
}

async function walkAvifBoxes(
  cursor: FileCursor,
  containerEnd: number,
  depth: number,
  budget: InspectionBudget,
  state: AvifDimensionState,
  sampleTable?: AvifSampleTableState,
): Promise<void> {
  if (depth > MAX_AVIF_BOX_DEPTH) {
    throw new Error("The workspace AVIF container nesting exceeds safe depth.");
  }
  while (cursor.position < containerEnd) {
    budget.consume();
    const { type, payloadStart, boxEnd } = await readIsoBoxHeader(cursor, containerEnd);
    const payloadSize = boxEnd - payloadStart;
    if (type === "meta") {
      if (payloadSize < 4) {
        throw new Error("The workspace AVIF meta box is truncated.");
      }
      cursor.skip(4);
      await walkAvifBoxes(cursor, boxEnd, depth + 1, budget, state, sampleTable);
    } else if (type === "stbl") {
      const table: AvifSampleTableState = {
        hasStsc: false,
        stscEntries: [],
        hasChunkTable: false,
        chunkCount: 0,
        hasStsz: false,
        stszSampleSize: 0,
        stszSampleCount: 0,
        hasStts: false,
        sttsFrames: 0,
      };
      await walkAvifBoxes(cursor, boxEnd, depth + 1, budget, state, table);
      const frames = validateAvifSampleTable(table);
      state.trackFrames = Math.max(state.trackFrames, frames);
    } else if (
      type === "iprp"
      || type === "ipco"
      || type === "moov"
      || type === "trak"
      || type === "mdia"
      || type === "minf"
    ) {
      if (type === "moov") state.foundMoov = true;
      await walkAvifBoxes(cursor, boxEnd, depth + 1, budget, state, sampleTable);
    } else if (type === "ispe") {
      if (payloadSize < 12) {
        throw new Error("The workspace AVIF ispe box is truncated.");
      }
      const data = await cursor.bytes(12);
      const width = data.readUInt32BE(4);
      const height = data.readUInt32BE(8);
      if (width === 0 || height === 0) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
      state.foundIspe = true;
      state.ispeWidth = Math.max(state.ispeWidth, width);
      state.ispeHeight = Math.max(state.ispeHeight, height);
    } else if (type === "tkhd" && payloadSize >= 4) {
      const versionHeader = await cursor.bytes(4);
      const version = versionHeader[0]!;
      const needed = version === 1 ? 92 : 80;
      if (payloadSize - 4 >= needed) {
        cursor.skip(needed - 8);
        const dims = await cursor.bytes(8);
        const width = Math.ceil(dims.readUInt32BE(0) / 65_536);
        const height = Math.ceil(dims.readUInt32BE(4) / 65_536);
        if (width > 0 && height > 0) {
          state.foundTkhd = true;
          state.tkhdWidth = Math.max(state.tkhdWidth, width);
          state.tkhdHeight = Math.max(state.tkhdHeight, height);
        }
      }
    } else if (sampleTable && type === "stsd") {
      if (payloadSize < 8) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
      const header = await cursor.bytes(8);
      const entryCount = header.readUInt32BE(4);
      if (entryCount === 0) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
      for (let index = 0; index < entryCount; index += 1) {
        budget.consume();
        const entryBox = await readIsoBoxHeader(cursor, boxEnd);
        const entryPayloadSize = entryBox.boxEnd - entryBox.payloadStart;
        if (entryBox.type === "av01") {
          if (entryPayloadSize < 28) {
            throw new Error("The workspace image has unsafe decoded dimensions or frames.");
          }
          cursor.skip(24);
          const dims = await cursor.bytes(4);
          const codedWidth = dims.readUInt16BE(0);
          const codedHeight = dims.readUInt16BE(2);
          if (codedWidth === 0 || codedHeight === 0) {
            throw new Error("The workspace image has unsafe decoded dimensions or frames.");
          }
          state.codedWidth = Math.max(state.codedWidth, codedWidth);
          state.codedHeight = Math.max(state.codedHeight, codedHeight);
        }
        cursor.seek(entryBox.boxEnd);
      }
    } else if (sampleTable && type === "stsc") {
      if (sampleTable.hasStsc || payloadSize < 8) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
      const header = await cursor.bytes(8);
      const entryCount = header.readUInt32BE(4);
      if (entryCount > MAX_WORKSPACE_IMAGE_FRAMES || payloadSize - 8 < entryCount * 12) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
      sampleTable.hasStsc = true;
      for (let index = 0; index < entryCount; index += 1) {
        budget.consume();
        const entry = await cursor.bytes(12);
        sampleTable.stscEntries.push({
          firstChunk: entry.readUInt32BE(0),
          samplesPerChunk: entry.readUInt32BE(4),
        });
      }
    } else if (sampleTable && (type === "stco" || type === "co64")) {
      if (sampleTable.hasChunkTable || payloadSize < 8) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
      const header = await cursor.bytes(8);
      const entryCount = header.readUInt32BE(4);
      const stride = type === "co64" ? 8 : 4;
      if (entryCount > MAX_WORKSPACE_IMAGE_FRAMES || payloadSize - 8 < entryCount * stride) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
      sampleTable.hasChunkTable = true;
      sampleTable.chunkCount = entryCount;
    } else if (sampleTable && type === "stsz") {
      if (sampleTable.hasStsz || payloadSize < 12) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
      const header = await cursor.bytes(12);
      sampleTable.hasStsz = true;
      sampleTable.stszSampleSize = header.readUInt32BE(4);
      sampleTable.stszSampleCount = header.readUInt32BE(8);
    } else if (sampleTable && type === "stts") {
      if (sampleTable.hasStts || payloadSize < 8) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
      const header = await cursor.bytes(8);
      const entryCount = header.readUInt32BE(4);
      if (payloadSize - 8 < entryCount * 8) {
        throw new Error("The workspace image has unsafe decoded dimensions or frames.");
      }
      let frames = 0;
      for (let index = 0; index < entryCount; index += 1) {
        budget.consume();
        const entry = await cursor.bytes(8);
        frames += entry.readUInt32BE(0);
        if (frames > MAX_WORKSPACE_IMAGE_FRAMES) {
          throw new Error("The workspace image has unsafe decoded dimensions or frames.");
        }
      }
      sampleTable.hasStts = true;
      sampleTable.sttsFrames = frames;
    }
    cursor.seek(boxEnd);
  }
}

async function inspectAvif(
  cursor: FileCursor,
  budget: InspectionBudget,
): Promise<WorkspaceImageMetadata> {
  cursor.seek(0);
  budget.consume();
  const ftyp = await readIsoBoxHeader(cursor, cursor.size);
  const ftypPayloadBytes = ftyp.boxEnd - ftyp.payloadStart;
  if (
    ftyp.type !== "ftyp"
    || ftypPayloadBytes < 8
    || ftypPayloadBytes > MAX_AVIF_FTYP_BYTES
  ) {
    throw new Error("The workspace resource is not a supported image.");
  }
  const ftypData = await cursor.bytes(ftypPayloadBytes);
  const majorBrand = ascii(ftypData.subarray(0, 4));
  let isAvifBrand = majorBrand === "avif" || majorBrand === "avis";
  let isSequenceBrand = majorBrand === "avis";
  for (let offset = 8; offset + 4 <= ftypData.length; offset += 4) {
    const brand = ascii(ftypData.subarray(offset, offset + 4));
    if (brand === "avif" || brand === "avis") {
      isAvifBrand = true;
    }
    if (brand === "avis") {
      isSequenceBrand = true;
    }
  }
  if (!isAvifBrand) {
    throw new Error("The workspace resource is not a supported image.");
  }
  cursor.seek(ftyp.boxEnd);
  const state: AvifDimensionState = {
    foundIspe: false,
    ispeWidth: 0,
    ispeHeight: 0,
    foundTkhd: false,
    tkhdWidth: 0,
    tkhdHeight: 0,
    codedWidth: 0,
    codedHeight: 0,
    foundMoov: false,
    trackFrames: 0,
  };
  await walkAvifBoxes(cursor, cursor.size, 0, budget, state);
  const width = Math.max(state.ispeWidth, state.tkhdWidth, state.codedWidth);
  const height = Math.max(state.ispeHeight, state.tkhdHeight, state.codedHeight);
  if (width === 0 || height === 0) {
    throw new Error("The workspace AVIF is missing spatial extent dimensions.");
  }
  if (state.foundMoov && state.trackFrames === 0) {
    throw new Error("The workspace image has unsafe decoded dimensions or frames.");
  }
  const frames = state.foundMoov || isSequenceBrand
    ? Math.max(1, state.trackFrames)
    : 1;
  return validateMetadata({
    mimeType: "image/avif",
    width,
    height,
    frames,
  });
}

const SVG_PROLOG_PREFIX_CHARS = 65_536;

function skipXmlProlog(input: string): string | null {
  let index = input.startsWith("\uFEFF") ? 1 : 0;
  const length = input.length;
  while (index < length) {
    while (index < length && /\s/u.test(input[index]!)) index += 1;
    if (input.startsWith("<!--", index)) {
      const end = input.indexOf("-->", index + 4);
      if (end < 0) return null;
      index = end + 3;
      continue;
    }
    if (input.startsWith("<?", index)) {
      const end = input.indexOf("?>", index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (/^<!DOCTYPE(?=[\s[])/iu.test(input.slice(index, index + 11))) {
      index += 9;
      let bracketDepth = 0;
      let quote: string | null = null;
      let closed = false;
      while (index < length) {
        if (!quote) {
          if (input.startsWith("<!--", index)) {
            const commentEnd = input.indexOf("-->", index + 4);
            if (commentEnd < 0) return null;
            index = commentEnd + 3;
            continue;
          }
          if (input.startsWith("<?", index)) {
            const piEnd = input.indexOf("?>", index + 2);
            if (piEnd < 0) return null;
            index = piEnd + 2;
            continue;
          }
        }
        const ch = input[index]!;
        index += 1;
        if (quote) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === "\"" || ch === "'") {
          quote = ch;
        } else if (ch === "[") {
          bracketDepth += 1;
        } else if (ch === "]" && bracketDepth > 0) {
          bracketDepth -= 1;
        } else if (ch === ">" && bracketDepth === 0) {
          closed = true;
          break;
        }
      }
      if (!closed) return null;
      continue;
    }
    break;
  }
  return input.slice(index);
}

export async function inspectWorkspaceSvg(
  handle: FileHandle,
  size: number,
): Promise<void> {
  if (size <= 0) {
    throw new Error("The workspace resource is not a supported image.");
  }
  const buffer = Buffer.allocUnsafe(Math.min(INSPECTION_BUFFER_BYTES, size));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  let prefix = "";
  while (offset < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    );
    if (bytesRead <= 0) {
      throw new Error("The workspace image structure is truncated.");
    }
    const chunk = buffer.subarray(0, bytesRead);
    if (chunk.includes(0)) {
      throw new Error("The workspace SVG contains NUL bytes.");
    }
    let decoded: string;
    try {
      decoded = decoder.decode(chunk, { stream: true });
    } catch {
      throw new Error("The workspace SVG is not valid UTF-8.");
    }
    if (prefix.length < SVG_PROLOG_PREFIX_CHARS) {
      prefix += decoded.slice(0, SVG_PROLOG_PREFIX_CHARS - prefix.length);
    }
    offset += bytesRead;
  }
  let finalText: string;
  try {
    finalText = decoder.decode();
  } catch {
    throw new Error("The workspace SVG is not valid UTF-8.");
  }
  if (finalText.length > 0 && prefix.length < SVG_PROLOG_PREFIX_CHARS) {
    prefix += finalText.slice(0, SVG_PROLOG_PREFIX_CHARS - prefix.length);
  }
  const rootRemainder = skipXmlProlog(prefix);
  if (!rootRemainder || !/^<svg(?=[\s/>])/iu.test(rootRemainder)) {
    throw new Error("The workspace resource is not a supported image.");
  }
}

export async function inspectWorkspaceImageMetadata(
  handle: FileHandle,
  size: number,
): Promise<WorkspaceImageMetadata> {
  const signature = Buffer.allocUnsafe(Math.min(12, size));
  const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
  if (bytesRead !== signature.length) {
    throw new Error("The workspace image structure is truncated.");
  }
  const cursor = new FileCursor(handle, size);
  const budget = new InspectionBudget();
  if (signature.length >= 8 && signature.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return await inspectPng(cursor, budget);
  }
  if (signature[0] === 0xff && signature[1] === 0xd8) return await inspectJpeg(cursor, budget);
  if (signature.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(signature.subarray(0, 6)))) {
    return await inspectGif(cursor, budget);
  }
  if (
    signature.length >= 12
    && ascii(signature.subarray(0, 4)) === "RIFF"
    && ascii(signature.subarray(8, 12)) === "WEBP"
  ) return await inspectWebp(cursor, budget);
  if (signature.length >= 2 && signature[0] === 0x42 && signature[1] === 0x4d) {
    return await inspectBmp(cursor, budget);
  }
  if (
    signature.length >= 4
    && signature[0] === 0x00
    && signature[1] === 0x00
    && signature[2] === 0x01
    && signature[3] === 0x00
  ) return await inspectIco(cursor, budget);
  if (signature.length >= 12 && ascii(signature.subarray(4, 8)) === "ftyp") {
    return await inspectAvif(cursor, budget);
  }
  throw new Error("The workspace resource is not a supported image.");
}
