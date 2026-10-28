import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function opaquePixels(path: string): { light: number; dark: number } {
  const png = readFileSync(join(root, path));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  let light = 0;
  let dark = 0;
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    for (let x = 0; x < width; x += 1) {
      const pixel = y * (width * 4 + 1) + 1 + x * 4;
      if (raw[pixel + 3]! < 200) continue;
      const luminance = (raw[pixel]! + raw[pixel + 1]! + raw[pixel + 2]!) / 3;
      if (luminance > 230) light += 1;
      else if (luminance < 40) dark += 1;
    }
  }
  return { light, dark };
}

describe("app icon contrast", () => {
  it.each(["resources/icons/16x16.png", "resources/icons/32x32.png", "resources/icons/256x256.png", "resources/icon.png"])(
    "keeps the white figure readable on light surfaces with a graphite edge in %s",
    (path) => {
      const { light, dark } = opaquePixels(path);
      expect(light).toBeGreaterThan(0);
      expect(dark).toBeGreaterThan(0);
    },
  );
});
