import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ProcessTreeCleanupError, runBounded } from "../../../scripts/bounded-process-tree.mjs";

describe("Private Connect packaged assets", () => {
  it("ships the dimensions declared by the PWA manifest", async ({ signal, task }) => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "inertia-private-connect-assets-")));
    let preserveRoot = false;
    try {
      for (const path of [
        "src/renderer/private-connect", "src/shared", "package.json", "tsconfig.web.json",
        "resources/icons/192x192.png", "resources/icons/512x512.png",
      ]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
      }
      // Keep Vite's .vite-temp writes private; only dependency package reads
      // traverse junctions into the reviewed installation.
      for (const dependency of ["vite", "@vitejs/plugin-react", "react", "react-dom", "zod"]) {
        const target = join(root, "node_modules", dependency);
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(join(repositoryRoot, "node_modules", dependency), target, "junction");
      }
      await runBounded(process.execPath, [join(repositoryRoot, "scripts/build-private-connect.mjs")], {
        cwd: root,
        env: { ...process.env, NODE_ENV: "production" },
        label: "Isolated Private Connect production assets",
        signal,
        timeoutMs: task.timeout,
      });
      assertPackagedAssets(root);
    } catch (error) {
      preserveRoot = error instanceof ProcessTreeCleanupError;
      throw error;
    } finally {
      if (!preserveRoot) rmSync(root, { recursive: true, force: true });
    }
  });
});

function assertPackagedAssets(root: string): void {
  const manifest = JSON.parse(readFileSync(
    join(root, "src/renderer/private-connect/public/manifest.webmanifest"),
    "utf8",
  )) as {
    id: string;
    display: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  };
  const icon = readFileSync(join(root, "resources/icons/192x192.png"));

  expect(manifest.icons).toContainEqual({
    src: "/icons/inertia-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "any",
  });
  expect(manifest).toMatchObject({ id: "/", display: "standalone" });
  expect(icon.readUInt32BE(16)).toBe(192);
  expect(icon.readUInt32BE(20)).toBe(192);
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
}
