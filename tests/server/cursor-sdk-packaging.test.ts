import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCursorSdkDistributionLocation } from "../../src/server/provider/cursor-sdk-installation";

type Manifest = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  build: { asarUnpack: string[]; files: string[]; electronFuses: { runAsNode: boolean } };
};

type Lockfile = { packages: Record<string, { dev?: boolean; optional?: boolean }> };

const sdkOnlyScopes = ["@cursor", "@bufbuild", "@connectrpc", "@statsig"];

describe("Cursor SDK packaging boundary", () => {
  it("keeps the exact SDK a development dependency that packaged builds never contain", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as Manifest;
    expect(manifest.devDependencies["@cursor/sdk"]).toBe("1.0.38");
    expect(Object.keys(manifest.dependencies).filter((name) => sdkOnlyScopes.some((scope) => name.startsWith(`${scope}/`)))).toEqual([]);
    expect(manifest.build.electronFuses.runAsNode).toBe(false);
    for (const pattern of manifest.build.asarUnpack) {
      expect(pattern).not.toMatch(/node_modules\/(?:@cursor|@bufbuild|@connectrpc|@statsig|zod)\//u);
      expect(pattern).not.toMatch(/^out\//u);
    }
    expect(manifest.build.files.some((pattern) => pattern.includes("@cursor"))).toBe(false);
  });

  it("marks every SDK package and SDK-only transitive dependency as development-only in the lockfile", () => {
    const lockfile = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8")) as Lockfile;
    const sdkPackages = Object.entries(lockfile.packages)
      .filter(([path]) => sdkOnlyScopes.some((scope) => path.startsWith(`node_modules/${scope}/`)));
    expect(sdkPackages.map(([path]) => path)).toEqual(expect.arrayContaining([
      "node_modules/@cursor/sdk", "node_modules/@cursor/sdk-linux-x64", "node_modules/@cursor/sdk-win32-x64",
    ]));
    for (const [path, entry] of sdkPackages) expect({ path, dev: entry.dev }).toEqual({ path, dev: true });
    expect(lockfile.packages["node_modules/zod"]?.dev).toBeUndefined();
  });

  it("keeps every SDK package external to the main and worker bundles", () => {
    const lockfile = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8")) as Lockfile;
    const config = readFileSync(resolve("electron.vite.config.ts"), "utf8");
    const cursorPackages = Object.keys(lockfile.packages)
      .filter((path) => path.startsWith("node_modules/@cursor/"))
      .map((path) => path.slice("node_modules/".length));
    expect(cursorPackages.length).toBeGreaterThanOrEqual(6);
    for (const name of cursorPackages) expect(config).toContain(`"${name}",`);
  });

  it("resolves the development SDK from the checkout", () => {
    const entry = createRequire(import.meta.url).resolve("@cursor/sdk");
    expect(relative(resolve("node_modules", "@cursor", "sdk"), entry).split(sep)[0]).not.toBe("..");
    expect(readdirSync(resolve("node_modules/@cursor/sdk/dist/cjs")).some((name) => /^\d+\.js$/u.test(name))).toBe(true);
  });

  it("blocks packaged availability while exact platform notices are unresolved", () => {
    expect(() => assertCursorSdkDistributionLocation("file:///app/resources/app.asar/out/main/runtime-worker.js")).toThrow("third-party notices");
    expect(() => assertCursorSdkDistributionLocation("file:///app/resources/app.asar.unpacked/out/main/chunks/runtime.js")).toThrow("third-party notices");
    expect(() => assertCursorSdkDistributionLocation("file:///development/out/main/runtime-worker.js")).not.toThrow();
  });
});
