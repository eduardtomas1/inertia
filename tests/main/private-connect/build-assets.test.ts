import { readFileSync, readdirSync } from "node:fs";
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
    )) as {
      id: string;
      display: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
    };
    const icon = readFileSync(new URL("../../../resources/icons/192x192.png", import.meta.url));

    expect(manifest.icons).toContainEqual({
      src: "/icons/inertia-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    });
    expect(manifest).toMatchObject({ id: "/", display: "standalone" });
    expect(icon.readUInt32BE(16)).toBe(192);
    expect(icon.readUInt32BE(20)).toBe(192);
    execFileSync(process.execPath, [join(root, "scripts/build-private-connect.mjs")], {
      cwd: root,
      stdio: "pipe",
    });
    const packaged = readFileSync(join(root, "out/private-connect/icons/inertia-192.png"));
    expect(packaged.readUInt32BE(16)).toBe(192);
    expect(packaged.readUInt32BE(20)).toBe(192);

    const worker = readFileSync(
      join(root, "out/private-connect/service-worker.js"),
      "utf8",
    );
    const bundles = readdirSync(join(root, "out/private-connect/assets"));
    const shellSource = worker.match(
      /const APP_SHELL = Object\.freeze\((\[[^\n]+\])\);/u,
    )?.[1];
    const shell = JSON.parse(shellSource ?? "null") as unknown;
    expect(shell).toEqual(expect.arrayContaining(["/", "/manifest.webmanifest"]));
    expect(Array.isArray(shell) && shell.every((path) =>
      typeof path === "string" && !path.startsWith("/api/"))).toBe(true);
    expect(worker).toContain("url.pathname.startsWith(\"/api/\")");
    expect(worker).toContain("request.mode === \"navigate\"");
    expect(worker).not.toContain("cache.put(");
    expect(worker).not.toContain("notification.body");
    for (const bundle of bundles) {
      expect(worker).toContain(JSON.stringify(`/assets/${bundle}`));
    }
  });
});
