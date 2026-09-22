import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("ships a Windows icon directory with exact generated images for system and high-DPI sizes", () => {
  const root = resolve(import.meta.dirname, "../..");
  const ico = readFileSync(join(root, "resources/icon.ico"));
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  expect(ico.readUInt16LE(4)).toBe(sizes.length);
  let offset = 6 + sizes.length * 16;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    expect(ico[entry] || 256).toBe(size);
    expect(ico[entry + 1] || 256).toBe(size);
    expect(ico.readUInt16LE(entry + 4)).toBe(1);
    expect(ico.readUInt16LE(entry + 6)).toBe(32);
    expect(ico.readUInt32LE(entry + 12)).toBe(offset);
    const length = ico.readUInt32LE(entry + 8);
    expect(ico.subarray(offset, offset + length))
      .toEqual(readFileSync(join(root, `resources/icons/${size}x${size}.png`)));
    offset += length;
  }
  expect(offset).toBe(ico.length);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(manifest.build.win.icon).toBe("resources/icon.ico");
  expect(manifest.build.extraResources).toContainEqual({ from: "resources/icon.ico", to: "icons/inertia.ico" });
});
