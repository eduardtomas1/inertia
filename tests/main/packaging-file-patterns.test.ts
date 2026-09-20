import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  build: {
    files: string[];
    mac: { files: string[] };
    win: { files: string[] };
    linux: { files: string[] };
  };
};

const PLATFORMS = [
  { key: "mac", own: "darwin", foreign: ["win32", "linux", "linuxmusl"] },
  { key: "win", own: "win32", foreign: ["darwin", "linux", "linuxmusl"] },
  { key: "linux", own: "linux", foreign: ["win32", "darwin", "linuxmusl"] },
] as const;

describe("packaging file patterns", () => {
  it("excludes files the application never executes", () => {
    expect(manifest.build.files).toEqual([
      "out/**/*",
      "resources/generated/windows-runtime-job-integrity.json",
      "package.json",
      "!node_modules/**/*.map",
      "!node_modules/**/*.d.ts",
      "!node_modules/**/*.d.mts",
      "!node_modules/**/*.d.cts",
      "!node_modules/better-sqlite3/src/**",
      "!node_modules/better-sqlite3/deps/**",
    ]);
  });

  // electron-builder replaces the shared list with a platform list instead of
  // merging them, so each platform repeats the shared patterns. Without them a
  // platform falls back to packaging the whole repository.
  it.each(PLATFORMS)("keeps the shared patterns in the $key list", ({ key }) => {
    const shared = manifest.build.files;
    expect(manifest.build[key].files.slice(0, shared.length)).toEqual(shared);
  });

  it.each(PLATFORMS)("removes only other systems' prebuilds for $key", ({ key, own, foreign }) => {
    const additions = manifest.build[key].files.slice(manifest.build.files.length);
    expect(additions.length).toBeGreaterThan(0);
    for (const pattern of additions) {
      expect(pattern.startsWith("!"), "platform additions only remove files").toBe(true);
      expect(pattern).not.toContain(`prebuilds/${own}-`);
    }
    for (const system of foreign) {
      expect(
        additions.filter((pattern) => pattern.includes(`prebuilds/${system}-`)),
        `${key} must exclude ${system} prebuilds as files and directories`,
      ).toEqual([
        `!node_modules/**/prebuilds/${system}-*/**`,
        `!node_modules/**/prebuilds/${system}-*.node`,
      ]);
    }
  });

  it("keeps every runtime dependency installed", () => {
    // Removing an unused dependency is safe; removing a loaded one is not.
    // These are reached through a dynamic import, so no static import shows them.
    for (const name of ["pdfjs-dist", "xlsx", "@napi-rs/canvas", "electron-updater"]) {
      expect(manifest.dependencies[name], `${name} loads at runtime`).toBeDefined();
    }
    expect(manifest.dependencies["tailwind-merge"], "nothing imports tailwind-merge")
      .toBeUndefined();
  });
});
