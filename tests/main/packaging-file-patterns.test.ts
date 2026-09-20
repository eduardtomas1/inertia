import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { FileMatcher, getFileMatchers } from "app-builder-lib/out/fileMatcher.js";
import { doMergeConfigs } from "app-builder-lib/out/util/config/config.js";
import type { Configuration } from "app-builder-lib";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  build: Configuration;
};
const fileMetadata = statSync(join(root, "package.json"));
const PLATFORMS = [
  { key: "mac", own: "darwin", foreign: ["win32", "linux", "linuxmusl"] },
  { key: "win", own: "win32", foreign: ["darwin", "linux", "linuxmusl"] },
  { key: "linux", own: "linux", foreign: ["win32", "darwin", "linuxmusl"] },
] as const;

function matchers(key: typeof PLATFORMS[number]["key"], name: "files" | "extraResources") {
  const config = doMergeConfigs([structuredClone(manifest.build)]);
  return getFileMatchers(config, name, join(root, "release", "resources"), {
    macroExpander: (pattern) => pattern,
    customBuildOptions: config[key]!,
    globalOutDir: join(root, "release"),
    defaultSrc: root,
  })!;
}

describe("packaging file selection with the pinned builder", () => {
  it.each(PLATFORMS)("includes the bundle without shipping the repository on $key", ({ key }) => {
    const selections = matchers(key, "files");
    // A negative-only leading matcher makes getMainFileMatchers insert **/*,
    // which would ship source, tests and docs even with another scoped matcher.
    expect(selections[0].containsOnlyIgnore()).toBe(false);
    const filters = selections.map((matcher) => matcher.createFilter());
    const filter = (path: string) => filters.some((select) => select(path, fileMetadata));
    for (const path of ["out/main/index.js", "out/renderer/index.html", "package.json",
      "resources/generated/windows-runtime-job-integrity.json"]) {
      expect(filter(join(root, path)), path).toBe(true);
    }
    for (const path of ["src/main/index.ts", "tests/e2e/app-shell.spec.ts", "docs/user-guide.md"]) {
      expect(filter(join(root, path)), path).toBe(false);
    }
  });

  it.each(PLATFORMS)("retains runtime files and removes foreign prebuilds on $key", ({ key, own, foreign }) => {
    // The builder collects production dependencies separately, applying only
    // the combined exclusion patterns after a leading include-all pattern.
    const excludes = matchers(key, "files")[0].patterns.filter((pattern) => pattern.startsWith("!"));
    const filter = new FileMatcher(root, root, (pattern) => pattern, ["**/*", ...excludes]).createFilter();
    const includes = (path: string) => filter(join(root, "node_modules", path), fileMetadata);
    for (const path of ["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/standard_fonts/FoxitSans.pfb",
      "xlsx/xlsx.mjs", "electron-updater/out/main.js", "better-sqlite3/build/Release/better_sqlite3.node",
      `node-pty/prebuilds/${own}-arm64/pty.node`, `better-sqlite3/prebuilds/${own}-x64.node`]) {
      expect(includes(path), path).toBe(true);
    }
    for (const path of ["pdfjs-dist/build/pdf.mjs.map", "xlsx/types/index.d.ts",
      "sample/types/index.d.mts", "sample/types/index.d.cts",
      "better-sqlite3/src/better_sqlite3.cpp", "better-sqlite3/deps/sqlite3/sqlite3.c"]) {
      expect(includes(path), path).toBe(false);
    }
    for (const system of foreign) {
      for (const path of [`node-pty/prebuilds/${system}-arm64/pty.node`, `better-sqlite3/prebuilds/${system}-x64.node`]) {
        expect(includes(path), path).toBe(false);
      }
    }
  });

  it.each(PLATFORMS)("copies each shared resource once on $key", ({ key }) => {
    const resources = matchers(key, "extraResources");
    const destinations = resources.map(({ to }) => to);
    expect(new Set(destinations).size).toBe(destinations.length);
    for (const file of ["icons/inertia.png", "THIRD_PARTY_NOTICES.txt", "LICENSE.txt", "electron/LICENSE.txt", "runtime"]) {
      expect(destinations).toContain(join(root, "release", "resources", file));
    }
    expect(destinations.includes(join(root, "release", "resources", "electron/LICENSES.chromium.html")))
      .toBe(key === "mac");
  });

  it("keeps dynamically loaded runtime dependencies installed", () => {
    for (const name of ["pdfjs-dist", "xlsx", "@napi-rs/canvas", "electron-updater"]) {
      expect(manifest.dependencies[name], name).toBeDefined();
    }
    expect(manifest.dependencies["tailwind-merge"]).toBeUndefined();
  });
});
