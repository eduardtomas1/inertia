import { Image } from "@napi-rs/canvas";

import type { ImageAttachmentMimeType } from "../shared/attachments.js";

const MAX_IMAGE_WIDTH = 8_192;
const MAX_IMAGE_HEIGHT = 8_192;
const MAX_IMAGE_PIXELS = 6_000_000;
const MAX_IMAGE_FRAMES = 256;
const MAX_IMAGE_DECODED_PIXELS = 12_000_000;
const MAX_STRUCTURE_RECORDS = 4_096;
const MAX_JPEG_MARKER_FILL_BYTES = 32;
const MAX_GIF_SUB_BLOCKS = 48_000;

interface ImageMetadata {
  readonly width: number;
  readonly height: number;
  readonly frames: number;
}

class InspectionBudget {
  private records = 0;

  consume(): void {
    this.records += 1;
    if (this.records > MAX_STRUCTURE_RECORDS) {
      throw new Error("The image exceeds the structural inspection budget.");
    }
  }
}

class BufferCursor {
  position = 0;

  constructor(readonly bytes: Buffer) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  byte(): number {
    const value = this.bytes[this.position];
    if (value === undefined) throw new Error("The image structure is truncated.");
    this.position += 1;
    return value;
  }

  read(length: number): Buffer {
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || this.position + length > this.size
    ) throw new Error("The image structure is truncated.");
    const result = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return result;
  }

  seek(position: number): void {
    if (!Number.isSafeInteger(position) || position < 0 || position > this.size) {
      throw new Error("The image structure is truncated.");
    }
    this.position = position;
  }

  skip(length: number): void {
    this.seek(this.position + length);
  }

  skipGifSubBlocks(): void {
    for (let blocks = 0; ; blocks += 1) {
      if (blocks >= MAX_GIF_SUB_BLOCKS) {
        throw new Error("The GIF exceeds the data sub-block budget.");
      }
      const length = this.byte();
      if (length === 0) return;
      this.skip(length);
    }
  }
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let checksum = value;
  for (let bit = 0; bit < 8; bit += 1) {
    checksum = (checksum & 1) === 1
      ? 0xedb88320 ^ (checksum >>> 1)
      : checksum >>> 1;
  }
  return checksum >>> 0;
});

function crc32(bytes: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum = CRC32_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16);
}

function validateMetadata(metadata: ImageMetadata): ImageMetadata {
  const { width, height, frames } = metadata;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || !Number.isSafeInteger(frames)
    || width <= 0
    || height <= 0
    || frames <= 0
    || width > MAX_IMAGE_WIDTH
    || height > MAX_IMAGE_HEIGHT
    || frames > MAX_IMAGE_FRAMES
    || width * height > MAX_IMAGE_PIXELS
    || width * height * frames > MAX_IMAGE_DECODED_PIXELS
  ) throw new Error("The image has unsafe decoded dimensions or frames.");
  return metadata;
}

