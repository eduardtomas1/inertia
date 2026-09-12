import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { pngChunk } from "../fixtures/attachments/png-chunks";
import {
  ImageAttachmentTooLargeError,
  MAX_IMAGE_PIXELS,
  imageAttachmentTooLargeMessage,
} from "../../src/main/attachment-image-validation";
import { validateAttachmentImport } from "../../src/main/attachment-import";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const CONTENT_MISMATCH = "Attachment content does not match its safe file type.";

/**
 * Builds a solid-colour PNG by hand (not via the canvas encoder) so the
 * validator is checked against an independent producer. "rgba" mirrors a
 * clipboard screenshot; "mono" (1-bit greyscale) keeps huge fixtures small.
 */
function solidPng(
  width: number,
  height: number,
  format: "mono" | "rgba" = "mono",
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = format === "rgba" ? 8 : 1;
  header[9] = format === "rgba" ? 6 : 0;
  const row = format === "rgba"
    ? Buffer.concat([
        Buffer.from([0]),
        Buffer.alloc(width * 4, Buffer.from([0x25, 0x63, 0xeb, 0xff])),
      ])
    : Buffer.alloc(1 + Math.ceil(width / 8));
  const scanlines = Buffer.concat(Array<Buffer>(height).fill(row));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from(deflateSync(scanlines))),
    pngChunk("IEND"),
  ]);
}

function importPng(data: Buffer): ReturnType<typeof validateAttachmentImport> {
  return validateAttachmentImport({
    name: "clipboard.png",
    mimeType: "image/png",
    data,
  });
}

function importError(data: Buffer): unknown {
  try {
    importPng(data);
  } catch (error) {
    return error;
  }
  throw new Error("Expected the attachment import to be rejected.");
}

describe("attachment image size limits", () => {
  it.each([
    ["4K", 3_840, 2_160, "rgba"],
    ["5K", 5_120, 2_880, "mono"],
    ["6K", 6_016, 3_384, "mono"],
  ] as const)("accepts a %s screenshot", (_label, width, height, format) => {
    const data = solidPng(width, height, format);

    expect(importPng(data)).toMatchObject({
      mimeType: "image/png",
      size: data.length,
    });
  });

  it.each([
    ["just over the pixel cap", 8_000, 5_001],
    ["wider than the per-side cap", 11_520, 2_160],
  ])("reports an image %s as too large, not as malformed", (
    _label,
    width,
    height,
  ) => {
    const error = importError(solidPng(width, height));

    expect(error).toBeInstanceOf(ImageAttachmentTooLargeError);
    expect(error).toMatchObject({
      code: "image-too-large",
      width,
      height,
      message: imageAttachmentTooLargeMessage(width, height),
    });
    expect((error as Error).message).not.toBe(CONTENT_MISMATCH);
  });

  it("states the dimensions, rounded-up size, and supported limit", () => {
    expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
    expect(imageAttachmentTooLargeMessage(8_000, 5_001)).toBe(
      "This image is too large (8000×5001 pixels, 40.1 MP). "
        + "Images up to 40 megapixels and 8192 pixels per side are supported. "
        + "Resize it and try again.",
    );
  });

  it("keeps the generic rejection for malformed images of any declared size", () => {
    const oversized = solidPng(8_000, 5_001);
    const corruptChecksum = Buffer.from(oversized);
    const idat = corruptChecksum.indexOf(Buffer.from("IDAT", "ascii"));
    corruptChecksum[idat + 4] ^= 0x01;
    const withoutEnd = oversized.subarray(0, -12);
    const small = solidPng(64, 64);
    const truncated = small.subarray(0, small.length - 20);
    // PNG forbids sides beyond 2^31 - 1, so this header is malformed, not large.
    const beyondFormat = Buffer.from(small);
    beyondFormat.writeUInt32BE(0x8000_0000, 16);
    beyondFormat.writeUInt32BE(crc32(beyondFormat.subarray(12, 29)), 29);

    for (const data of [corruptChecksum, withoutEnd, truncated, beyondFormat]) {
      const error = importError(data);
      expect(error).not.toBeInstanceOf(ImageAttachmentTooLargeError);
      expect(error).toMatchObject({ message: CONTENT_MISMATCH });
    }
  });
});
