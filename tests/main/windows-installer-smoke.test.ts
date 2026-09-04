import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import { executableProcessExists } from "../helpers/executable-process";

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
    installedWindowsNativeBinaryPaths: (
      installDirectory: string,
      applicationName: string,
      architecture: "arm64" | "x64",
    ) => string[];
    installedWindowsApplicationName: (
      releaseChannel: "canary" | "stable",
    ) => string;
    nsisApplicationArchiveName: (
      sanitizedName: string,
      version: string,
      architecture: "arm64" | "x64",
    ) => string;
    requireInstallTimeDecodableMethod: (method: string) => void;
    requireExactNodePtyNativeInventory: (
      packageDirectory: string,
      architecture: "arm64" | "x64",
    ) => Promise<void>;
    requireInstalledFiles: (
      installDirectory: string,
      unpackedDirectory: string,
      applicationName: string,
      uninstallerName: string,
      architecture: "arm64" | "x64",
    ) => Promise<void>;
    readWindowsNMinusOneMetadata: (options: {
      repositoryRoot: string;
      configuredPath?: string;
      currentVersion: string;
      releaseChannel: "canary" | "stable";
      architecture: "arm64" | "x64";
    }) => Promise<{
      installerPath: string;
      version: string;
      sha256: string;
    } | null>;
    runBounded: (
      command: string,
      args: string[],
      options: {
        label: string;
        posixProcessGroupHandoff?: { ownerToken: string; path: string };
        timeoutMs: number;
      },
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

function peBinary(architecture: "arm64" | "x64", salt = 0) {
  const header = Buffer.alloc(512);
  header[0] = 0x4d;
  header[1] = 0x5a;
  const peOffset = 0x80;
  header.writeUInt32LE(peOffset, 0x3c);
  header.write("PE\0\0", peOffset, "binary");
  header.writeUInt16LE(architecture === "arm64" ? 0xaa64 : 0x8664, peOffset + 4);
  header[header.length - 1] = salt;
  return header;
}

async function writeFixture(path: string, contents: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

test("selects the exact stable and Canary Windows installer identities", async () => {
  const {
    installedWindowsApplicationName,
    windowsInstallerAssetName,
  } = await installerSmokeModule();

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
  expect(installedWindowsApplicationName("stable")).toBe("Inertia.exe");
  expect(installedWindowsApplicationName("canary")).toBe("Inertia Canary.exe");
});

test("binds a released N-1 installer to exact checksummed transition metadata", async () => {
  const { readWindowsNMinusOneMetadata } = await installerSmokeModule();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-n-minus-one-"));
  try {
    const directory = join(temporaryRoot, "release", "n-minus-one");
    const assetName = "Inertia.Setup.0.0.47.exe";
    const installerPath = join(directory, assetName);
    const installer = Buffer.from("released N-1 installer", "utf8");
    const sha256 = createHash("sha256").update(installer).digest("hex");
    await writeFixture(installerPath, installer);
    const metadataPath = join(directory, "metadata.json");
    const metadata = {
      schemaVersion: 1,
      repository: "eduardtomas1/inertia",
      tag: "v0.0.47",
      version: "0.0.47",
      currentVersion: "0.0.48",
      channel: "stable",
      architecture: "x64",
      assetName,
      byteLength: installer.byteLength,
      sha256,
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);

    await expect(readWindowsNMinusOneMetadata({
      repositoryRoot: temporaryRoot,
      configuredPath: join("release", "n-minus-one", "metadata.json"),
      currentVersion: "0.0.48",
      releaseChannel: "stable",
      architecture: "x64",
    })).resolves.toEqual({ installerPath, version: "0.0.47", sha256 });

    await writeFile(metadataPath, `${JSON.stringify({
      ...metadata,
      currentVersion: "0.0.49",
    })}\n`);
    await expect(readWindowsNMinusOneMetadata({
      repositoryRoot: temporaryRoot,
      configuredPath: join("release", "n-minus-one", "metadata.json"),
      currentVersion: "0.0.48",
      releaseChannel: "stable",
      architecture: "x64",
    })).rejects.toThrow("does not match this candidate");

    await writeFile(metadataPath, `${JSON.stringify({
      ...metadata,
      version: [metadata.version],
    })}\n`);
    await expect(readWindowsNMinusOneMetadata({
      repositoryRoot: temporaryRoot,
      configuredPath: join("release", "n-minus-one", "metadata.json"),
      currentVersion: "0.0.48",
      releaseChannel: "stable",
      architecture: "x64",
    })).rejects.toThrow("does not match this candidate");

    await expect(readWindowsNMinusOneMetadata({
      repositoryRoot: join(temporaryRoot, "repository"),
      configuredPath: join("..", "release", "n-minus-one", "metadata.json"),
      currentVersion: "0.0.48",
      releaseChannel: "stable",
      architecture: "x64",
    })).rejects.toThrow("metadata path escapes the repository");
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
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

test("gates the exact runtime-selected and fallback node-pty binaries per Windows architecture", async () => {
  const { installedWindowsNativeBinaryPaths } = await installerSmokeModule();

  for (const architecture of ["x64", "arm64"] as const) {
    const paths = installedWindowsNativeBinaryPaths(
      join("installed", architecture),
      "Inertia.exe",
      architecture,
    );
    const nodePtyRoot = join("node-pty");
    const releaseRoot = join(nodePtyRoot, "build", "Release");
    const prebuildRoot = join(nodePtyRoot, "prebuilds", `win32-${architecture}`);

    expect(paths).toHaveLength(24);
    expect(new Set(paths).size).toBe(24);
    expect(paths.filter((path) => path.includes(releaseRoot))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(join(releaseRoot, "pty.node")),
        expect.stringContaining(join(releaseRoot, "conpty.node")),
        expect.stringContaining(join(releaseRoot, "winpty-agent.exe")),
      ]),
    );
    expect(paths.filter((path) => path.includes(prebuildRoot))).toHaveLength(7);
    expect(paths).toEqual(expect.arrayContaining([
      expect.stringContaining(join(prebuildRoot, "conpty", "conpty.dll")),
      expect.stringContaining(join(prebuildRoot, "conpty", "OpenConsole.exe")),
      expect.stringContaining(join(
        nodePtyRoot,
        "third_party",
        "conpty",
        "1.23.251008001",
        `win10-${architecture}`,
        "conpty.dll",
      )),
    ]));
    expect(paths.some((path) => path.includes(join(releaseRoot, "conpty", "conpty.dll"))))
      .toBe(false);
    expect(paths.every((path) => !path.includes(`win32-${architecture === "x64" ? "arm64" : "x64"}`)))
      .toBe(true);
  }
});

test("rejects missing and extra installed node-pty native payloads", async () => {
  const {
    installedWindowsNativeBinaryPaths,
    requireExactNodePtyNativeInventory,
  } = await installerSmokeModule();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-node-pty-inventory-"));
  try {
    for (const architecture of ["x64", "arm64"] as const) {
      const packageRoot = join(temporaryRoot, architecture);
      const nodePtyNeedle = join("node_modules", "node-pty");
      const nodePtyPaths = installedWindowsNativeBinaryPaths(
        packageRoot,
        "Inertia.exe",
        architecture,
      ).filter((path) => path.includes(nodePtyNeedle));
      for (const path of nodePtyPaths) {
        await writeFixture(path, architecture);
      }

      const otherArchitecture = architecture === "x64" ? "arm64" : "x64";
      await writeFixture(join(
        packageRoot,
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "node-pty",
        "prebuilds",
        `win32-${otherArchitecture}`,
        "decoy.dll",
      ), "cross-architecture decoy");
      await writeFixture(join(
        packageRoot,
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "node-pty",
        "third_party",
        "conpty",
        "1.23.251008001",
        `win10-${otherArchitecture}`,
        "decoy.dll",
      ), "cross-architecture decoy");

      await expect(requireExactNodePtyNativeInventory(packageRoot, architecture))
        .resolves.toBeUndefined();

      const extraPath = join(
        packageRoot,
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "node-pty",
        "build",
        "Release",
        "unexpected.dll",
      );
      await writeFile(extraPath, "unexpected");
      await expect(requireExactNodePtyNativeInventory(packageRoot, architecture))
        .rejects.toThrow("native inventory is not exact");
      await unlink(extraPath);

      if (process.platform !== "win32") {
        const symlinkPath = join(dirname(extraPath), "unexpected-link.dll");
        await symlink(nodePtyPaths[0], symlinkPath);
        await expect(requireExactNodePtyNativeInventory(packageRoot, architecture))
          .rejects.toThrow("contains symbolic link");
        await unlink(symlinkPath);
      }

      await unlink(nodePtyPaths.at(-1)!);
      await expect(requireExactNodePtyNativeInventory(packageRoot, architecture))
        .rejects.toThrow("native inventory is not exact");
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("compares the installed Windows runtime byte-for-byte and rejects wrong PE architecture", async () => {
  const {
    installedWindowsNativeBinaryPaths,
    requireInstalledFiles,
  } = await installerSmokeModule();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-installed-inventory-"));
  try {
    for (const architecture of ["x64", "arm64"] as const) {
      const fixtureRoot = join(temporaryRoot, architecture);
      const installedRoot = join(fixtureRoot, "installed");
      const unpackedRoot = join(fixtureRoot, "unpacked");
      const applicationName = "Inertia.exe";
      const uninstallerName = "Uninstall Inertia.exe";
      const requiredRelativePaths = [
        join("resources", "app.asar"),
        join("resources", "LICENSE.txt"),
        join("resources", "THIRD_PARTY_NOTICES.txt"),
        join("resources", "runtime", "windows-runtime-job.exe"),
        join("resources", "elevate.exe"),
      ];
      for (const relativePath of requiredRelativePaths) {
        await writeFixture(join(unpackedRoot, relativePath), `source-${relativePath}`);
        await writeFixture(join(installedRoot, relativePath), `source-${relativePath}`);
      }
      await writeFixture(join(installedRoot, uninstallerName), "generated uninstaller");

      const installedNativePaths = installedWindowsNativeBinaryPaths(
        installedRoot,
        applicationName,
        architecture,
      );
      const unpackedNativePaths = installedWindowsNativeBinaryPaths(
        unpackedRoot,
        applicationName,
        architecture,
      );
      for (let index = 0; index < installedNativePaths.length; index += 1) {
        const binary = peBinary(architecture, index);
        await writeFixture(installedNativePaths[index], binary);
        await writeFixture(unpackedNativePaths[index], binary);
      }

      await expect(requireInstalledFiles(
        installedRoot,
        unpackedRoot,
        applicationName,
        uninstallerName,
        architecture,
      )).resolves.toBeUndefined();

      const installedAsar = join(installedRoot, "resources", "app.asar");
      await writeFile(installedAsar, "changed payload");
      await expect(requireInstalledFiles(
        installedRoot,
        unpackedRoot,
        applicationName,
        uninstallerName,
        architecture,
      )).rejects.toThrow("changed required file");
      await writeFile(installedAsar, `source-${join("resources", "app.asar")}`);

      const wrongIndex = installedNativePaths.findIndex((path) => path.endsWith("conpty.node"));
      await writeFile(installedNativePaths[wrongIndex], peBinary(architecture, 255));
      await expect(requireInstalledFiles(
        installedRoot,
        unpackedRoot,
        applicationName,
        uninstallerName,
        architecture,
      )).rejects.toThrow("changed native binary");
      await writeFile(installedNativePaths[wrongIndex], peBinary(architecture, wrongIndex));

      const wrongArchitecture = architecture === "x64" ? "arm64" : "x64";
      await writeFile(installedNativePaths[wrongIndex], peBinary(wrongArchitecture));
      await writeFile(unpackedNativePaths[wrongIndex], peBinary(wrongArchitecture));
      await expect(requireInstalledFiles(
        installedRoot,
        unpackedRoot,
        applicationName,
        uninstallerName,
        architecture,
      )).rejects.toThrow("native architecture mismatch");
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
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
    expect(executableProcessExists(rootPid)).toBe(false);
    expect(executableProcessExists(descendantPid)).toBe(false);
  } finally {
    if (descendantPid > 0 && executableProcessExists(descendantPid)) {
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
    expect(executableProcessExists(middlePid)).toBe(false);
    expect(executableProcessExists(grandchildPid)).toBe(false);
  } finally {
    for (const pid of [middlePid, grandchildPid]) {
      if (pid <= 0 || !executableProcessExists(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Best-effort cleanup for a failing regression.
      }
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("terminates a token-bound detached process group handed off by the root", async () => {
  if (process.platform === "win32") return;
  const { runBounded } = await installerSmokeModule();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-detached-handoff-test-"));
  const handoffFile = join(temporaryRoot, "process-group.json");
  const pidFile = join(temporaryRoot, "detached-pids.json");
  const handoffToken = "9de5486e-67f0-4d62-9f18-ea9220f23d44";
  let detachedPid = 0;
  let grandchildPid = 0;
  try {
    const middleScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(process.argv[1], JSON.stringify({ detached: process.pid, grandchild: child.pid }));',
      "setInterval(() => {}, 1000);",
    ].join("");
    const rootScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "const handoff = process.argv[1];",
      "const token = process.argv[2];",
      "const pidFile = process.argv[3];",
      "const publish = (value) => writeFileSync(handoff, JSON.stringify({ ownerToken: token, supervisorPid: process.pid, timestampMs: Date.now(), ...value }));",
      'publish({ state: "launching" });',
      `const middle = spawn(process.execPath, ["-e", ${JSON.stringify(middleScript)}, pidFile], { detached: true, stdio: "ignore" });`,
      'publish({ state: "owned", processGroupId: middle.pid });',
      "setInterval(() => {}, 1000);",
    ].join("");
    await expect(runBounded(
      process.execPath,
      ["-e", rootScript, handoffFile, handoffToken, pidFile],
      {
        label: "Detached handoff timeout fixture",
        posixProcessGroupHandoff: { ownerToken: handoffToken, path: handoffFile },
        timeoutMs: 750,
      },
    )).rejects.toThrow("complete process tree was terminated");
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as {
      detached: number;
      grandchild: number;
    };
    detachedPid = pids.detached;
    grandchildPid = pids.grandchild;
    expect(executableProcessExists(detachedPid)).toBe(false);
    expect(executableProcessExists(grandchildPid)).toBe(false);
  } finally {
    if (detachedPid > 0) {
      try {
        process.kill(-detachedPid, "SIGKILL");
      } catch {
        // Best-effort cleanup for a failing regression.
      }
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("never kills a live process group after its token-bound release", async () => {
  if (process.platform === "win32") return;
  const { runBounded } = await installerSmokeModule();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-released-handoff-test-"));
  const handoffFile = join(temporaryRoot, "process-group.json");
  const pidFile = join(temporaryRoot, "released-pid.json");
  const handoffToken = "db4318c6-9336-4227-9300-08a9694b0784";
  let releasedPid = 0;
  try {
    const rootScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "const handoff = process.argv[1];",
      "const token = process.argv[2];",
      "const pidFile = process.argv[3];",
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
      "child.unref();",
      "writeFileSync(pidFile, JSON.stringify({ released: child.pid }));",
      'writeFileSync(handoff, JSON.stringify({ ownerToken: token, processGroupId: child.pid, state: "released", supervisorPid: process.pid, timestampMs: Date.now() }));',
    ].join("");
    await expect(runBounded(
      process.execPath,
      ["-e", rootScript, handoffFile, handoffToken, pidFile],
      {
        label: "Released handoff reuse fixture",
        posixProcessGroupHandoff: { ownerToken: handoffToken, path: handoffFile },
        timeoutMs: 5_000,
      },
    )).rejects.toThrow("released process-group id is live and no longer safe to terminate");
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as { released: number };
    releasedPid = pids.released;
    expect(executableProcessExists(releasedPid)).toBe(true);
  } finally {
    if (releasedPid > 0) {
      try {
        process.kill(-releasedPid, "SIGKILL");
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
  const normalizedSource = source.replaceAll(/\r\n?/gu, "\n");
  const boundedRunnerSource = await readFile(
    join(repositoryRoot, "scripts", "bounded-process-tree.mjs"),
    "utf8",
  );
  const releaseConfig = await readFile(
    join(repositoryRoot, "scripts", "electron-builder.release.cjs"),
    "utf8",
  );
  const packageSmokeSource = await readFile(
    join(repositoryRoot, "scripts", "package-smoke.mjs"),
    "utf8",
  );

  expect(manifest.devDependencies["electron-builder"]).toBe("26.15.7");
  expect(lock.packages["node_modules/electron-builder"]?.version).toBe("26.15.7");
  expect(lock.packages["node_modules/app-builder-lib"]?.version).toBe("26.15.7");
  expect(manifest.scripts["test:windows-installer-smoke"])
    .toBe("node scripts/windows-installer-smoke.mjs");
  expect(source).toContain("NSIS application archive verified");
  expect(source).toContain("Generated NSIS application payload inspection");
  expect(source).not.toContain('["l", "-slt", installer]');
  expect(releaseConfig).toContain("artifactBuildCompleted: verifyWindowsNsisPayload");
  expect(releaseConfig).toContain("verifyBuiltNsisApplicationArchive");
  expect(source).toContain("Installed Windows native binaries verified");
  expect(source).toContain("readWindowsNMinusOneMetadata");
  expect(source).toContain("Silent Windows in-place N-1 to N installer");
  expect(source).toContain("Windows packaged N-1 to N smoke passed");
  expect(source).toContain("sha256File(unpackedPath)");
  expect(source).toContain("installedDigest !== unpackedDigest");
  expect(source).toContain("changed required file");
  expect(source).toContain("requireExactNodePtyNativeInventory(unpackedDirectory, architecture)");
  expect(source).toContain('"d3dcompiler_47.dll"');
  expect(source).not.toContain('"libEGL.dll"');
  expect(source).not.toContain('"libGLESv2.dll"');
  expect(source).toContain('"prebuilds", `win32-${architecture}`');
  expect(source).toContain('["conpty.dll", "OpenConsole.exe"]');
  expect(source).not.toContain('"build", "Release", "conpty", name');
  expect(source).toContain('join("resources", "elevate.exe")');
  expect(source).toContain(
    'join("resources", "runtime", "windows-runtime-job.exe")',
  );
  expect(source).toContain("INERTIA_PACKAGE_SMOKE_EXECUTABLE: installedExecutable");
  expect(source).toContain("INERTIA_PACKAGE_SMOKE_EXPECTED_VERSION: expectedVersion");
  expect(source).toContain("INERTIA_PACKAGE_SMOKE_STATE_ROOT: stateRoot");
  expect(source).toContain('join(temporaryRoot, "existing profile and data")');
  expect(source).toContain('"data",\n        "inertia.sqlite"');
  expect(packageSmokeSource).toContain(
    'boundedExactPathEnvironment(\n  "INERTIA_PACKAGE_SMOKE_STATE_ROOT"',
  );
  expect(packageSmokeSource).toContain(
    "The packaged application version does not match the smoke target.",
  );
  expect(source).toContain('["/S", `/D=${installDirectory}`]');
  expect(source).toContain('`_?=${installDirectory}`');
  expect(source).toContain("windowsVerbatimArguments: true");
  expect(source).toContain("await copyFile(");
  expect(normalizedSource).toContain("uninstaller,\n      stagedUninstaller,");
  expect(source).toContain('join(temporaryRoot, "staged-uninstaller.exe")');
  expect(source).toContain('join(temporaryRoot, "installed with spaces")');
  expect(source).toContain("constants.COPYFILE_EXCL");
  expect(boundedRunnerSource).toContain('"guard-owned"');
  expect(boundedRunnerSource).toContain("authority.sha256");
  expect(boundedRunnerSource).toContain("its Windows Job authority");
  expect(boundedRunnerSource).not.toContain(
    '["/PID", String(child.pid), "/T", "/F"]',
  );
  expect(boundedRunnerSource).toContain("its process tree could not be confirmed stopped");
  expect(source).toContain("return await waitForRemoval(installDirectory)");
  expect(source).toContain("completed without a reboot");
});

test("runs packaged N-1 to N on Windows x64 and preserves native ARM64 evidence", async () => {
  const ci = await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const release = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-platforms.yml"),
    "utf8",
  );

  expect(ci).toContain("release_platform: windows-x64");
  expect(ci).toContain("release_platform: windows-arm64");
  expect(ci).toContain("release_package_script: package:release:win");
  expect(ci).toContain("release_package_script: package:release:win:arm64");
  expect(ci).toContain("Package native Windows installer and unpacked app");
  expect(ci).toContain("Download checksummed packaged Windows N-1 installer");
  expect(ci).toContain("Install N-1, upgrade in place, smoke, and uninstall Windows x64 package");
  expect(ci).toContain("INERTIA_WINDOWS_N_MINUS_ONE_METADATA: release/n-minus-one/metadata.json");
  expect(ci).toContain("Install, smoke, and uninstall Windows ARM64 package");
  expect(ci).toContain("run: npm run test:windows-installer-smoke");
  expect(release).toContain("Download checksummed packaged Windows N-1 installer");
  expect(release).toContain("Install N-1, upgrade in place, smoke, and uninstall Windows x64 package");
  expect(release).toContain("Install, smoke, and uninstall Windows ARM64 package");
  expect(release).toContain("run: npm run test:windows-installer-smoke");
});
