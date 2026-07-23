import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(buffer.toString("ascii", 12, 16)).toBe("IHDR");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe("Linux application icon packaging", () => {
  it("keeps a vector master and generated standard hicolor sizes", async () => {
    const source = await readFile(join(root, "resources", "icon.svg"), "utf8");
    expect(source).toContain('viewBox="0 0 1024 1024"');
    expect(source).toContain("The Inertia running figure and pointer mark.");
    for (const size of sizes) {
      const image = await readFile(join(root, "resources", "icons", `${size}x${size}.png`));
      expect(pngDimensions(image)).toEqual({ width: size, height: size });
    }
  });

  it("generates the cross-platform and Linux master from the same deterministic mark", async () => {
    const digest = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");
    const crossPlatform = await readFile(join(root, "resources", "icon.png"));
    const linux = await readFile(join(root, "resources", "icons", "1024x1024.png"));
    expect(digest(crossPlatform)).toBe(digest(linux));
  });

  it("configures an icon directory, runtime resource, and complete desktop identity", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      build: {
        extraResources: Array<{ from: string; to: string }>;
        linux: {
          icon: string;
          executableName: string;
          desktop: { entry: Record<string, string> };
        };
      };
    };
    expect(packageJson.build.linux.icon).toBe("resources/icons");
    expect(packageJson.build.linux.executableName).toBe("inertia");
    expect(packageJson.build.linux.desktop.entry).toMatchObject({
      Name: "Inertia",
      StartupWMClass: "Inertia",
    });
    expect(packageJson.build.extraResources).toContainEqual({
      from: "resources/icons/512x512.png",
      to: "icons/inertia.png",
    });
  });
});
