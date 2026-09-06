import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import { createPackage } from "@electron/asar";
import { expect, test } from "@playwright/test";
import { transformWithEsbuild } from "vite";

const roots: string[] = [];
const require = createRequire(import.meta.url);

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

test.describe("singleton metadata in Electron ASAR files", () => {
  test.skip(process.platform !== "linux", "Linux singleton ownership uses the Linux Electron filesystem.");

  test("bounds raw headers and packed entries before Electron allocation, and rejects archive replacement", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-singleton-metadata-")));
    roots.push(root);
    const small = '{"name":"inertia","version":"0.0.47"}';
    for (const [name, content] of [["small", small], ["oversized", " ".repeat(65_537)]]) {
      const source = join(root, `${name}-source`);
      await mkdir(source);
      await writeFile(join(source, "package.json"), content!);
      await finished(await createPackage(source, join(root, `${name}.asar`)));
    }
    const invalidPrefix = Buffer.alloc(16);
    invalidPrefix.writeUInt32LE(4, 0);
    invalidPrefix.writeUInt32LE(1_073_741_824, 4);
    invalidPrefix.writeUInt32LE(1_073_741_820, 8);
    invalidPrefix.writeUInt32LE(1_073_741_816, 12);
    await writeFile(join(root, "invalid-header.asar"), invalidPrefix);
    const production = new URL("../../src/main/linux-singleton-metadata.ts", import.meta.url);
    const transpiled = await transformWithEsbuild(await readFile(production, "utf8"), production.pathname, {
      loader: "ts", format: "cjs", target: "node22",
    });
    await writeFile(join(root, "reader.cjs"), transpiled.code);
    await writeFile(join(root, "check.cjs"), `
const { app } = require("electron");
const fs = require("node:fs");
const originalFs = require("original-fs");
const assert = require("node:assert/strict");
const path = require("node:path");
const target = (archive) => path.join(__dirname, archive);
const originalRead = originalFs.readSync;
for (const method of ["openSync", "lstatSync", "readFileSync"]) {
  const original = fs[method];
  fs[method] = function (file, ...args) {
    if (typeof file === "string" && file.includes(".asar")) {
      throw new Error("Virtual ASAR APIs must not allocate or extract owner metadata");
    }
    return original.call(this, file, ...args);
  };
}
try {
  const { readLinuxSingletonManifest: read } = require("./reader.cjs");
  assert.throws(() => read(target("invalid-header.asar"), 65_536), /bounded singleton archive header/);
  assert.throws(() => read(target("oversized.asar"), 65_536), /bounded packed singleton manifest/);
  const expected = ${JSON.stringify(small)};
  assert.equal(read(target("small.asar"), 65_536), expected);
  originalFs.copyFileSync(path.join(__dirname, "small.asar"), path.join(__dirname, "swap.asar"));
  let swapped = false;
  originalFs.readSync = function (...args) {
    const result = originalRead.apply(this, args);
    if (!swapped) {
      swapped = true;
      originalFs.renameSync(target("oversized.asar"), target("swap.asar"));
    }
    return result;
  };
  assert.throws(() => read(target("swap.asar"), 65_536), /archive changed during inspection/);
  console.log("SINGLETON_ASAR_BOUNDS_OK");
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
`);
    const electronPath = require("electron") as string;
    const result = spawnSync(electronPath, [
      "--no-sandbox", "--disable-crash-reporter", `--user-data-dir=${join(root, "profile")}`,
      join(root, "check.cjs"),
    ], {
      shell: false, timeout: 10_000, maxBuffer: 65_536, encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined,
        DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SINGLETON_ASAR_BOUNDS_OK");
  });
});
