import { readdirSync, readFileSync, statSync } from "node:fs";
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
const RENDERER_ONLY_PACKAGES = ["react", "react-dom", "scheduler", "highlight.js", "lucide-react"];
const RENDERER_BUNDLED_DEPENDENTS = ["@tanstack/react-virtual", "morphicons", "react-markdown"];

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
    for (const path of ["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs",
      "pdfjs-dist/standard_fonts/FoxitSans.pfb", "pdfjs-dist/cmaps/78-H.bcmap", "pdfjs-dist/wasm/openjpeg.wasm",
      "pdfjs-dist/package.json", "xlsx/xlsx.mjs", "xlsx/package.json", "electron-updater/out/main.js",
      "better-sqlite3/build/Release/better_sqlite3.node",
      `node-pty/prebuilds/${own}-arm64/pty.node`, `better-sqlite3/prebuilds/${own}-x64.node`,
      "@anthropic-ai/claude-agent-sdk/sdk.mjs", "@anthropic-ai/claude-agent-sdk/package.json"]) {
      expect(includes(path), path).toBe(true);
    }
    for (const path of ["pdfjs-dist/build/pdf.mjs.map", "xlsx/types/index.d.ts",
      "sample/types/index.d.mts", "sample/types/index.d.cts",
      "better-sqlite3/src/better_sqlite3.cpp", "better-sqlite3/deps/sqlite3/sqlite3.c",
      `@anthropic-ai/claude-agent-sdk-${own}-x64/claude`, `@anthropic-ai/claude-agent-sdk-${own}-arm64/package.json`,
      "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe", "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
      "pdfjs-dist/build/pdf.mjs", "pdfjs-dist/web/pdf_viewer.mjs", "pdfjs-dist/image_decoders/pdf.image_decoders.mjs",
      "pdfjs-dist/legacy/web/pdf_viewer.mjs", "pdfjs-dist/legacy/build/pdf.min.mjs",
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs", "pdfjs-dist/legacy/build/pdf.sandbox.mjs",
      "pdfjs-dist/legacy/build/pdf.renderer.mjs", "xlsx/dist/xlsx.full.min.js", "xlsx/xlsx.js", "xlsx/xlsxworker.js",
      "xlsx/bin/xlsx.njs", "react/package.json", "react-dom/package.json", "scheduler/package.json",
      "highlight.js/package.json", "lucide-react/package.json", "@xterm/xterm/package.json",
      "@xterm/addon-fit/package.json"]) {
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

  it("keeps renderer packages that are left out of the package away from runtime dependencies", () => {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
      packages: Record<string, { dev?: boolean } & Record<"dependencies" | "optionalDependencies" | "peerDependencies",
        Record<string, string> | undefined>>;
    };
    const excluded = (name: string) => RENDERER_ONLY_PACKAGES.includes(name) || name.startsWith("@xterm/");
    const dependents = new Set<string>();
    for (const [location, entry] of Object.entries(lock.packages)) {
      const name = location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
      if (location === "" || entry.dev || excluded(name)) continue;
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
        if (Object.keys(entry[field] ?? {}).some(excluded)) dependents.add(name);
      }
    }
    expect([...dependents].sort()).toEqual(RENDERER_BUNDLED_DEPENDENTS);
  });

  it("loads trimmed packages outside the renderer only through the files that are still packaged", () => {
    const runtimeSpecifiers: { file: string; specifier: string; required: boolean }[] = [];
    const sources = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => /\.(?:ts|tsx|mts|mjs|cjs|js)$/u.test(path) && !path.startsWith("renderer/"));
    for (const file of sources) {
      const text = readFileSync(join(root, "src", file), "utf8");
      for (const match of text.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s*)?"([^"]+)"/gu)) {
        if (!match[1]) runtimeSpecifiers.push({ file, specifier: match[2], required: false });
      }
      for (const match of text.matchAll(/\b(import|require|require\.resolve)\(\s*"([^"]+)"/gu)) {
        runtimeSpecifiers.push({ file, specifier: match[2], required: match[1] !== "import" });
      }
    }
    const packageName = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    const violations = runtimeSpecifiers.filter(({ specifier, required }) => {
      const name = packageName(specifier);
      if (RENDERER_ONLY_PACKAGES.includes(name) || name.startsWith("@xterm/")) return true;
      if (name === "xlsx") return specifier !== "xlsx" || required;
      if (name === "pdfjs-dist") {
        return !["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs"].includes(specifier);
      }
      return false;
    });
    expect(violations).toEqual([]);
    expect(runtimeSpecifiers.some(({ specifier }) => specifier === "xlsx")).toBe(true);
    expect(runtimeSpecifiers.some(({ specifier }) => specifier === "pdfjs-dist/legacy/build/pdf.mjs")).toBe(true);
  });

  it("keeps dynamically loaded runtime dependencies installed", () => {
    for (const name of ["pdfjs-dist", "xlsx", "@napi-rs/canvas", "electron-updater"]) {
      expect(manifest.dependencies[name], name).toBeDefined();
    }
    expect(manifest.dependencies["tailwind-merge"]).toBeUndefined();
    expect(manifest.dependencies["@napi-rs/keyring"]).toBeUndefined();
    expect(manifest.dependencies["smol-toml"]).toBeUndefined();
  });
});
