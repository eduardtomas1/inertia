import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("Private Connect packaged assets", () => {
  it("ships the dimensions declared by the PWA manifest", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const manifest = JSON.parse(readFileSync(
      new URL("../../../src/renderer/private-connect/public/manifest.webmanifest", import.meta.url),
      "utf8",
    )) as { icons: Array<{ src: string; sizes: string }> };
    const icon = readFileSync(new URL("../../../resources/icons/192x192.png", import.meta.url));

    expect(manifest.icons).toContainEqual({
      src: "/icons/inertia-192.png",
      sizes: "192x192",
      type: "image/png",
    });
    expect(icon.readUInt32BE(16)).toBe(192);
    expect(icon.readUInt32BE(20)).toBe(192);
    execFileSync(process.execPath, [join(root, "scripts/build-private-connect.mjs")], {
      cwd: root,
      stdio: "pipe",
    });
    const packaged = readFileSync(join(root, "out/private-connect/icons/inertia-192.png"));
    expect(packaged.readUInt32BE(16)).toBe(192);
    expect(packaged.readUInt32BE(20)).toBe(192);
  });
});