function inspectPng(bytes: Buffer): ImageMetadata {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (bytes.byteLength < 8 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("The attachment is not a PNG image.");
  }
  const cursor = new BufferCursor(bytes);
  const budget = new InspectionBudget();
  cursor.skip(8);
  let width = 0;
  let height = 0;
  let declaredFrames: number | null = null;
  let frameControls = 0;
  let expectedSequence = 0;
  let controlledFrameData: "fdAT" | "IDAT" | "none" | null = null;
  let sawImageData = false;
  let imageDataEnded = false;
  for (let record = 0; ; record += 1) {
    budget.consume();
    const header = cursor.read(8);
    const length = header.readUInt32BE(0);
    const kind = ascii(header.subarray(4, 8));
    const data = cursor.read(length);
    const expectedCrc = cursor.read(4).readUInt32BE(0);
    if (crc32(Buffer.concat([header.subarray(4, 8), data])) !== expectedCrc) {
      throw new Error("The PNG chunk checksum is invalid.");
    }
    if (record === 0) {
      if (kind !== "IHDR" || length !== 13) {
        throw new Error("The PNG is missing its image header.");
      }
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      validateMetadata({ width, height, frames: 1 });
    } else if (kind === "IHDR") {
      throw new Error("The PNG has duplicate image headers.");
    } else if (kind === "acTL") {
      if (length !== 8 || declaredFrames !== null || sawImageData) {
        throw new Error("The PNG animation header is invalid or misplaced.");
      }
      declaredFrames = data.readUInt32BE(0);
      validateMetadata({ width, height, frames: declaredFrames });
    } else if (kind === "fcTL") {
      if (declaredFrames === null || length !== 26) {
        throw new Error("The PNG frame control is invalid or misplaced.");
      }
      if (controlledFrameData === "none") {
        throw new Error("The PNG frame control has no frame data.");
      }
      if (data.readUInt32BE(0) !== expectedSequence) {
        throw new Error("The PNG animation sequence is invalid.");
      }
      expectedSequence += 1;
      const frameWidth = data.readUInt32BE(4);
      const frameHeight = data.readUInt32BE(8);
      const frameX = data.readUInt32BE(12);
      const frameY = data.readUInt32BE(16);
      if (
        frameWidth === 0
        || frameHeight === 0
        || frameX + frameWidth > width
        || frameY + frameHeight > height
        || data[24]! > 2
        || data[25]! > 1
      ) throw new Error("The PNG frame control is invalid.");
      frameControls += 1;
      controlledFrameData = "none";
    } else if (kind === "fdAT") {
      if (
        declaredFrames === null
        || !sawImageData
        || controlledFrameData === null
        || controlledFrameData === "IDAT"
        || length <= 4
        || data.readUInt32BE(0) !== expectedSequence
      ) throw new Error("The PNG frame data is invalid or misplaced.");
      expectedSequence += 1;
      controlledFrameData = "fdAT";
    } else if (kind === "IDAT") {
      if (imageDataEnded || length === 0) {
        throw new Error("The PNG image data is empty or misordered.");
      }
      sawImageData = true;
      if (controlledFrameData === "none" || controlledFrameData === "IDAT") {
        controlledFrameData = "IDAT";
      }
    }
    if (sawImageData && kind !== "IDAT") imageDataEnded = true;
    if (kind !== "IEND") continue;
    if (
      length !== 0
      || !sawImageData
      || cursor.position !== cursor.size
      || (
        declaredFrames !== null
        && (
          frameControls !== declaredFrames
          || frameControls === 0
          || controlledFrameData === "none"
        )
      )
    ) throw new Error("The PNG image data or animation is incomplete.");
    return validateMetadata({
      width,
      height,
      frames: declaredFrames ?? 1,
    });
  }
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function nextJpegMarker(
  cursor: BufferCursor,
  inScan: boolean,
  budget: InspectionBudget,
): number {
  if (inScan) {
    while (cursor.position < cursor.size) {
      if (cursor.byte() !== 0xff) continue;
      let marker = cursor.byte();
      for (let fill = 0; marker === 0xff; fill += 1) {
        budget.consume();
        if (fill >= MAX_JPEG_MARKER_FILL_BYTES) {
          throw new Error("The JPEG marker fill is too long.");
        }
        marker = cursor.byte();
      }
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      return marker;
    }
    throw new Error("The JPEG scan is missing its end marker.");
  }
  if (cursor.byte() !== 0xff) {
    throw new Error("The JPEG marker sequence is invalid.");
  }
  let marker = cursor.byte();
  for (let fill = 0; marker === 0xff; fill += 1) {
    budget.consume();
    if (fill >= MAX_JPEG_MARKER_FILL_BYTES) {
      throw new Error("The JPEG marker fill is too long.");
    }
    marker = cursor.byte();
  }
  return marker;
}

function inspectJpeg(bytes: Buffer): ImageMetadata {
  const cursor = new BufferCursor(bytes);
  const budget = new InspectionBudget();
  if (cursor.byte() !== 0xff || cursor.byte() !== 0xd8) {
    throw new Error("The attachment is not a JPEG image.");
  }
  let metadata: ImageMetadata | null = null;
  let inScan = false;
  let sawScan = false;
  while (cursor.position < cursor.size) {
    budget.consume();
    const marker = nextJpegMarker(cursor, inScan, budget);
    inScan = false;
    if (marker === 0xd9) {
      if (!metadata || !sawScan || cursor.position !== cursor.size) {
        throw new Error("The JPEG image is incomplete or has trailing data.");
      }
      return metadata;
    }
    if (
      marker === 0x00
      || marker === 0xd8
      || (marker >= 0xd0 && marker <= 0xd7)
      || marker === 0x01
    ) throw new Error("The JPEG marker is invalid in this position.");
    const segmentLength = cursor.read(2).readUInt16BE(0);
    if (segmentLength < 2) throw new Error("The JPEG segment is invalid.");
    const payload = cursor.read(segmentLength - 2);
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (metadata || payload.byteLength < 6) {
        throw new Error("The JPEG frame header is invalid or duplicate.");
      }
      const components = payload[5]!;
      if (
        components < 1
        || payload.byteLength !== 6 + components * 3
      ) throw new Error("The JPEG frame component table is invalid.");
      metadata = validateMetadata({
        width: payload.readUInt16BE(3),
        height: payload.readUInt16BE(1),
        frames: 1,
      });
    }
    if (marker !== 0xda) continue;
    if (!metadata || payload.byteLength < 4) {
      throw new Error("The JPEG scan header is invalid.");
    }
    const components = payload[0]!;
    if (components < 1 || payload.byteLength !== 4 + components * 2) {
      throw new Error("The JPEG scan component table is invalid.");
    }
    sawScan = true;
    inScan = true;
  }
  throw new Error("The JPEG image is missing its end marker.");
}

