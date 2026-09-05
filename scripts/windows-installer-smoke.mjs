import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BoundedProcessExitError,
  ProcessTreeCleanupError,
  runBounded,
} from "./bounded-process-tree.mjs";
import { inspectNativeBinaryArchitecture } from "./native-binary-architecture.mjs";

export { runBounded } from "./bounded-process-tree.mjs";

const require = createRequire(import.meta.url);
const { getPath7za } = require("app-builder-lib/out/toolsets/7zip.js");

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const ARCHITECTURES = new Set(["x64", "arm64"]);
const RELEASE_CHANNELS = new Set(["stable", "canary"]);
const SANITIZED_APPLICATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const INSTALL_TIMEOUT_MS = 3 * 60_000;
const PACKAGE_SMOKE_TIMEOUT_MS = 3 * 60_000;
const UNINSTALL_TIMEOUT_MS = 2 * 60_000;
const UNINSTALL_SETTLE_TIMEOUT_MS = 30_000;
const INSTALL_ROOT_DRAIN_TIMEOUT_MS = 30_000;
const SETTLE_INTERVAL_MS = 100;
const NODE_PTY_CONPTY_VERSION = "1.23.251008001";
const NODE_PTY_RELEASE_FILES = [
  "pty.node",
  "conpty.node",
  "conpty_console_list.node",
  "winpty.dll",
  "winpty-agent.exe",
];
const NODE_PTY_CONPTY_FILES = ["conpty.dll", "OpenConsole.exe"];
const WINDOWS_NATIVE_FILE_PATTERN = /\.(?:dll|exe|node)$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_N_MINUS_ONE_METADATA_BYTES = 8 * 1_024;
const MAX_WINDOWS_INSTALLER_BYTES = 512 * 1_024 * 1_024;

