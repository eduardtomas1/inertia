import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const moduleUrl = pathToFileURL(
  join(repositoryRoot, "scripts", "windows-installer-smoke.mjs"),
).href;
const boundedRunnerUrl = pathToFileURL(
  join(repositoryRoot, "scripts", "bounded-process-tree.mjs"),
).href;

async function installerSmokeModule() {
  return await import(moduleUrl) as {
    applicationArchiveMethod: (listing: string) => string;
    nsisApplicationArchiveName: (
      sanitizedName: string,
      version: string,
      architecture: "arm64" | "x64",
    ) => string;
    requireInstallTimeDecodableMethod: (method: string) => void;
    runBounded: (
      command: string,
      args: string[],
      options: { label: string; timeoutMs: number },
    ) => Promise<string>;
    windowsInstallerAssetName: (
      version: string,
      releaseChannel: "canary" | "stable",
      architecture: "arm64" | "x64",
    ) => string;
  };
}

async function boundedRunnerModule() {
  return await import(boundedRunnerUrl) as {
    posixProcessGroupKillIsConfirmed: (
      error: null | { code?: string },
      groupStillExists: boolean,
    ) => boolean;
  };
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

test("selects the exact generated NSIS application archive", async () => {
  const { nsisApplicationArchiveName } = await installerSmokeModule();

  expect(nsisApplicationArchiveName("inertia", "0.0.44", "x64"))
    .toBe("inertia-0.0.44-x64.nsis.7z");
  expect(nsisApplicationArchiveName("inertia-canary", "0.0.44", "arm64"))
    .toBe("inertia-canary-0.0.44-arm64.nsis.7z");
  expect(() => nsisApplicationArchiveName("../inertia", "0.0.44", "x64"))
    .toThrow("name is invalid");
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

  const windowsStandaloneListing = [
    "Path = Inertia.Setup.0.0.44.exe",
    "Type = PE",
    "Physical Size = 243892224",
    "CPU = x64",
    "64-bit = +",
  ].join("\r\n");
  expect(() => applicationArchiveMethod(windowsStandaloneListing))
    .toThrow(/Listing header:.*Type = PE/u);
});

test("terminates the complete owned process tree on a gate timeout", async () => {
  const { runBounded } = await installerSmokeModule();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-installer-timeout-test-"));
  const pidFile = join(temporaryRoot, "descendant.pid");
  let rootPid = 0;
  let descendantPid = 0;
  try {
    const script = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "writeFileSync(process.argv[1], JSON.stringify({ root: process.pid, descendant: child.pid }));",
      "setInterval(() => {}, 1000);",
    ].join("");
    await expect(runBounded(process.execPath, ["-e", script, pidFile], {
      label: "Installer timeout fixture",
      timeoutMs: 500,
    })).rejects.toThrow("complete process tree was terminated");
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as {
      root: number;
      descendant: number;
    };
    rootPid = pids.root;
    descendantPid = pids.descendant;
    expect(Number.isSafeInteger(rootPid)).toBe(true);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(processExists(rootPid)).toBe(false);
    expect(processExists(descendantPid)).toBe(false);
  } finally {
    if (descendantPid > 0 && processExists(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Best-effort cleanup for a failing regression.
      }
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("accepts an ESRCH kill race only after exact group absence", async () => {
  const { posixProcessGroupKillIsConfirmed } = await boundedRunnerModule();
  expect(posixProcessGroupKillIsConfirmed(null, true)).toBe(true);
  expect(posixProcessGroupKillIsConfirmed({ code: "ESRCH" }, false)).toBe(true);
  expect(posixProcessGroupKillIsConfirmed({ code: "ESRCH" }, true)).toBe(false);
  expect(posixProcessGroupKillIsConfirmed({ code: "EPERM" }, false)).toBe(false);
});

test("rejects and terminates an owned grandchild left after the root exits", async () => {
  if (process.platform === "win32") return;
  const { runBounded } = await installerSmokeModule();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-installer-residual-test-"));
  const pidFile = join(temporaryRoot, "descendants.pid");
  let middlePid = 0;
  let grandchildPid = 0;
  try {
    const middleScript = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'process.send({ middle: process.pid, grandchild: child.pid });',
      "setInterval(() => {}, 1000);",
    ].join("");
    const rootScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      `const middle = spawn(process.execPath, ["-e", ${JSON.stringify(middleScript)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });`,
      "middle.once(\"message\", (value) => { writeFileSync(process.argv[1], JSON.stringify(value)); process.exit(0); });",
    ].join("");
    await expect(runBounded(process.execPath, ["-e", rootScript, pidFile], {
      label: "Residual descendant fixture",
      timeoutMs: 5_000,
    })).rejects.toThrow("left descendant processes running");
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as {
      middle: number;
      grandchild: number;
    };
    middlePid = pids.middle;
    grandchildPid = pids.grandchild;
    expect(processExists(middlePid)).toBe(false);
    expect(processExists(grandchildPid)).toBe(false);
  } finally {
    for (const pid of [middlePid, grandchildPid]) {
      if (pid <= 0 || !processExists(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Best-effort cleanup for a failing regression.
      }
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("keeps stderr diagnostics out of strict archive listing stdout", async () => {
  const { runBounded } = await installerSmokeModule();
  const listing = [
    "Path = app-arm64.7z",
    "Type = 7z",
    "Method = LZMA2:20 LZMA:20 BCJ",
    "----------",
    "Path = Inertia.exe",
    "",
  ].join("\n");
  const result = await runBounded(process.execPath, [
    "-e",
    `process.stdout.write(${JSON.stringify(listing)}); process.stderr.write("unrelated warning\\n");`,
  ], {
    label: "Separated output fixture",
    timeoutMs: 2_000,
  });

  expect(result).toBe(listing);
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
  const boundedRunnerSource = await readFile(
    join(repositoryRoot, "scripts", "bounded-process-tree.mjs"),
    "utf8",
  );
  const releaseConfig = await readFile(
    join(repositoryRoot, "scripts", "electron-builder.release.cjs"),
    "utf8",
  );

  expect(manifest.devDependencies["electron-builder"]).toBe("26.15.6");
  expect(lock.packages["node_modules/electron-builder"]?.version).toBe("26.15.6");
  expect(lock.packages["node_modules/app-builder-lib"]?.version).toBe("26.15.6");
  expect(manifest.scripts["test:windows-installer-smoke"])
    .toBe("node scripts/windows-installer-smoke.mjs");
  expect(source).toContain("NSIS application archive verified");
  expect(source).toContain("Generated NSIS application payload inspection");
  expect(source).not.toContain('["l", "-slt", installer]');
  expect(releaseConfig).toContain("artifactBuildCompleted: verifyWindowsNsisPayload");
  expect(releaseConfig).toContain("verifyBuiltNsisApplicationArchive");
  expect(source).toContain("Installed Windows native binaries verified");
  expect(source).toContain('"d3dcompiler_47.dll"');
  expect(source).toContain('["conpty.dll", "OpenConsole.exe"]');
  expect(source).toContain('join(resources, "elevate.exe")');
  expect(source).toContain("INERTIA_PACKAGE_SMOKE_EXECUTABLE: installedExecutable");
  expect(source).toContain('["/S", `/D=${installDirectory}`]');
  expect(source).toContain('runBounded(uninstaller, ["/S"]');
  expect(boundedRunnerSource).toContain('["/PID", String(child.pid), "/T", "/F"]');
  expect(boundedRunnerSource).toContain("its process tree could not be confirmed stopped");
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