function inspectGif(bytes: Buffer): ImageMetadata {
  const cursor = new BufferCursor(bytes);
  const budget = new InspectionBudget();
  const header = ascii(cursor.read(6));
  if (header !== "GIF87a" && header !== "GIF89a") {
    throw new Error("The attachment is not a GIF image.");
  }
  const screen = cursor.read(7);
  const width = screen.readUInt16LE(0);
  const height = screen.readUInt16LE(2);
  validateMetadata({ width, height, frames: 1 });
  if ((screen[4]! & 0x80) !== 0) {
    cursor.skip(3 * (2 ** ((screen[4]! & 0x07) + 1)));
  }
  let frames = 0;
  while (true) {
    budget.consume();
    const introducer = cursor.byte();
    if (introducer === 0x3b) {
      if (frames === 0 || cursor.position !== cursor.size) {
        throw new Error("The GIF has no frames or contains trailing data.");
      }
      return validateMetadata({ width, height, frames });
    }
    if (introducer === 0x21) {
      cursor.byte();
      cursor.skipGifSubBlocks();
      continue;
    }
    if (introducer !== 0x2c) throw new Error("The GIF block is invalid.");
    const descriptor = cursor.read(9);
    const left = descriptor.readUInt16LE(0);
    const top = descriptor.readUInt16LE(2);
    const frameWidth = descriptor.readUInt16LE(4);
    const frameHeight = descriptor.readUInt16LE(6);
    if (
      frameWidth === 0
      || frameHeight === 0
      || left + frameWidth > width
      || top + frameHeight > height
    ) throw new Error("The GIF frame exceeds its canvas.");
    frames += 1;
    validateMetadata({ width, height, frames });
    if ((descriptor[8]! & 0x80) !== 0) {
      cursor.skip(3 * (2 ** ((descriptor[8]! & 0x07) + 1)));
    }
    const codeSize = cursor.byte();
    if (codeSize < 2 || codeSize > 8) {
      throw new Error("The GIF LZW code size is invalid.");
    }
    cursor.skipGifSubBlocks();
  }
}

function webpVp8Dimensions(frame: Buffer): { width: number; height: number } {
  if (
    frame.byteLength < 10
    || frame[3] !== 0x9d
    || frame[4] !== 0x01
    || frame[5] !== 0x2a
  ) throw new Error("The WebP frame signature is invalid.");
  return {
    width: frame.readUInt16LE(6) & 0x3fff,
    height: frame.readUInt16LE(8) & 0x3fff,
  };
}

function webpVp8lDimensions(frame: Buffer): { width: number; height: number } {
  if (frame.byteLength < 5 || frame[0] !== 0x2f) {
    throw new Error("The WebP lossless frame signature is invalid.");
  }
  return {
    width: 1 + frame[1]! + ((frame[2]! & 0x3f) << 8),
    height: 1 + (frame[2]! >> 6) + (frame[3]! << 2)
      + ((frame[4]! & 0x0f) << 10),
  };
}

function inspectWebpAnimationFrame(
  bytes: Buffer,
  width: number,
  height: number,
  budget: InspectionBudget,
): void {
  const cursor = new BufferCursor(bytes);
  let intrinsic: { width: number; height: number } | null = null;
  let sawAlpha = false;
  while (cursor.position < cursor.size) {
    budget.consume();
    const header = cursor.read(8);
    const kind = ascii(header.subarray(0, 4));
    const length = header.readUInt32LE(4);
    const data = cursor.read(length);
    if ((length & 1) !== 0) cursor.skip(1);
    if (kind === "ALPH") {
      if (sawAlpha || intrinsic) {
        throw new Error("The WebP animation alpha chunk is misordered.");
      }
      sawAlpha = true;
    } else if (kind === "VP8 ") {
      if (intrinsic) throw new Error("The WebP frame has duplicate bitstreams.");
      intrinsic = webpVp8Dimensions(data);
    } else if (kind === "VP8L") {
      if (intrinsic) throw new Error("The WebP frame has duplicate bitstreams.");
      intrinsic = webpVp8lDimensions(data);
    } else {
      throw new Error("The WebP animation has an invalid nested chunk.");
    }
  }
  if (!intrinsic || intrinsic.width !== width || intrinsic.height !== height) {
    throw new Error("The WebP frame dimensions do not match its descriptor.");
  }
}

