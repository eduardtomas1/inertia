// @inertia-test-suite portable
import { createCanvas, Image } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { compressAttachmentImage } from "../../src/main/attachment-image-compression";

function exifOrientation(orientation: number): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), length, payload]);
}

async function wideJpeg(orientation?: number): Promise<Buffer> {
  const canvas = createCanvas(8_200, 40);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, 4_100, 40);
  context.fillStyle = "#0000ff";
  context.fillRect(4_100, 0, 4_100, 40);
  const jpeg = await canvas.encode("jpeg", 95);
  return orientation === undefined
    ? jpeg
    : Buffer.concat([jpeg.subarray(0, 2), exifOrientation(orientation), jpeg.subarray(2)]);
}

async function colorsOf(bytes: Buffer) {
  const image = new Image();
  image.src = bytes;
  await image.decode();
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const color = (x: number, y: number): string => {
    const [red, green, blue] = context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    if (red! > 200 && green! < 60 && blue! < 60) return "red";
    if (blue! > 200 && red! < 60 && green! < 60) return "blue";
    return `rgb(${red}, ${green}, ${blue})`;
  };
  return { width: image.width, height: image.height, color };
}

describe("oversized image normalization", () => {
  it("keeps the pixels of an image it resizes", async () => {
    const image = await colorsOf((await compressAttachmentImage(await wideJpeg(), "image/jpeg"))!);
    expect(image.width).toBeLessThanOrEqual(8_192);
    expect(image.width).toBeGreaterThan(image.height);
    expect([image.color(image.width / 4, image.height / 2), image.color(image.width * 3 / 4, image.height / 2)])
      .toEqual(["red", "blue"]);
  });

  it.each([
    { orientation: 1, portrait: false, first: "red", second: "blue" },
    { orientation: 3, portrait: false, first: "blue", second: "red" },
    { orientation: 6, portrait: true, first: "red", second: "blue" },
    { orientation: 8, portrait: true, first: "blue", second: "red" },
  ])("keeps the displayed orientation for EXIF orientation $orientation", async ({ orientation, portrait, first, second }) => {
    const image = await colorsOf((await compressAttachmentImage(await wideJpeg(orientation), "image/jpeg"))!);
    expect(image.height > image.width).toBe(portrait);
    const colors = portrait
      ? [image.color(image.width / 2, image.height / 4), image.color(image.width / 2, image.height * 3 / 4)]
      : [image.color(image.width / 4, image.height / 2), image.color(image.width * 3 / 4, image.height / 2)];
    expect(colors).toEqual([first, second]);
  });
});
