import { createRequire } from "node:module";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBounded } from "./bounded-process-tree.mjs";
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
const SETTLE_INTERVAL_MS = 100;

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

export function windowsInstallerAssetName(version, releaseChannel, architecture) {
  if (!VERSION_PATTERN.test(version)) throw new Error("The Windows installer version is invalid.");
  if (!RELEASE_CHANNELS.has(releaseChannel)) throw new Error("The Windows installer release channel is invalid.");
  if (!ARCHITECTURES.has(architecture)) throw new Error("The Windows installer architecture is invalid.");
  const prefix = releaseChannel === "canary" ? "Inertia.Canary.Setup" : "Inertia.Setup";
  const architectureSuffix = architecture === "arm64" ? ".arm64" : "";
  return `${prefix}.${version}${architectureSuffix}.exe`;
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

async function requireInstalledFiles(
  installDirectory,
  applicationName,
  uninstallerName,
  architecture,
) {
  const resources = join(installDirectory, "resources");
  const unpackedModules = join(resources, "app.asar.unpacked", "node_modules");
  const requiredFiles = [
    join(installDirectory, applicationName),
    join(installDirectory, uninstallerName),
    join(resources, "app.asar"),
    join(resources, "LICENSE.txt"),
    join(resources, "THIRD_PARTY_NOTICES.txt"),
    join(resources, "elevate.exe"),
  ];
  for (const path of requiredFiles) {
    if (!await existsAsRegularFile(path)) {
      throw new Error(`The installed Windows package is missing ${path}.`);
    }
  }

  const nativeBinaries = [
    join(installDirectory, applicationName),
    ...["d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll", "ffmpeg.dll", "libEGL.dll", "libGLESv2.dll", "vk_swiftshader.dll", "vulkan-1.dll"]
      .map((name) => join(installDirectory, name)),
    join(unpackedModules, `@anthropic-ai/claude-agent-sdk-win32-${architecture}/claude.exe`),
    join(unpackedModules, `@napi-rs/canvas-win32-${architecture}-msvc/skia.win32-${architecture}-msvc.node`),
    join(unpackedModules, `better-sqlite3/prebuilds/win32-${architecture}.node`),
    ...["pty.node", "conpty.node", "conpty_console_list.node", "winpty.dll", "winpty-agent.exe"]
      .map((name) => join(unpackedModules, "node-pty", "build", "Release", name)),
    ...["conpty.dll", "OpenConsole.exe"]
      .map((name) => join(unpackedModules, "node-pty", "build", "Release", "conpty", name)),
  ];
  for (const path of nativeBinaries) {
    if (!await existsAsRegularFile(path)) {
      throw new Error(`The installed Windows package is missing native binary ${path}.`);
    }
    await inspectNativeBinaryArchitecture(path, {
      expectedArchitecture: architecture,
      platform: "win32",
    });
  }
  console.log(`Installed Windows native binaries verified (${nativeBinaries.length}, ${architecture}).`);
}

async function waitForRemoval(path) {
  const deadline = Date.now() + UNINSTALL_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!await pathExists(path)) return;
    await sleep(SETTLE_INTERVAL_MS);
  }
  throw new Error(`The Windows uninstaller left ${path} behind.`);
}

async function runUninstaller(uninstaller, installDirectory) {
  await runBounded(uninstaller, ["/S"], {
    label: "Silent Windows uninstaller",
    timeoutMs: UNINSTALL_TIMEOUT_MS,
  });
  return waitForRemoval(installDirectory);
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
  const installer = join(
    repositoryRoot,
    "release",
    windowsInstallerAssetName(manifest.version, releaseChannel, process.arch),
  );
  if (!await existsAsRegularFile(installer)) {
    throw new Error(`The exact Windows installer is missing: ${installer}.`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-installer-smoke-"));
  const installDirectory = join(temporaryRoot, "installed");
  const productName = releaseChannel === "canary" ? "Inertia Canary" : "Inertia";
  const applicationName = `${productName}.exe`;
  const uninstallerName = `Uninstall ${productName}.exe`;
  const installedExecutable = join(installDirectory, applicationName);
  const uninstaller = join(installDirectory, uninstallerName);
  let operationError;
  let uninstalled = false;
  try {
    await runBounded(installer, ["/S", `/D=${installDirectory}`], {
      label: "Silent Windows installer",
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    await requireInstalledFiles(
      installDirectory,
      applicationName,
      uninstallerName,
      process.arch,
    );
    await runBounded(process.execPath, [join(repositoryRoot, "scripts", "package-smoke.mjs")], {
      cwd: repositoryRoot,
      echoOutput: true,
      env: {
        ...process.env,
        INERTIA_PACKAGE_SMOKE_EXECUTABLE: installedExecutable,
        INERTIA_PACKAGE_SMOKE_KIND: "windows-installed",
      },
      label: "Installed Windows application smoke",
      timeoutMs: PACKAGE_SMOKE_TIMEOUT_MS,
    });
    await runUninstaller(uninstaller, installDirectory);
    uninstalled = true;
    console.log(
      `Windows installer smoke passed for ${process.arch}: install, native runtime, and uninstall completed without a reboot.`,
    );
  } catch (error) {
    operationError = error;
  } finally {
    const preserveTemporaryRoot = operationError?.preserveTemporaryRoot === true;
    if (!preserveTemporaryRoot && !uninstalled && await existsAsRegularFile(uninstaller)) {
      try {
        await runUninstaller(uninstaller, installDirectory);
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