function inspectWebp(bytes: Buffer): ImageMetadata {
  const cursor = new BufferCursor(bytes);
  const budget = new InspectionBudget();
  const header = cursor.read(12);
  if (
    ascii(header.subarray(0, 4)) !== "RIFF"
    || ascii(header.subarray(8, 12)) !== "WEBP"
    || header.readUInt32LE(4) + 8 !== cursor.size
  ) throw new Error("The WebP container length or signature is invalid.");
  let canvas: { width: number; height: number } | null = null;
  let intrinsic: { width: number; height: number } | null = null;
  let extended = false;
  let animated = false;
  let sawAnimationHeader = false;
  let frames = 0;
  let sawAlpha = false;
  let chunks = 0;
  while (cursor.position < cursor.size) {
    budget.consume();
    const chunk = cursor.read(8);
    const kind = ascii(chunk.subarray(0, 4));
    const length = chunk.readUInt32LE(4);
    const data = cursor.read(length);
    if ((length & 1) !== 0) cursor.skip(1);
    if (kind === "VP8X") {
      if (length !== 10 || chunks !== 0 || extended || (data[0]! & 0xc1) !== 0) {
        throw new Error("The WebP extended header is invalid or misplaced.");
      }
      extended = true;
      animated = (data[0]! & 0x02) !== 0;
      canvas = {
        width: uint24LittleEndian(data, 4) + 1,
        height: uint24LittleEndian(data, 7) + 1,
      };
      validateMetadata({ ...canvas, frames: 1 });
    } else if (kind === "VP8 " || kind === "VP8L") {
      if (intrinsic || frames > 0 || animated || (!extended && chunks !== 0)) {
        throw new Error("The WebP image bitstream is duplicate or misplaced.");
      }
      intrinsic = kind === "VP8 "
        ? webpVp8Dimensions(data)
        : webpVp8lDimensions(data);
      validateMetadata({ ...intrinsic, frames: 1 });
    } else if (kind === "ANIM") {
      if (!extended || !animated || sawAnimationHeader || frames > 0 || length !== 6) {
        throw new Error("The WebP animation header is invalid or misplaced.");
      }
      sawAnimationHeader = true;
    } else if (kind === "ANMF") {
      if (
        !extended
        || !animated
        || !sawAnimationHeader
        || intrinsic
        || length < 16
        || !canvas
      ) throw new Error("The WebP animation frame is invalid.");
      const frameX = uint24LittleEndian(data, 0) * 2;
      const frameY = uint24LittleEndian(data, 3) * 2;
      const frameWidth = uint24LittleEndian(data, 6) + 1;
      const frameHeight = uint24LittleEndian(data, 9) + 1;
      if (frameX + frameWidth > canvas.width || frameY + frameHeight > canvas.height) {
        throw new Error("The WebP animation frame exceeds its canvas.");
      }
      inspectWebpAnimationFrame(
        data.subarray(16),
        frameWidth,
        frameHeight,
        budget,
      );
      frames += 1;
      validateMetadata({ ...canvas, frames });
    } else if (kind === "ALPH") {
      if (!extended || animated || intrinsic || sawAlpha) {
        throw new Error("The WebP alpha chunk is duplicate or misplaced.");
      }
      sawAlpha = true;
    } else if (!extended) {
      throw new Error("The WebP simple image has an invalid chunk.");
    }
    chunks += 1;
  }
  if (animated) {
    if (!sawAnimationHeader || frames === 0 || intrinsic) {
      throw new Error("The WebP animation structure is incomplete.");
    }
  } else if (!intrinsic || sawAnimationHeader || frames > 0) {
    throw new Error("The WebP static image structure is incomplete.");
  }
  const dimensions = canvas ?? intrinsic!;
  if (
    intrinsic
    && canvas
    && (intrinsic.width !== canvas.width || intrinsic.height !== canvas.height)
  ) throw new Error("The WebP intrinsic dimensions do not match its canvas.");
  return validateMetadata({
    ...dimensions,
    frames: animated ? frames : 1,
  });
}

function decodedImageMatches(bytes: Buffer, metadata: ImageMetadata): boolean {
  try {
    const image = new Image();
    image.src = bytes;
    return image.width === metadata.width && image.height === metadata.height;
  } catch {
    return false;
  }
}

export function hasSafeImageAttachment(
  bytes: Buffer,
  mimeType: ImageAttachmentMimeType,
): boolean {
  try {
    const metadata = mimeType === "image/png"
      ? inspectPng(bytes)
      : mimeType === "image/jpeg"
        ? inspectJpeg(bytes)
        : mimeType === "image/gif"
          ? inspectGif(bytes)
          : inspectWebp(bytes);
    return decodedImageMatches(bytes, metadata);
  } catch {
    return false;
  }
}
