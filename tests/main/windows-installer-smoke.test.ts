import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const moduleUrl = pathToFileURL(
  join(repositoryRoot, "scripts", "windows-installer-smoke.mjs"),
).href;

async function installerSmokeModule() {
  return await import(moduleUrl) as {
    applicationArchiveMethod: (listing: string) => string;
    nsisApplicationArchivePath: (
      listing: string,
      architecture: "arm64" | "x64",
    ) => string;
    requireInstallTimeDecodableMethod: (method: string) => void;
    windowsInstallerAssetName: (
      version: string,
      releaseChannel: "canary" | "stable",
      architecture: "arm64" | "x64",
    ) => string;
  };
}

test("selects the exact stable and Canary Windows installer identities", async () => {
  const { windowsInstallerAssetName } = await installerSmokeModule();

  expect(windowsInstallerAssetName("0.0.44", "stable", "x64"))
    .toBe("Inertia.Setup.0.0.44.exe");
  expect(windowsInstallerAssetName("0.0.44", "stable", "arm64"))
    .toBe("Inertia.Setup.0.0.44.arm64.exe");
  expect(windowsInstallerAssetName("0.0.44", "canary", "x64"))
    .toBe("Inertia.Canary.Setup.0.0.44.exe");
  expect(windowsInstallerAssetName("0.0.44", "canary", "arm64"))
    .toBe("Inertia.Canary.Setup.0.0.44.arm64.exe");
  expect(() => windowsInstallerAssetName("v0.0.44", "stable", "x64"))
    .toThrow("version is invalid");
});

test("requires the architecture-qualified application archive inside NSIS", async () => {
  const { nsisApplicationArchivePath } = await installerSmokeModule();
  const arm64Listing = [
    "Path = release/Inertia.Setup.0.0.44.arm64.exe",
    "Type = Nsis",
    "Method = Deflate",
    "----------",
    "Path = $PLUGINSDIR\\app-arm64.7z",
    "Method = Copy",
  ].join("\n");

  expect(nsisApplicationArchivePath(arm64Listing.replaceAll("\n", "\r\n"), "arm64"))
    .toBe("$PLUGINSDIR\\app-arm64.7z");
  expect(() => nsisApplicationArchivePath(arm64Listing, "x64"))
    .toThrow("app-64.7z");
  expect(() => nsisApplicationArchivePath(
    arm64Listing.replace("Type = Nsis", "Type = PE"),
    "arm64",
  )).toThrow("not an NSIS installer");
});

test("rejects the exact archive methods that dropped Windows executables", async () => {
  const {
    applicationArchiveMethod,
    requireInstallTimeDecodableMethod,
  } = await installerSmokeModule();
  const fixedListing = [
    "Path = app-arm64.7z",
    "Type = 7z",
    "Method = LZMA2:20 LZMA:20 BCJ",
    "Solid = -",
    "----------",
    "Path = Inertia.exe",
  ].join("\n");
  const method = applicationArchiveMethod(fixedListing);

  expect(method).toBe("LZMA2:20 LZMA:20 BCJ");
  expect(() => requireInstallTimeDecodableMethod(method)).not.toThrow();
  expect(() => requireInstallTimeDecodableMethod("Copy")).not.toThrow();
  expect(() => requireInstallTimeDecodableMethod(
    "ARM64 LZMA2:20 LZMA:20 BCJ2",
  )).toThrow("install-time undecodable");
  expect(() => requireInstallTimeDecodableMethod(
    "LZMA2:24 BCJ2",
  )).toThrow("install-time undecodable");
  expect(() => requireInstallTimeDecodableMethod("LZMA2:24"))
    .toThrow("does not pin a decoder-compatible filter");
});

test("pins the minimal fixed builder and gates installed Windows binaries", async () => {
  const manifest = JSON.parse(await readFile(
    join(repositoryRoot, "package.json"),
    "utf8",
  )) as {
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  const lock = JSON.parse(await readFile(
    join(repositoryRoot, "package-lock.json"),
    "utf8",
  )) as {
    packages: Record<string, { version?: string }>;
  };
  const source = await readFile(
    join(repositoryRoot, "scripts", "windows-installer-smoke.mjs"),
    "utf8",
  );

  expect(manifest.devDependencies["electron-builder"]).toBe("26.15.6");
  expect(lock.packages["node_modules/electron-builder"]?.version).toBe("26.15.6");
  expect(lock.packages["node_modules/app-builder-lib"]?.version).toBe("26.15.6");
  expect(manifest.scripts["test:windows-installer-smoke"])
    .toBe("node scripts/windows-installer-smoke.mjs");
  expect(source).toContain("NSIS application archive verified");
  expect(source).toContain("Installed Windows native binaries verified");
  expect(source).toContain('"d3dcompiler_47.dll"');
  expect(source).toContain('["conpty.dll", "OpenConsole.exe"]');
  expect(source).toContain('join(resources, "elevate.exe")');
  expect(source).toContain("INERTIA_PACKAGE_SMOKE_EXECUTABLE: installedExecutable");
  expect(source).toContain('["/S", `/D=${installDirectory}`]');
  expect(source).toContain('runBounded(uninstaller, ["/S"]');
  expect(source).toContain("return waitForRemoval(installDirectory)");
  expect(source).toContain("completed without a reboot");
});

test("runs the real installer gate on Windows x64 and ARM64 CI and releases", async () => {
  const ci = await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const release = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-platforms.yml"),
    "utf8",
  );

  expect(ci).toContain("release_platform: windows-x64");
  expect(ci).toContain("release_platform: windows-arm64");
  expect(ci).toContain("release_dist_script: dist:release:win");
  expect(ci).toContain("release_dist_script: dist:release:win:arm64");
  expect(ci).toContain("Build native Windows installer and unpacked app");
  expect(ci).toContain("Install, smoke, and uninstall Windows package");
  expect(ci).toContain("run: npm run test:windows-installer-smoke");
  expect(release).toContain("Install, smoke, and uninstall Windows package");
  expect(release).toContain("run: npm run test:windows-installer-smoke");
});