function sleep(milliseconds) {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

async function existsAsRegularFile(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

function compareVersions(left, right) {
  if (!VERSION_PATTERN.test(left) || !VERSION_PATTERN.test(right)) {
    throw new Error("The Windows package transition version is invalid.");
  }
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function exactObjectKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export async function readWindowsNMinusOneMetadata(options) {
  if (options.configuredPath === undefined) return null;
  if (
    typeof options.configuredPath !== "string"
    || options.configuredPath.length === 0
    || options.configuredPath.length > 4_096
    || options.configuredPath.includes("\0")
  ) throw new Error("The Windows N-1 metadata path is invalid.");
  const repositoryRoot = resolve(options.repositoryRoot);
  const metadataPath = resolve(repositoryRoot, options.configuredPath);
  const relativeMetadataPath = relative(repositoryRoot, metadataPath);
  if (
    relativeMetadataPath === ""
    || relativeMetadataPath === ".."
    || relativeMetadataPath.startsWith(`..${sep}`)
    || isAbsolute(relativeMetadataPath)
  ) throw new Error("The Windows N-1 metadata path escapes the repository.");
  const metadataInfo = await lstat(metadataPath);
  if (
    metadataInfo.isSymbolicLink()
    || !metadataInfo.isFile()
    || metadataInfo.size <= 0
    || metadataInfo.size > MAX_N_MINUS_ONE_METADATA_BYTES
  ) throw new Error("The Windows N-1 metadata file is invalid.");
  const value = JSON.parse(await readFile(metadataPath, "utf8"));
  const keys = [
    "architecture",
    "assetName",
    "byteLength",
    "channel",
    "currentVersion",
    "repository",
    "schemaVersion",
    "sha256",
    "tag",
    "version",
  ];
  if (
    !exactObjectKeys(value, keys)
    || value.schemaVersion !== 1
    || value.repository !== "eduardtomas1/inertia"
    || value.currentVersion !== options.currentVersion
    || value.channel !== options.releaseChannel
    || value.architecture !== options.architecture
    || typeof value.version !== "string"
    || compareVersions(value.version, options.currentVersion) >= 0
    || value.tag !== `${value.channel === "canary" ? "canary-v" : "v"}${value.version}`
    || value.assetName !== windowsInstallerAssetName(
      value.version,
      value.channel,
      value.architecture,
    )
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength <= 0
    || value.byteLength > MAX_WINDOWS_INSTALLER_BYTES
    || typeof value.sha256 !== "string"
    || !DIGEST_PATTERN.test(value.sha256)
  ) throw new Error("The Windows N-1 metadata does not match this candidate.");
  const installerPath = join(dirname(metadataPath), value.assetName);
  const installerInfo = await lstat(installerPath);
  if (
    installerInfo.isSymbolicLink()
    || !installerInfo.isFile()
    || installerInfo.size !== value.byteLength
  ) throw new Error("The Windows N-1 installer does not match its metadata.");
  if (await sha256File(installerPath) !== value.sha256) {
    throw new Error("The Windows N-1 installer checksum is invalid.");
  }
  return Object.freeze({
    installerPath,
    version: value.version,
    sha256: value.sha256,
  });
}

async function nativeFilesBelow(root, relativeRoot = "") {
  const entries = await readdir(join(root, relativeRoot), { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const relativePath = join(relativeRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`The Windows native inventory contains symbolic link ${relativePath}.`);
    }
    if (entry.isDirectory()) {
      paths.push(...await nativeFilesBelow(root, relativePath));
    } else if (entry.isFile() && WINDOWS_NATIVE_FILE_PATTERN.test(entry.name)) {
      paths.push(relativePath);
    }
  }
  return paths;
}

export async function requireExactNodePtyNativeInventory(packageDirectory, architecture) {
  const nodePtyRoot = join(
    packageDirectory,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
  );
  const conptyRoot = join(nodePtyRoot, "third_party", "conpty");
  const conptyVersions = (await readdir(conptyRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (conptyVersions.length !== 1 || conptyVersions[0] !== NODE_PTY_CONPTY_VERSION) {
    throw new Error(
      `The packaged node-pty ConPTY inventory has unexpected versions: ${conptyVersions.join(", ")}.`,
    );
  }
  const roots = [
    join("build", "Release"),
    join("prebuilds", `win32-${architecture}`),
    join("third_party", "conpty", NODE_PTY_CONPTY_VERSION, `win10-${architecture}`),
  ];
  const actual = (await Promise.all(
    roots.map(async (relativeRoot) => (await nativeFilesBelow(nodePtyRoot, relativeRoot))
      .map((path) => join("node-pty", path))),
  )).flat().sort();
  const expected = [
    ...NODE_PTY_RELEASE_FILES.map((name) => join("node-pty", "build", "Release", name)),
    ...NODE_PTY_RELEASE_FILES.map((name) => join(
      "node-pty",
      "prebuilds",
      `win32-${architecture}`,
      name,
    )),
    ...NODE_PTY_CONPTY_FILES.map((name) => join(
      "node-pty",
      "prebuilds",
      `win32-${architecture}`,
      "conpty",
      name,
    )),
    ...NODE_PTY_CONPTY_FILES.map((name) => join(
      "node-pty",
      "third_party",
      "conpty",
      NODE_PTY_CONPTY_VERSION,
      `win10-${architecture}`,
      name,
    )),
  ].sort();
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error(
      `The packaged node-pty native inventory is not exact for ${architecture}: ${JSON.stringify(actual)}.`,
    );
  }
}

export function windowsInstallerAssetName(version, releaseChannel, architecture) {
  if (!VERSION_PATTERN.test(version)) throw new Error("The Windows installer version is invalid.");
  if (!RELEASE_CHANNELS.has(releaseChannel)) throw new Error("The Windows installer release channel is invalid.");
  if (!ARCHITECTURES.has(architecture)) throw new Error("The Windows installer architecture is invalid.");
  const prefix = releaseChannel === "canary" ? "Inertia.Canary.Setup" : "Inertia.Setup";
  const architectureSuffix = architecture === "arm64" ? ".arm64" : "";
  return `${prefix}.${version}${architectureSuffix}.exe`;
}

export function installedWindowsApplicationName(releaseChannel) {
  if (!RELEASE_CHANNELS.has(releaseChannel)) {
    throw new Error("The installed Windows application channel is invalid.");
  }
  return releaseChannel === "canary" ? "Inertia Canary.exe" : "Inertia.exe";
}

export async function requireDisposableWindowsInstallerHost(
  localAppData,
  releaseChannel,
) {
  installedWindowsApplicationName(releaseChannel);
  if (
    typeof localAppData !== "string"
    || localAppData.length === 0
    || localAppData.length > 4_096
    || localAppData.includes("\0")
    || !isAbsolute(localAppData)
  ) throw new Error("The Windows installer smoke host identity is invalid.");
  const existingInstall = join(
    resolve(localAppData),
    "Programs",
    releaseChannel === "canary" ? "inertia-canary" : "inertia",
  );
  if (await pathExists(existingInstall)) {
    throw new Error(
      "The Windows installer smoke requires a disposable host without an existing Inertia installation.",
    );
  }
}

function archiveHeader(listing) {
  const normalized = listing.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const boundary = normalized.indexOf("\n----------");
  return boundary < 0 ? normalized : normalized.slice(0, boundary);
}

export function nsisApplicationArchiveName(sanitizedName, version, architecture) {
  if (!SANITIZED_APPLICATION_NAME_PATTERN.test(sanitizedName)) {
    throw new Error("The sanitized Windows application name is invalid.");
  }
  if (!VERSION_PATTERN.test(version)) throw new Error("The Windows installer version is invalid.");
  if (!ARCHITECTURES.has(architecture)) throw new Error("The Windows installer architecture is invalid.");
  return `${sanitizedName}-${version}-${architecture}.nsis.7z`;
}

export function applicationArchiveMethod(listing) {
  const header = archiveHeader(listing);
  if (!/^Type = 7z$/mu.test(header)) {
    const diagnostic = header.slice(0, 2 * 1024);
    throw new Error(
      `The embedded application payload is not a 7z archive. Listing header: ${JSON.stringify(diagnostic)}.`,
    );
  }
  const methods = [...header.matchAll(/^Method = (.+)$/gmu)].map((match) => match[1].trim());
  if (methods.length !== 1 || methods[0].length === 0) {
    throw new Error("The embedded application payload has no exact archive method.");
  }
  return methods[0];
}

export function requireInstallTimeDecodableMethod(method) {
  const tokens = method.trim().split(/\s+/u);
  const allowed = tokens.every((token) =>
    token === "BCJ"
    || token === "Copy"
    || /^LZMA2?:\d+$/u.test(token));
  if (!allowed || tokens.includes("BCJ2") || tokens.some((token) => /^ARM(?:64|T)?$/u.test(token))) {
    throw new Error(
      `The NSIS payload uses install-time undecodable archive method ${JSON.stringify(method)}.`,
    );
  }
  if (!tokens.includes("BCJ") && !tokens.includes("Copy")) {
    throw new Error(`The NSIS payload does not pin a decoder-compatible filter: ${JSON.stringify(method)}.`);
  }
}

export async function verifyBuiltNsisApplicationArchive(options) {
  const applicationArchive = join(
    options.outputDirectory,
    nsisApplicationArchiveName(
      options.sanitizedName,
      options.version,
      options.architecture,
    ),
  );
  if (!await existsAsRegularFile(applicationArchive)) {
    throw new Error(`The generated NSIS application archive is missing or empty: ${applicationArchive}.`);
  }
  const sevenZip = await getPath7za();
  const applicationListing = await runBounded(sevenZip, ["l", "-slt", applicationArchive], {
    label: "Generated NSIS application payload inspection",
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  const method = applicationArchiveMethod(applicationListing);
  requireInstallTimeDecodableMethod(method);
  console.log(`NSIS application archive verified (${applicationArchive}, ${method}).`);
}

export function installedWindowsNativeBinaryPaths(
  installDirectory,
  applicationName,
  architecture,
) {
  if (!ARCHITECTURES.has(architecture)) {
    throw new Error("The installed Windows architecture is invalid.");
  }
  const resources = join(installDirectory, "resources");
  const unpackedModules = join(resources, "app.asar.unpacked", "node_modules");
  return [
    join(installDirectory, applicationName),
    ...["d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll", "ffmpeg.dll", "vk_swiftshader.dll", "vulkan-1.dll"]
      .map((name) => join(installDirectory, name)),
    join(unpackedModules, `@anthropic-ai/claude-agent-sdk-win32-${architecture}/claude.exe`),
    join(unpackedModules, `@napi-rs/canvas-win32-${architecture}-msvc/skia.win32-${architecture}-msvc.node`),
    join(unpackedModules, `better-sqlite3/prebuilds/win32-${architecture}.node`),
    ...NODE_PTY_RELEASE_FILES
      .map((name) => join(unpackedModules, "node-pty", "build", "Release", name)),
    ...NODE_PTY_RELEASE_FILES
      .map((name) => join(unpackedModules, "node-pty", "prebuilds", `win32-${architecture}`, name)),
    ...NODE_PTY_CONPTY_FILES
      .map((name) => join(
        unpackedModules,
        "node-pty",
        "prebuilds",
        `win32-${architecture}`,
        "conpty",
        name,
      )),
    ...NODE_PTY_CONPTY_FILES
      .map((name) => join(
        unpackedModules,
        "node-pty",
        "third_party",
        "conpty",
        NODE_PTY_CONPTY_VERSION,
        `win10-${architecture}`,
        name,
      )),
  ];
}

export async function requireInstalledFiles(
  installDirectory,
  unpackedDirectory,
  applicationName,
  uninstallerName,
  architecture,
) {
  const requiredRelativePaths = [
    applicationName,
    join("resources", "app.asar"),
    join("resources", "LICENSE.txt"),
    join("resources", "THIRD_PARTY_NOTICES.txt"),
    join("resources", "runtime", "windows-runtime-job.exe"),
    join("resources", "elevate.exe"),
  ];
  for (const relativePath of requiredRelativePaths) {
    const installedPath = join(installDirectory, relativePath);
    const unpackedPath = join(unpackedDirectory, relativePath);
    if (!await existsAsRegularFile(installedPath)) {
      throw new Error(`The installed Windows package is missing ${installedPath}.`);
    }
    if (!await existsAsRegularFile(unpackedPath)) {
      throw new Error(`The unpacked Windows package is missing ${unpackedPath}.`);
    }
    const [installedDigest, unpackedDigest] = await Promise.all([
      sha256File(installedPath),
      sha256File(unpackedPath),
    ]);
    if (installedDigest !== unpackedDigest) {
      throw new Error(`The Windows installer changed required file ${relativePath}.`);
    }
  }
  const uninstaller = join(installDirectory, uninstallerName);
  if (!await existsAsRegularFile(uninstaller)) {
    throw new Error(`The installed Windows package is missing ${uninstaller}.`);
  }

  const nativeBinaries = installedWindowsNativeBinaryPaths(
    installDirectory,
    applicationName,
    architecture,
  );
  await requireExactNodePtyNativeInventory(unpackedDirectory, architecture);
  await requireExactNodePtyNativeInventory(installDirectory, architecture);
  for (const path of nativeBinaries) {
    if (!await existsAsRegularFile(path)) {
      throw new Error(`The installed Windows package is missing native binary ${path}.`);
    }
    const relativePath = path.slice(installDirectory.length + 1);
    const unpackedPath = join(unpackedDirectory, relativePath);
    if (!await existsAsRegularFile(unpackedPath)) {
      throw new Error(`The unpacked Windows package is missing native binary ${unpackedPath}.`);
    }
    await inspectNativeBinaryArchitecture(path, {
      expectedArchitecture: architecture,
      platform: "win32",
    });
    await inspectNativeBinaryArchitecture(unpackedPath, {
      expectedArchitecture: architecture,
      platform: "win32",
    });
    const [installedDigest, unpackedDigest] = await Promise.all([
      sha256File(path),
      sha256File(unpackedPath),
    ]);
    if (installedDigest !== unpackedDigest) {
      throw new Error(`The Windows installer changed native binary ${relativePath}.`);
    }
  }
  console.log(
    `Installed Windows native binaries verified byte-for-byte (${nativeBinaries.length}, ${architecture}).`,
  );
}

async function waitForRemoval(path) {
  const deadline = Date.now() + UNINSTALL_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!await pathExists(path)) return;
    await sleep(SETTLE_INTERVAL_MS);
  }
  throw new Error(`The Windows uninstaller left ${path} behind.`);
}

async function runUninstaller(
  uninstaller,
  stagedUninstaller,
  installDirectory,
) {
  // NSIS normally copies itself to TEMP, launches that worker, and lets the
  // installed launcher exit first. Stage it outside $INSTDIR and use NSIS's
  // synchronous _?= form so the bounded process remains the real uninstall
  // worker and its exit status/cleanup stay authoritative. NSIS requires this
  // final parameter to be passed verbatim, including paths with spaces.
  if (!await existsAsRegularFile(stagedUninstaller)) {
    await copyFile(
      uninstaller,
      stagedUninstaller,
      constants.COPYFILE_EXCL,
    );
  }
  await runBounded(
    stagedUninstaller,
    ["/S", `_?=${installDirectory}`],
    {
      label: "Silent Windows uninstaller",
      timeoutMs: UNINSTALL_TIMEOUT_MS,
      windowsVerbatimArguments: true,
    },
  );
  return await waitForRemoval(installDirectory);
}

async function smokeInstalledApplication(
  repositoryRoot,
  installedExecutable,
  label,
  stateRoot,
  expectedVersion,
) {
  await runBounded(
    process.execPath,
    [join(repositoryRoot, "scripts", "package-smoke.mjs")],
    {
      cwd: repositoryRoot,
      echoOutput: true,
      env: {
        ...process.env,
        INERTIA_PACKAGE_SMOKE_EXECUTABLE: installedExecutable,
        INERTIA_PACKAGE_SMOKE_EXPECTED_VERSION: expectedVersion,
        INERTIA_PACKAGE_SMOKE_KIND: "windows-installed",
        INERTIA_PACKAGE_SMOKE_STATE_ROOT: stateRoot,
      },
      label,
      timeoutMs: PACKAGE_SMOKE_TIMEOUT_MS,
    },
  );
}

const INSTALL_ROOT_PROCESS_SNAPSHOT_SCRIPT = `
$ErrorActionPreference = "Stop"
$rootPath = [IO.Path]::GetFullPath($env:INERTIA_INSTALLER_SMOKE_ROOT).TrimEnd([char[]]'\\/')
$rootItem = Get-Item -LiteralPath $rootPath -Force -ErrorAction Stop
if ($rootItem -isnot [IO.DirectoryInfo] -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "unsafe install root"
}
$root = [IO.Path]::GetFullPath($rootItem.FullName).TrimEnd([char[]]'\\/')
$prefix = $root + [IO.Path]::DirectorySeparatorChar
$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {
  $rawPath = [string]$_.ExecutablePath
  if ([String]::IsNullOrEmpty($rawPath)) { return }
  try {
    $pathItem = Get-Item -LiteralPath $rawPath -Force -ErrorAction Stop
    if ($pathItem -isnot [IO.FileInfo]) { throw "unsafe process path" }
    $path = [IO.Path]::GetFullPath($pathItem.FullName)
  } catch {
    if (
      $rawPath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase) -or
      $rawPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
    ) { throw }
    return
  }
  if ($path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    [ordered]@{
      processId = [int]$_.ProcessId
      name = [string]$_.Name
      executablePath = $path
    }
  }
})
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 3 -InputObject ([ordered]@{
  processes = $processes
})))
`.trim();

export async function windowsInstallRootProcesses(installDirectory) {
  if (process.platform !== "win32") {
    throw new Error("Windows install-root process discovery requires Windows.");
  }
  const systemRoot = process.env.SystemRoot;
  if (
    typeof systemRoot !== "string"
    || systemRoot.length === 0
    || systemRoot.length > 32_767
    || systemRoot.includes("\0")
    || !isAbsolute(systemRoot)
  ) throw new Error("The Windows system root is invalid.");
  const powershell = join(
    resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!await existsAsRegularFile(powershell)) {
    throw new Error("The trusted Windows PowerShell executable is unavailable.");
  }
  const root = resolve(installDirectory);
  const command = Buffer.from(
    INSTALL_ROOT_PROCESS_SNAPSHOT_SCRIPT,
    "utf16le",
  ).toString("base64");
  const output = await runBounded(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command],
    {
      env: {
        ...process.env,
        INERTIA_INSTALLER_SMOKE_ROOT: root,
      },
      label: "Windows install-root process discovery",
      timeoutMs: 15_000,
    },
  );
  const value = JSON.parse(output);
  if (
    value === null
    || typeof value !== "object"
    || Object.keys(value).length !== 1
    || !Array.isArray(value.processes)
    || value.processes.length > 4_096
  ) throw new Error("Windows install-root process discovery returned invalid data.");
  for (const entry of value.processes) {
    if (
      entry === null
      || typeof entry !== "object"
      || Object.keys(entry).sort().join("\0")
        !== ["executablePath", "name", "processId"].join("\0")
      || !Number.isSafeInteger(entry.processId)
      || entry.processId <= 0
      || typeof entry.name !== "string"
      || entry.name.length === 0
      || entry.name.length > 260
      || typeof entry.executablePath !== "string"
      || entry.executablePath.length === 0
      || entry.executablePath.length > 32_767
    ) throw new Error("Windows install-root process discovery returned invalid data.");
  }
  return value.processes;
}

async function waitForInstallRootProcessDrain(installDirectory) {
  const deadline = Date.now() + INSTALL_ROOT_DRAIN_TIMEOUT_MS;
  let processes = [];
  do {
    processes = await windowsInstallRootProcesses(installDirectory);
    if (processes.length === 0) return;
    await sleep(SETTLE_INTERVAL_MS);
  } while (Date.now() < deadline);
  const summary = processes
    .map(({ name, processId }) => `${name} (${processId})`)
    .join(", ");
  throw new Error(
    `Windows install-root processes did not finish safe shutdown: ${summary}.`,
  );
}

async function waitForChildEvent(child, timeoutMs, label) {
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`${label} timed out.`));
    }, timeoutMs);
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function stopInstallRootBlocker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolvePromise) => child.once("close", resolvePromise));
  child.stdin?.end("exit\r\n");
  const graceful = await Promise.race([
    closed.then(() => true),
    sleep(2_000).then(() => false),
  ]);
  if (graceful) return;
  child.kill();
  const terminated = await Promise.race([
    closed.then(() => true),
    sleep(2_000).then(() => false),
  ]);
  if (!terminated) {
    throw new ProcessTreeCleanupError(
      "The exact install-root blocker process did not close.",
    );
  }
}

