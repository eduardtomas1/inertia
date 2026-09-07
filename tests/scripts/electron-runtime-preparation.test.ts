import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessTreeCleanupError, runBounded } from "../../scripts/bounded-process-tree.mjs";
import { prepareElectronRuntime, type ElectronRuntimePreparationInvocation } from "../../scripts/electron-runtime-preparation.mjs";

const roots: string[] = [];
const version = "99.1.2";
const executablePaths = {
  linux: "electron", darwin: "Electron.app/Contents/MacOS/Electron", win32: "electron.exe",
} as const;

function fixture(platform: keyof typeof executablePaths = "linux") {
  const root = mkdtempSync(join(tmpdir(), "inertia-electron-preparation-"));
  roots.push(root);
  const packageDirectory = join(root, "node_modules", "electron");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "electron", version }));
  writeFileSync(join(packageDirectory, "checksums.json"), JSON.stringify({
    [`electron-v${version}-${platform}-x64.zip`]: "a".repeat(64),
  }));
  const installer = join(packageDirectory, "install.js");
  writeFileSync(installer, "// Synthetic installer; no downloads.\n");
  const dist = join(packageDirectory, "dist");
  const executable = executablePaths[platform];
  const populate = () => {
    mkdirSync(dirname(join(dist, executable)), { recursive: true });
    writeFileSync(join(packageDirectory, "path.txt"), executable);
    for (const [file, contents] of Object.entries({
      version: `v${version}`, LICENSE: "Electron license", "LICENSES.chromium.html": "Chromium licenses",
      [executable]: "Synthetic executable",
    })) writeFileSync(join(dist, file), contents);
  };
  return { root, packageDirectory, installer, dist, executable, populate, platform };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Electron runtime preparation before packaging", () => {
  it.each(["linux", "darwin", "win32"] as const)("prepares a fresh %s distribution with the exact official invocation", async (platform) => {
    const subject = fixture(platform);
    const environment = {
      PATH: "synthetic-path", ELECTRON_MIRROR: "https://mirror.invalid/",
      electron_config_cache: "synthetic-cache", ELECTRON_GET_USE_PROXY: "1",
      HTTPS_PROXY: "http://proxy.invalid/", Electron_Install_Arch: "arm64",
      NPM_CONFIG_ARCH: "arm64", npm_config_platform: "wrong-platform",
    };
    const run = vi.fn(async () => subject.populate());
    await prepareElectronRuntime({ root: subject.root, run, environment, platform, arch: "x64" });
    expect(run).toHaveBeenCalledExactlyOnceWith({
      command: process.execPath, args: [subject.installer],
      label: "Electron runtime preparation", timeoutMs: 600_000,
      env: {
        PATH: environment.PATH, ELECTRON_MIRROR: environment.ELECTRON_MIRROR,
        electron_config_cache: environment.electron_config_cache,
        ELECTRON_GET_USE_PROXY: "1", HTTPS_PROXY: environment.HTTPS_PROXY,
        ELECTRON_INSTALL_PLATFORM: platform, ELECTRON_INSTALL_ARCH: "x64",
        npm_config_platform: platform, npm_config_arch: "x64",
      },
    });
    expect(environment.NPM_CONFIG_ARCH).toBe("arm64");
  });

  it("accepts an already-installed exact runtime without repairing it", async () => {
    const subject = fixture();
    subject.populate();
    const run = vi.fn(async () => undefined);
    await prepareElectronRuntime({ root: subject.root, run, environment: {}, platform: "linux", arch: "x64" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing license", "LICENSE", null],
    ["empty Chromium notices", "LICENSES.chromium.html", ""],
    ["mismatched version", "version", "v98.0.0"],
    ["empty executable", "electron", ""],
  ])("rejects a warm runtime with %s after the installer returns successfully", async (_label, file, contents) => {
    const subject = fixture();
    subject.populate();
    const target = join(subject.dist, file!);
    if (contents === null) rmSync(target);
    else writeFileSync(target, contents!);
    const run = vi.fn(async () => undefined);
    await expect(prepareElectronRuntime({ root: subject.root, run, environment: {}, platform: "linux", arch: "x64" }))
      .rejects.toThrow(/Electron runtime/iu);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects an executable receipt that points outside the installed distribution", async () => {
    const subject = fixture();
    subject.populate();
    writeFileSync(join(subject.packageDirectory, "path.txt"), "../outside");
    await expect(prepareElectronRuntime({ root: subject.root, run: async () => undefined, environment: {}, platform: "linux", arch: "x64" }))
      .rejects.toThrow("version or executable path");
  });

  it.each([
    "ELECTRON_OVERRIDE_DIST_PATH", "electron_override_dist_path",
    "electron_use_remote_checksums", "npm_config_electron_use_remote_checksums",
    "NPM_CONFIG_ELECTRON_USE_REMOTE_CHECKSUMS", "ELECTRON_CUSTOM_VERSION",
    "npm_config_electron_customversion", "npm_config_electron_custom_version",
    "NPM_CONFIG_ELECTRON_CUSTOM_VERSION", "npm_package_config_electron_customVersion",
    "npm_package_config_electron_custom_version",
  ])("rejects %s before invoking the installer", async (key) => {
    const subject = fixture();
    const run = vi.fn(async () => undefined);
    await expect(prepareElectronRuntime({ root: subject.root, run, environment: { [key]: "0" }, platform: "linux", arch: "x64" }))
      .rejects.toThrow(`rejects ${key}`);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["package.json", "checksums.json"])("rejects invalid %s before invoking the installer", async (file) => {
    const subject = fixture();
    writeFileSync(join(subject.packageDirectory, file), "{}");
    const run = vi.fn(async () => undefined);
    await expect(prepareElectronRuntime({ root: subject.root, run, environment: {}, platform: "linux", arch: "x64" })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  for (const file of ["dist", "path.txt"]) {
    // Directory junctions are unprivileged on Windows; file symlinks are not.
    it.skipIf(file === "path.txt" && process.platform === "win32")(`rejects an existing ${file} symlink before installer side effects`, async () => {
      const subject = fixture();
      const outside = join(subject.root, "outside");
      if (file === "dist") mkdirSync(outside);
      else writeFileSync(outside, "untouched");
      symlinkSync(outside, join(subject.packageDirectory, file), file === "dist" ? "junction" : "file");
      const run = vi.fn(async () => undefined);
      await expect(prepareElectronRuntime({ root: subject.root, run, environment: {}, platform: "linux", arch: "x64" })).rejects.toThrow("regular");
      expect(run).not.toHaveBeenCalled();
      if (file === "path.txt") expect(readFileSync(outside, "utf8")).toBe("untouched");
    });
  }

  it.each([
    new Error("Installer failure"), new DOMException("Cancelled", "AbortError"),
    new ProcessTreeCleanupError("Unconfirmed installer tree"),
  ])("preserves the exact callback failure without retrying: %s", async (failure) => {
    const subject = fixture();
    const run = vi.fn(async () => { throw failure; });
    await expect(prepareElectronRuntime({ root: subject.root, run, environment: {}, platform: "linux", arch: "x64" })).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("executes a private synthetic installer through the real bounded process runner", async () => {
    const platform = process.platform as keyof typeof executablePaths;
    const subject = fixture(platform);
    writeFileSync(subject.installer, [
      'const {mkdirSync,writeFileSync}=require("node:fs");',
      'const {join,dirname}=require("node:path");',
      `const executable=${JSON.stringify(subject.executable)};`,
      'const dist=join(__dirname,"dist");mkdirSync(dirname(join(dist,executable)),{recursive:true});',
      'writeFileSync(join(__dirname,"path.txt"),executable);',
      `writeFileSync(join(dist,"version"),${JSON.stringify(version)});`,
      'for(const file of [executable,"LICENSE","LICENSES.chromium.html"])writeFileSync(join(dist,file),"fixture");',
      'writeFileSync(join(__dirname,"receipt.json"),JSON.stringify({platform:process.env.ELECTRON_INSTALL_PLATFORM,arch:process.env.ELECTRON_INSTALL_ARCH}));',
    ].join("\n"));
    const run = vi.fn(async (invocation: ElectronRuntimePreparationInvocation) => await runBounded(invocation.command, invocation.args, {
      cwd: subject.root, env: invocation.env, label: invocation.label, timeoutMs: invocation.timeoutMs,
    }));
    await prepareElectronRuntime({ root: subject.root, run, environment: {}, platform, arch: "x64" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(subject.packageDirectory, "receipt.json"), "utf8"))).toEqual({ platform, arch: "x64" });
  });
});