async function proveInstallerPreservesLiveInstallRootProcess(options) {
  const blockerPath = join(options.installDirectory, "inertia-update-blocker.exe");
  await copyFile(process.execPath, blockerPath, constants.COPYFILE_EXCL);
  const installedDigest = await sha256File(options.installedExecutable);
  const blocker = spawn(blockerPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  try {
    await waitForChildEvent(blocker, 5_000, "Install-root blocker startup");
    await sleep(100);
    if (blocker.exitCode !== null || blocker.signalCode !== null) {
      throw new Error("The install-root blocker exited before the installer ran.");
    }
    let rejected = false;
    try {
      await runBounded(
        options.installer,
        ["/S", `/D=${options.installDirectory}`],
        {
          label: "Windows installer live-process refusal",
          timeoutMs: INSTALL_TIMEOUT_MS,
          windowsVerbatimArguments: true,
        },
      );
    } catch (error) {
      if (
        !(error instanceof BoundedProcessExitError)
        || error.exitCode !== 1
      ) throw error;
      rejected = true;
    }
    if (!rejected) {
      throw new Error("The Windows installer replaced a live installation.");
    }
    if (blocker.exitCode !== null || blocker.signalCode !== null) {
      throw new Error("The Windows installer terminated an install-root process.");
    }
    if (await sha256File(options.installedExecutable) !== installedDigest) {
      throw new Error("The refused Windows installer changed the installed executable.");
    }
    console.log("Windows installer preserved the live install-root process and old executable.");
  } finally {
    await stopInstallRootBlocker(blocker);
    await rm(blockerPath, { force: true });
  }
}

async function installWhileSiblingProcessLives(options) {
  const siblingDirectory = `${options.installDirectory}-sibling`;
  const blockerPath = join(siblingDirectory, "inertia-update-blocker.exe");
  await mkdir(siblingDirectory, { mode: 0o700 });
  await copyFile(process.execPath, blockerPath, constants.COPYFILE_EXCL);
  const blocker = spawn(blockerPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  try {
    await waitForChildEvent(blocker, 5_000, "Sibling install-root blocker startup");
    await runBounded(
      options.installer,
      ["/S", `/D=${options.installDirectory}`],
      {
        label: options.label,
        timeoutMs: INSTALL_TIMEOUT_MS,
        windowsVerbatimArguments: true,
      },
    );
    if (blocker.exitCode !== null || blocker.signalCode !== null) {
      throw new Error("The Windows installer terminated a sibling process.");
    }
    console.log("Windows installer accepted the sibling-path boundary without terminating it.");
  } finally {
    await stopInstallRootBlocker(blocker);
    await rm(siblingDirectory, { force: true, recursive: true });
  }
}

export async function main() {
  if (process.platform !== "win32") {
    throw new Error("The Windows installer smoke must run on Windows.");
  }
  if (!ARCHITECTURES.has(process.arch)) {
    throw new Error(`The Windows installer smoke does not support ${process.arch}.`);
  }
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const manifest = require(join(repositoryRoot, "package.json"));
  const releaseChannel = process.env.INERTIA_RELEASE_CHANNEL ?? "stable";
  await requireDisposableWindowsInstallerHost(
    process.env.LOCALAPPDATA,
    releaseChannel,
  );
  const installer = join(
    repositoryRoot,
    "release",
    windowsInstallerAssetName(manifest.version, releaseChannel, process.arch),
  );
  if (!await existsAsRegularFile(installer)) {
    throw new Error(`The exact Windows installer is missing: ${installer}.`);
  }
  const nMinusOne = await readWindowsNMinusOneMetadata({
    repositoryRoot,
    configuredPath: process.env.INERTIA_WINDOWS_N_MINUS_ONE_METADATA,
    currentVersion: manifest.version,
    releaseChannel,
    architecture: process.arch,
  });

  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-installer-smoke-"));
  const installDirectory = join(temporaryRoot, "installed with spaces");
  const persistentStateRoot = join(temporaryRoot, "existing profile and data");
  await mkdir(persistentStateRoot, { mode: 0o700 });
  const stagedUninstaller = join(temporaryRoot, "staged-uninstaller.exe");
  const applicationName = installedWindowsApplicationName(releaseChannel);
  const productName = applicationName.slice(0, -".exe".length);
  const uninstallerName = `Uninstall ${productName}.exe`;
  const installedExecutable = join(installDirectory, applicationName);
  const unpackedDirectory = join(
    repositoryRoot,
    "release",
    process.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked",
  );
  const uninstaller = join(installDirectory, uninstallerName);
  let operationError;
  let uninstalled = false;
  try {
    if (nMinusOne) {
      await runBounded(
        nMinusOne.installerPath,
        ["/S", `/D=${installDirectory}`],
        {
          label: `Silent Windows N-1 installer (${nMinusOne.version})`,
          timeoutMs: INSTALL_TIMEOUT_MS,
          windowsVerbatimArguments: true,
        },
      );
      if (!await existsAsRegularFile(installedExecutable)) {
        throw new Error("The packaged Windows N-1 application was not installed.");
      }
      await inspectNativeBinaryArchitecture(installedExecutable, {
        expectedArchitecture: process.arch,
        platform: "win32",
      });
      await smokeInstalledApplication(
        repositoryRoot,
        installedExecutable,
        `Installed Windows N-1 application smoke (${nMinusOne.version})`,
        persistentStateRoot,
        nMinusOne.version,
      );
      await waitForInstallRootProcessDrain(installDirectory);
      if (!await existsAsRegularFile(join(
        persistentStateRoot,
        "data",
        "inertia.sqlite",
      ))) {
        throw new Error("The packaged Windows N-1 smoke did not create durable profile state.");
      }
      await proveInstallerPreservesLiveInstallRootProcess({
        installDirectory,
        installedExecutable,
        installer,
      });
      await waitForInstallRootProcessDrain(installDirectory);
    }
    const installLabel = nMinusOne
      ? `Silent Windows in-place N-1 to N installer (${nMinusOne.version} -> ${manifest.version})`
      : "Silent Windows installer";
    if (nMinusOne) {
      await installWhileSiblingProcessLives({
        installDirectory,
        installer,
        label: installLabel,
      });
    } else {
      await runBounded(installer, ["/S", `/D=${installDirectory}`], {
        label: installLabel,
        timeoutMs: INSTALL_TIMEOUT_MS,
        windowsVerbatimArguments: true,
      });
    }
    await requireInstalledFiles(
      installDirectory,
      unpackedDirectory,
      applicationName,
      uninstallerName,
      process.arch,
    );
    await smokeInstalledApplication(
      repositoryRoot,
      installedExecutable,
      nMinusOne
        ? `Installed Windows N candidate smoke (${manifest.version})`
        : "Installed Windows application smoke",
      persistentStateRoot,
      manifest.version,
    );
    await runUninstaller(uninstaller, stagedUninstaller, installDirectory);
    uninstalled = true;
    console.log(
      nMinusOne
        ? `Windows packaged N-1 to N smoke passed for ${process.arch}: ${nMinusOne.version} -> ${manifest.version}, existing profile, native runtime, and uninstall completed without a reboot.`
        : `Windows installer smoke passed for ${process.arch}: install, native runtime, and uninstall completed without a reboot.`,
    );
  } catch (error) {
    operationError = error;
  } finally {
    const preserveTemporaryRoot = operationError?.preserveTemporaryRoot === true;
    if (
      !preserveTemporaryRoot &&
      !uninstalled &&
      (
        await existsAsRegularFile(stagedUninstaller) ||
        await existsAsRegularFile(uninstaller)
      )
    ) {
      try {
        await runUninstaller(
          uninstaller,
          stagedUninstaller,
          installDirectory,
        );
      } catch (cleanupError) {
        if (!operationError || cleanupError?.preserveTemporaryRoot === true) {
          operationError = cleanupError;
        }
      }
    }
    const preserveAfterCleanup = operationError?.preserveTemporaryRoot === true;
    if (!preserveAfterCleanup) {
      try {
        await rm(temporaryRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
      } catch (cleanupError) {
        if (!operationError) operationError = cleanupError;
      }
    } else {
      console.error(`Preserved Windows installer smoke root after unconfirmed process cleanup: ${temporaryRoot}.`);
    }
  }
  if (operationError) throw operationError;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
