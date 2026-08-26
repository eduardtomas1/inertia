import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { access, copyFile, lstat, mkdtemp, mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import { parseDocument } from "yaml";

import {
  packageSmokeProcessesExited,
  packageSmokeChildEnvironment,
  packagedAppUsesDetachedProcessGroup,
  parsePackageSmokeOwnedPids,
  parsePackageSmokeReadiness,
  isPackageSmokeOwnerToken,
  resolvePackageSmokeLaunchMode,
  waitForPackageSmokeExit,
  waitForPackageSmokeReadiness,
} from "./package-smoke-launch.mjs";

const STARTUP_TIMEOUT_MS = 30_000;
// This begins only after runtime readiness. It covers the product's bounded
// 30s cold module load plus 12s extraction deadline and result-file cleanup.
const PACKAGED_PDF_TIMEOUT_MS = 47_000;
const EXIT_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const MAX_OUTPUT_LENGTH = 64 * 1024;
const MAX_PACKAGED_MANIFEST_BYTES = 256 * 1024;
const MAX_UPDATE_CONFIG_BYTES = 64 * 1024;
const MAX_MAIN_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_GUARDIAN_BYTES = 1024 * 1024;
const releaseChannel = process.env.INERTIA_RELEASE_CHANNEL ?? "stable";
if (releaseChannel !== "stable" && releaseChannel !== "canary") {
  throw new Error("INERTIA_RELEASE_CHANNEL must be stable or canary.");
}
const canary = releaseChannel === "canary";
const UPDATE_PROVIDER_URL = canary
  ? "https://raw.githubusercontent.com/eduardtomas1/inertia/canary-feed"
  : "https://github.com/eduardtomas1/inertia/releases/latest/download";
const STABLE_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const MANUAL_UPDATE_REASONS = new Set([
  "development-build",
  "capability-missing",
  "capability-invalid",
  "platform-mismatch",
  "macos-signing-unavailable",
  "windows-signing-unavailable",
]);
const PACKAGE_KINDS = new Set([
  "linux-appimage",
  "linux-unpacked",
  "macos-dmg",
  "macos-unpacked",
  "macos-zip",
  "windows-installed",
  "windows-unpacked",
]);
function boundedExactPathEnvironment(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (value.length === 0 || value !== value.trim() || Buffer.byteLength(value, "utf8") > 4 * 1024) {
    throw new Error(`${name} must be a bounded exact path.`);
  }
  return resolve(value);
}

function sleep(milliseconds) {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function isExecutableFile(path) {
  try {
    const value = await stat(path);
    if (!value.isFile()) return false;
    if (process.platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readAsarArchive(archive) {
  const handle = await open(archive, "r");
  try {
    const prefix = Buffer.alloc(16);
    const { bytesRead } = await handle.read(prefix, 0, 16, 0);
    if (bytesRead !== 16) throw new Error("The packaged archive has no asar header.");
    const headerSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    if (
      headerSize < jsonLength + 8
      || headerSize > 64 * 1024 * 1024
      || jsonLength <= 0
      || jsonLength > 64 * 1024 * 1024
    ) {
      throw new Error("The packaged archive reported an unreasonable asar header size.");
    }
    const json = Buffer.alloc(jsonLength);
    const header = await handle.read(json, 0, jsonLength, 16);
    if (header.bytesRead !== jsonLength) throw new Error("The packaged asar header was truncated.");
    return {
      archive,
      headerSize,
      tree: JSON.parse(json.toString("utf8")),
    };
  } finally {
    await handle.close();
  }
}

function asarEntry(tree, segments) {
  let node = tree;
  for (const segment of segments) {
    node = node?.files?.[segment];
    if (!node) return null;
  }
  return node;
}

async function readPackedAsarFile(asar, segments, maximumBytes) {
  const entry = asarEntry(asar.tree, segments);
  if (
    !entry
    || entry.files
    || entry.link
    || entry.unpacked
    || !Number.isSafeInteger(entry.size)
    || entry.size < 0
    || entry.size > maximumBytes
    || typeof entry.offset !== "string"
    || !/^(?:0|[1-9]\d*)$/u.test(entry.offset)
  ) {
    throw new Error(`The packaged app has no bounded packed ${segments.join("/")} file.`);
  }
  const offset = Number(entry.offset);
  const position = 8 + asar.headerSize + offset;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(position)) {
    throw new Error(`The packaged ${segments.join("/")} file offset is invalid.`);
  }
  const content = Buffer.alloc(entry.size);
  const handle = await open(asar.archive, "r");
  try {
    const result = await handle.read(content, 0, entry.size, position);
    if (result.bytesRead !== entry.size) {
      throw new Error(`The packaged ${segments.join("/")} file was truncated.`);
    }
  } finally {
    await handle.close();
  }
  return content;
}

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function packagedUpdateCapability(manifest) {
  if (manifest.name !== (canary ? "inertia-canary" : "inertia")) {
    throw new Error("The packaged application name does not isolate the release channel.");
  }
  if (manifest.inertiaReleaseChannel !== releaseChannel) {
    throw new Error("The packaged app release channel does not match the smoke target.");
  }
  if (!Object.hasOwn(manifest, "inertiaUpdateCapability")) {
    return { delivery: "manual", reason: "capability-missing" };
  }
  const marker = manifest.inertiaUpdateCapability;
  if (exactKeys(marker, ["delivery", "reason"]) && marker.delivery === "manual") {
    if (typeof marker.reason === "string" && MANUAL_UPDATE_REASONS.has(marker.reason)) {
      return { delivery: "manual", reason: marker.reason };
    }
    throw new Error("The packaged app has an invalid manual update capability reason.");
  }
  if (
    exactKeys(marker, ["delivery", "platform"])
    && marker.delivery === "in-app"
    && ["darwin", "win32", "linux"].includes(marker.platform)
  ) {
    if (marker.platform !== process.platform) {
      throw new Error("The packaged app update capability targets a different platform.");
    }
    return { delivery: "in-app", platform: marker.platform };
  }
  throw new Error("The packaged app has an invalid update capability marker.");
}

async function boundedRegularFile(path, maximumBytes) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) {
    throw new Error(`The packaged ${path.split(/[\\/]/u).pop()} is invalid.`);
  }
  return readFile(path, "utf8");
}

function validPublisherName(value) {
  const names = typeof value === "string" ? [value] : value;
  return Array.isArray(names)
    && names.length > 0
    && names.length <= 8
    && names.every((name) => typeof name === "string"
      && name === name.trim()
      && Buffer.byteLength(name, "utf8") >= 1
      && Buffer.byteLength(name, "utf8") <= 512
      && !/[\u0000-\u001f\u007f]/u.test(name));
}

function validateUpdateConfiguration(source, capability) {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error("The packaged app-update.yml is invalid.");
  }
  const configuration = document.toJS({ maxAliasCount: 0 });
  if (
    !plainObject(configuration)
    || configuration.provider !== "generic"
    || configuration.url !== UPDATE_PROVIDER_URL
  ) {
    throw new Error("The packaged app-update.yml does not use the exact Inertia generic update provider.");
  }
  if (canary ? configuration.channel !== "canary" : configuration.channel !== undefined && configuration.channel !== "latest") {
    throw new Error("The packaged app-update.yml uses an unexpected channel.");
  }
  const expectedCache = canary ? "inertia-canary-updater" : "inertia-updater";
  if (configuration.updaterCacheDirName !== expectedCache) {
    throw new Error("The packaged app-update.yml does not isolate the updater cache.");
  }
  const allowedKeys = new Set([
    "provider",
    "url",
    "updaterCacheDirName",
    "channel",
    "useMultipleRangeRequest",
    "publisherName",
  ]);
  if (Object.keys(configuration).some((key) => !allowedKeys.has(key))) {
    throw new Error("The packaged app-update.yml contains an unsupported field.");
  }
  const signedWindows = capability.delivery === "in-app"
    && capability.platform === "win32";
  if (
    signedWindows
      ? !validPublisherName(configuration.publisherName)
      : configuration.publisherName !== undefined
  ) {
    throw new Error("The packaged app-update.yml has an invalid publisher identity.");
  }
}

async function requirePackagedAssets(executable) {
  const executableDirectory = dirname(executable);
  const explicitResources = boundedExactPathEnvironment("INERTIA_PACKAGE_SMOKE_RESOURCES");
  if (explicitResources) {
    const metadata = await lstat(explicitResources).catch(() => null);
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("INERTIA_PACKAGE_SMOKE_RESOURCES does not identify a direct resources directory.");
    }
  }
  const resourceCandidates = explicitResources
    ? [explicitResources]
    : [
        resolve(executableDirectory, "resources"),
        resolve(executableDirectory, "..", "Resources"),
      ];
  const resources = [];
  for (const candidate of resourceCandidates) {
    const archive = join(candidate, "app.asar");
    if (await lstat(archive).then(
      (value) => value.isFile() && !value.isSymbolicLink(),
      () => false,
    )) {
      resources.push({ directory: candidate, archive });
    }
  }
  if (resources.length !== 1) {
    throw new Error(`Expected exactly one packaged app.asar next to ${executable}; found ${resources.length}.`);
  }
  const [{ directory: resourcesDirectory, archive }] = resources;
  if (process.platform === "darwin") {
    const guardian = join(
      resourcesDirectory,
      "runtime",
      "runtime-process-guardian",
    );
    const metadata = await lstat(guardian).catch(() => null);
    if (
      !metadata
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.size <= 0
      || metadata.size > MAX_RUNTIME_GUARDIAN_BYTES
      || !await isExecutableFile(guardian)
    ) {
      throw new Error(
        "The packaged macOS runtime process guardian is missing or invalid.",
      );
    }
    console.log("Packaged macOS runtime process guardian verified.");
  }
  const asar = await readAsarArchive(archive);
  const tree = asar.tree;
  const client = asarEntry(tree, ["out", "private-connect"]);
  if (!client?.files) throw new Error("The packaged app.asar does not contain the Private Connect web client.");
  const names = Object.keys(client.files);
  for (const required of ["index.html", "manifest.webmanifest", "assets", "icons"]) {
    if (!names.includes(required)) {
      throw new Error(`The packaged Private Connect client is missing ${required}.`);
    }
  }
  const assets = Object.keys(client.files.assets?.files ?? {});
  const hashed = (extension) => assets.filter((name) =>
    name.endsWith(extension) && /[.-][A-Za-z0-9_-]{8,}\./u.test(name));
  if (hashed(".js").length === 0 || hashed(".css").length === 0) {
    throw new Error(`The packaged Private Connect client has no content-hashed assets: ${assets.join(", ") || "none"}.`);
  }
  const icons = Object.keys(client.files.icons?.files ?? {});
  if (icons.length === 0) throw new Error("The packaged Private Connect client has no icons.");
  const retired = Object.keys(tree.files ?? {}).filter((name) => /remote/iu.test(name));
  if (retired.length > 0) {
    throw new Error(`The packaged app still ships retired remote artifacts: ${retired.join(", ")}.`);
  }
  console.log(`Packaged Private Connect assets verified (${names.length} entries, ${assets.length} hashed assets, ${icons.length} icons).`);

  const manifestBytes = await readPackedAsarFile(
    asar,
    ["package.json"],
    MAX_PACKAGED_MANIFEST_BYTES,
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("The packaged package.json is invalid.");
  }
  if (!plainObject(manifest) || !plainObject(manifest.dependencies)) {
    throw new Error("The packaged package.json has no production dependency map.");
  }
  const declaredUpdaterVersion = manifest.dependencies["electron-updater"];
  if (
    typeof declaredUpdaterVersion !== "string"
    || !STABLE_VERSION_PATTERN.test(declaredUpdaterVersion)
  ) {
    throw new Error("The packaged app does not pin electron-updater to a stable production version.");
  }
  const updaterManifestBytes = await readPackedAsarFile(
    asar,
    ["node_modules", "electron-updater", "package.json"],
    MAX_PACKAGED_MANIFEST_BYTES,
  );
  let updaterManifest;
  try {
    updaterManifest = JSON.parse(updaterManifestBytes.toString("utf8"));
  } catch {
    throw new Error("The packaged electron-updater manifest is invalid.");
  }
  if (
    !plainObject(updaterManifest)
    || updaterManifest.name !== "electron-updater"
    || updaterManifest.version !== declaredUpdaterVersion
    || updaterManifest.main !== "out/main.js"
    || !asarEntry(tree, ["node_modules", "electron-updater", "out", "main.js"])
  ) {
    throw new Error("The externalized electron-updater production package is incomplete.");
  }
  const mainBundle = await readPackedAsarFile(
    asar,
    ["out", "main", "index.js"],
    MAX_MAIN_BUNDLE_BYTES,
  );
  if (!mainBundle.includes(Buffer.from("electron-updater", "utf8"))) {
    throw new Error("The packaged main process does not retain the external electron-updater boundary.");
  }

  const capability = packagedUpdateCapability(manifest);
  const updateConfiguration = await boundedRegularFile(
    join(resourcesDirectory, "app-update.yml"),
    MAX_UPDATE_CONFIG_BYTES,
  );
  if (capability.delivery === "in-app") {
    if (updateConfiguration === null) {
      throw new Error("An in-app update-capable package is missing resources/app-update.yml.");
    }
  }
  if (updateConfiguration !== null) {
    validateUpdateConfiguration(updateConfiguration, capability);
  }
  console.log(
    capability.delivery === "in-app"
      ? `Packaged in-app updater verified (${declaredUpdaterVersion}, ${capability.platform}).`
      : `Packaged manual updater fallback verified (${declaredUpdaterVersion}, ${capability.reason}).`,
  );
}

async function createUpdateNetworkTrap() {
  const updateHosts = new Set([
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "release-assets.githubusercontent.com",
  ]);
  const updateAttempts = [];
  const requestTarget = (request) => {
    const rawTarget = request.url ?? "";
    try {
      const url = new URL(
        request.method === "CONNECT" ? `https://${rawTarget}` : rawTarget,
      );
      return updateHosts.has(url.hostname.toLowerCase())
        ? `${request.method ?? "GET"} ${rawTarget}`
        : null;
    } catch {
      return null;
    }
  };
  const recordUpdateAttempt = (request) => {
    const target = requestTarget(request);
    if (target) updateAttempts.push(target);
  };
  const server = createServer((request, response) => {
    recordUpdateAttempt(request);
    response.writeHead(502, { "Content-Type": "text/plain" });
    response.end("Package smoke blocks external network access.\n");
  });
  server.on("connect", (request, socket) => {
    recordUpdateAttempt(request);
    socket.end();
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The package-smoke network trap did not receive a local port.");
  }
  return {
    proxy: `http://127.0.0.1:${address.port}`,
    assertNoUpdateRequests() {
      if (updateAttempts.length > 0) {
        throw new Error(
          `The packaged test app attempted update network access: ${updateAttempts.join(", ")}.`,
        );
      }
    },
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function locatePackagedExecutable() {
  const explicitExecutable = boundedExactPathEnvironment("INERTIA_PACKAGE_SMOKE_EXECUTABLE");
  if (explicitExecutable !== undefined) {
    const candidate = explicitExecutable;
    const metadata = await lstat(candidate).catch(() => null);
    if (
      metadata === null
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || !await isExecutableFile(candidate)
    ) {
      throw new Error("INERTIA_PACKAGE_SMOKE_EXECUTABLE does not identify an executable regular file.");
    }
    return candidate;
  }
  const releaseDirectory = resolve("release");
  const architectureSuffix = process.arch === "x64" ? "" : `-${process.arch}`;
  const candidates = process.platform === "darwin"
    ? [
        join(releaseDirectory, `mac-${process.arch}`, `${canary ? "Inertia Canary" : "Inertia"}.app`, "Contents", "MacOS", canary ? "Inertia Canary" : "Inertia"),
        join(releaseDirectory, "mac", `${canary ? "Inertia Canary" : "Inertia"}.app`, "Contents", "MacOS", canary ? "Inertia Canary" : "Inertia"),
      ]
    : process.platform === "win32"
      ? [join(
          releaseDirectory,
          `win${architectureSuffix}-unpacked`,
          canary ? "Inertia Canary.exe" : "Inertia.exe",
        )]
      : process.platform === "linux"
        ? [join(
            releaseDirectory,
            `linux${architectureSuffix}-unpacked`,
            canary ? "inertia-canary" : "inertia",
          )]
        : [];
  const matches = [];
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one packaged executable for ${process.platform}/${process.arch}; found ${matches.length}.`);
  }
  return matches[0];
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function processGroupExists(pid) {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function processGroupId(pid) {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
    maxBuffer: 1_024,
    timeout: 1_000,
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const group = Number(value);
  return Number.isSafeInteger(group) ? group : null;
}

function forceTerminateProcessTree(launcherPid, mainPid, runtimePid) {
  const validPids = [...new Set([mainPid, runtimePid].filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (process.platform === "win32") {
    for (const pid of validPids) {
      if (processExists(pid)) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
    return;
  }
  if (Number.isSafeInteger(launcherPid) && launcherPid > 0 && processGroupExists(launcherPid)) {
    try { process.kill(-launcherPid, "SIGKILL"); } catch { /* The process group may already be gone. */ }
  }
  for (const pid of validPids) {
    if (!processExists(pid)) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* The process may already be gone. */ }
  }
}

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await predicate();
    if (value) return value;
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForObservedProcessExit(pid) {
  while (processExists(pid)) await sleep(POLL_INTERVAL_MS);
  return { error: null, code: 0, signal: null, endedAt: Date.now() };
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function createWindowsCodexFixture(root, workspace) {
  if (process.platform !== "win32") return null;
  const profile = join(root, "Packaged Codex Ω (profile)");
  // Native executable relocation and Unicode npm shims are covered
  // independently. Keep the synthetic native binary in an ASCII path so this
  // smoke isolates the packaged utility-process and provider boundaries.
  const directory = join(root, "codex-bin");
  const command = join(directory, "codex.exe");
  const login = join(workspace, "login");
  const appServer = join(workspace, "app-server");
  await mkdir(directory, { recursive: true });
  await copyFile(process.execPath, command);
  await writeFile(login, `
const args = process.argv.slice(2);
if (args[0] === "status") { console.log("Logged in using ChatGPT"); process.exit(0); }
process.exit(2);
`.trimStart(), "utf8");
  await writeFile(appServer, `
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--help") { console.log("codex app-server - Run the app server"); process.exit(0); }
if (args.length !== 0) process.exit(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "package-smoke" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null } });
  return send({ id: message.id, error: { code: -32601, message: "Unsupported package-smoke method" } });
});
`.trimStart(), "utf8");
  return { command, directory, profile };
}

async function createPdfFixture(root) {
  const inputPath = join(root, "package-smoke.pdf");
  const resultPath = join(root, "package-smoke-pdf-result.json");
  const text = "Packaged PDF extraction works";
  const stream = `BT /F1 22 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
      + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  await writeFile(inputPath, pdf, "ascii");
  return { inputPath, resultPath, text };
}

async function createImageFixture(root) {
  const inputPath = join(root, "package-smoke.png");
  const resultPath = join(root, "package-smoke-image-result.json");
  const bytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  await writeFile(inputPath, bytes);
  return { inputPath, resultPath };
}

async function requirePackagedCodex(websocketUrl, expectedExecutable) {
  const canonicalExpectedExecutable = await realpath(expectedExecutable);
  await new Promise((resolveCodex, rejectCodex) => {
    const socket = new WebSocket(websocketUrl, { headers: { Origin: "http://127.0.0.1" } });
    const refreshRequestId = randomUUID();
    let refreshRequested = false;
    let refreshAcknowledged = false;
    let lastProviderState = "no provider snapshot";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) rejectCodex(error);
      else resolveCodex();
    };
    const timer = setTimeout(() => {
      finish(new Error(`Packaged runtime did not discover the Windows Codex shim (${lastProviderState}; refresh requested: ${refreshRequested}; acknowledged: ${refreshAcknowledged}).`));
    }, 8_000);
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Packaged runtime closed before Codex discovery completed."));
    });
    socket.on("message", (data) => {
      let frame;
      try { frame = JSON.parse(data.toString("utf8")); } catch { return; }
      const event = frame?.type === "runtime.event" ? frame.event : frame;
      if (event?.type === "request.ok" && event.requestId === refreshRequestId) {
        refreshAcknowledged = true;
        return;
      }
      if (event?.type === "request.error" && event.requestId === refreshRequestId) {
        finish(new Error(`Packaged Codex refresh failed: ${event.message || "unknown error"}.`));
        return;
      }
      if (event?.type !== "server.welcome" && event?.type !== "snapshot.updated") return;
      const provider = event.snapshot?.providers?.find(({ id }) => id === "codex");
      lastProviderState = provider
        ? `${provider.installState}/${provider.authState}/canRun=${provider.canRun}`
        : "Codex missing from snapshot";
      if (!provider || provider.installState === "checking") {
        if (!refreshRequested) {
          refreshRequested = true;
          socket.send(JSON.stringify({
            type: "provider.refresh",
            requestId: refreshRequestId,
            payload: { providerId: "codex" },
          }));
        }
        return;
      }
      if (provider.installState !== "installed" || provider.canRun !== true) {
        finish(new Error(`Packaged Codex discovery reported ${provider.statusMessage || provider.installState}.`));
        return;
      }
      if (resolve(provider.executable || "").toLocaleLowerCase("en-US") !== resolve(canonicalExpectedExecutable).toLocaleLowerCase("en-US")) {
        finish(new Error(`Packaged Codex discovery selected an unexpected executable: ${provider.executable || "none"}.`));
        return;
      }
      finish();
    });
  });
}

async function requireLifecycleMarker(
  markerPath,
  stage,
  mainPid,
  ownerToken,
  timeoutMs = 2_000,
) {
  const value = await waitUntil(
    () => readJsonIfPresent(`${markerPath}.${stage}.json`),
    timeoutMs,
    `${stage} lifecycle marker`,
  );
  if (
    value.stage !== stage
    || value.pid !== mainPid
    || value.ownerToken !== ownerToken
    || !Number.isSafeInteger(value.timestampMs)
    || value.timestampMs <= 0
  ) throw new Error(`Invalid ${stage} lifecycle marker.`);
  return value;
}

function appendOutput(current, chunk) {
  const combined = current + chunk.toString("utf8");
  return combined.length <= MAX_OUTPUT_LENGTH ? combined : combined.slice(-MAX_OUTPUT_LENGTH);
}

const executable = await locatePackagedExecutable();
const requestedPackageKind = process.env.INERTIA_PACKAGE_SMOKE_KIND;
if (requestedPackageKind !== undefined && !PACKAGE_KINDS.has(requestedPackageKind)) {
  throw new Error("INERTIA_PACKAGE_SMOKE_KIND must identify a reviewed package path.");
}
await requirePackagedAssets(executable);
const supervisorRoot = boundedExactPathEnvironment("INERTIA_PACKAGE_SMOKE_SUPERVISOR_ROOT");
const supervisorProcessGroupFile = boundedExactPathEnvironment(
  "INERTIA_PACKAGE_SMOKE_PROCESS_GROUP_FILE",
);
const supervisorProcessGroupToken = process.env.INERTIA_PACKAGE_SMOKE_PROCESS_GROUP_TOKEN;
const supervisedProcessGroup = process.platform !== "win32"
  && supervisorRoot !== undefined
  && supervisorProcessGroupFile !== undefined
  && isPackageSmokeOwnerToken(supervisorProcessGroupToken);
if (
  (supervisorRoot !== undefined || supervisorProcessGroupFile !== undefined || supervisorProcessGroupToken !== undefined)
  && !supervisedProcessGroup
) throw new Error("Detached package-smoke supervision requires an exact root, handoff file, and owner token.");
if (supervisorRoot !== undefined) {
  const supervisorMetadata = await lstat(supervisorRoot).catch(() => null);
  if (
    supervisorMetadata === null
    || supervisorMetadata.isSymbolicLink()
    || !supervisorMetadata.isDirectory()
    || (supervisorMetadata.mode & 0o077) !== 0
    || supervisorMetadata.uid !== process.geteuid()
  ) throw new Error("The package-smoke supervisor root is not an owner-private direct directory.");
  if (dirname(supervisorProcessGroupFile) !== supervisorRoot) {
    throw new Error("The package-smoke process-group handoff must be directly inside its supervisor root.");
  }
  const handoffMetadata = lstatSync(supervisorProcessGroupFile);
  const handoffRequest = JSON.parse(readFileSync(supervisorProcessGroupFile, "utf8"));
  if (
    handoffMetadata.isSymbolicLink()
    || !handoffMetadata.isFile()
    || handoffMetadata.uid !== process.geteuid()
    || (handoffMetadata.mode & 0o077) !== 0
    || handoffMetadata.size > 4 * 1024
    || handoffRequest?.state !== "pending"
    || handoffRequest?.ownerToken !== supervisorProcessGroupToken
  ) throw new Error("The package-smoke process-group handoff request is invalid.");
}
const temporaryRoot = await mkdtemp(join(supervisorRoot ?? tmpdir(), "inertia-package-smoke-"));
const markerPath = join(temporaryRoot, "ready.json");
const dataDirectory = join(temporaryRoot, "data");
const workspaceDirectory = join(temporaryRoot, "workspace");
const profileDirectory = join(temporaryRoot, "profile");
let child = null;
let readiness = null;
let cleanupOwnedPids = null;
let stdout = "";
let stderr = "";
let launchedAt = 0;
const ownerToken = randomUUID();
const launchMode = resolvePackageSmokeLaunchMode({
  configuredMode: process.env.INERTIA_PACKAGE_SMOKE_LAUNCH_MODE,
  extractAndRun: process.env.APPIMAGE_EXTRACT_AND_RUN,
  packageKind: requestedPackageKind,
});
const updateNetworkTrap = await createUpdateNetworkTrap();

try {
  await Promise.all([
    mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
    mkdir(workspaceDirectory, { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ]);
  if (process.platform !== "win32") {
    const dataRoot = await stat(dataDirectory);
    if (
      !dataRoot.isDirectory()
      || dataRoot.uid !== process.geteuid()
      || (dataRoot.mode & 0o077) !== 0
    ) throw new Error("The package-smoke runtime data root is not owner-private.");
  }
  const packagedCodex = await createWindowsCodexFixture(temporaryRoot, workspaceDirectory);
  const packagedPdf = await createPdfFixture(temporaryRoot);
  const packagedImage = await createImageFixture(temporaryRoot);
  // This smoke does not exercise credential persistence. Keep macOS package
  // and shutdown checks independent from the automation host's Keychain.
  const launchArguments = [
    `--user-data-dir=${profileDirectory}`,
    `--proxy-server=${updateNetworkTrap.proxy}`,
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ...(process.platform === "linux" && process.env.INERTIA_PACKAGE_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  ];
  launchedAt = Date.now();
  if (supervisedProcessGroup) writeFileSync(supervisorProcessGroupFile, `${JSON.stringify({
    ownerToken: supervisorProcessGroupToken,
    state: "launching",
    supervisorPid: process.pid,
    timestampMs: launchedAt,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  child = spawn(executable, launchArguments, {
    detached: packagedAppUsesDetachedProcessGroup(process.platform),
    env: {
      ...packageSmokeChildEnvironment(process.env),
      NODE_ENV: "test",
      INERTIA_DATA_DIR: dataDirectory,
      INERTIA_WORKSPACE_DIR: workspaceDirectory,
      INERTIA_PACKAGE_SMOKE_FILE: markerPath,
      INERTIA_PACKAGE_SMOKE_OWNER_TOKEN: ownerToken,
      INERTIA_PACKAGE_SMOKE_PDF_INPUT: packagedPdf.inputPath,
      INERTIA_PACKAGE_SMOKE_PDF_RESULT: packagedPdf.resultPath,
      INERTIA_PACKAGE_SMOKE_IMAGE_INPUT: packagedImage.inputPath,
      INERTIA_PACKAGE_SMOKE_IMAGE_RESULT: packagedImage.resultPath,
      ...(packagedCodex ? {
        INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED: packagedCodex.command,
        APPDATA: packagedCodex.profile,
        LOCALAPPDATA: join(packagedCodex.profile, "Local"),
        USERPROFILE: packagedCodex.profile,
        CODEX_HOME: "",
        CODEX_INSTALL_DIR: "",
        PNPM_HOME: "",
        BUN_INSTALL: "",
        VOLTA_HOME: "",
        PATH: packagedCodex.directory,
        PATHEXT: ".EXE;.CMD;.BAT",
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (supervisedProcessGroup) {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error("The detached package-smoke process group was not created.");
    }
    writeFileSync(supervisorProcessGroupFile, `${JSON.stringify({
      ownerToken: supervisorProcessGroupToken,
      processGroupId: child.pid,
      state: "owned",
      supervisorPid: process.pid,
      timestampMs: Date.now(),
    })}\n`, { encoding: "utf8", mode: 0o600 });
  }
  child.stdout?.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
  child.stderr?.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });

  const exitResult = new Promise((settle) => {
    child.once("error", (error) => settle({
      error,
      code: null,
      signal: null,
      endedAt: Date.now(),
    }));
    child.once("exit", (code, signal) => settle({
      error: null,
      code,
      signal,
      endedAt: Date.now(),
    }));
  });
  readiness = await waitForPackageSmokeReadiness({
    launchMode,
    launcherExit: exitResult,
    launcherTimeoutMs: STARTUP_TIMEOUT_MS,
    waitForReadiness: () => waitUntil(async () => {
      const marker = await readJsonIfPresent(markerPath);
      const parseOptions = {
        launchMode,
        launchedAt,
        launcherPid: child.pid,
        ownedProcessGroupId: process.platform === "win32" ? null : child.pid,
        ownerToken,
        processExists,
        processGroupId,
      };
      cleanupOwnedPids = parsePackageSmokeOwnedPids(marker, parseOptions) ?? cleanupOwnedPids;
      const candidate = parsePackageSmokeReadiness(marker, parseOptions);
      return candidate ?? null;
    }, STARTUP_TIMEOUT_MS, "packaged app and utility runtime readiness"),
  });
  const mainExitResult = launchMode === "direct-app"
    ? exitResult
    : waitForObservedProcessExit(readiness.mainPid);
  const runtimeWasObserved = processExists(readiness.runtimePid);
  const pdfResult = await waitUntil(
    () => readJsonIfPresent(packagedPdf.resultPath),
    PACKAGED_PDF_TIMEOUT_MS,
    "packaged PDF extraction result",
  );
  if (
    pdfResult.ok !== true
    || typeof pdfResult.content !== "string"
    || !pdfResult.content.includes(packagedPdf.text)
  ) {
    throw new Error(`The packaged PDF stack failed: ${pdfResult.message || "invalid smoke result"}.`);
  }
  const imageResult = await waitUntil(
    () => readJsonIfPresent(packagedImage.resultPath),
    STARTUP_TIMEOUT_MS,
    "packaged durable image retention result",
  );
  if (imageResult.ok !== true) {
    throw new Error(`The packaged image retention path failed: ${imageResult.message || "invalid smoke result"}.`);
  }
  if (packagedCodex) await requirePackagedCodex(readiness.websocketUrl, packagedCodex.command);

  // Provider discovery deliberately keeps the packaged app alive before
  // shutdown. Start the exit deadline only after Electron begins quitting so
  // that dwell time cannot consume the process-tree cleanup budget.
  const beforeQuit = await requireLifecycleMarker(
    markerPath,
    "before-quit",
    readiness.mainPid,
    ownerToken,
    EXIT_TIMEOUT_MS,
  );
  const shutdownStartedAt = beforeQuit.timestampMs;
  const exit = await withTimeout(
    waitForPackageSmokeExit({
      beforeQuitTimestampMs: shutdownStartedAt,
      launchMode,
      launcherExit: exitResult,
      mainExit: mainExitResult,
      mainProcessExists: () => processExists(readiness.mainPid),
    }),
    EXIT_TIMEOUT_MS,
    "The packaged app did not finish shutdown after before-quit.",
  );
  if (exit.error) throw exit.error;
  await requireLifecycleMarker(markerPath, "runtime-stopped", readiness.mainPid, ownerToken);
  await requireLifecycleMarker(markerPath, "app-exit", readiness.mainPid, ownerToken);

  await waitUntil(
    () => !processExists(readiness.mainPid) && !processExists(readiness.runtimePid),
    CLEANUP_TIMEOUT_MS,
    "main and utility runtime process cleanup",
  );
  if (process.platform !== "win32") await waitUntil(
    () => packageSmokeProcessesExited({
      launcherPid: child.pid,
      ownedProcessGroupId: child.pid,
      mainPid: readiness.mainPid,
      runtimePid: readiness.runtimePid,
      processExists,
      processGroupExists,
    }),
    CLEANUP_TIMEOUT_MS,
    "packaged app process-group cleanup",
  );
  const cleanupCompletedAt = Date.now();
  updateNetworkTrap.assertNoUpdateRequests();
  const benchmark = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    packageKind: requestedPackageKind
      ?? (process.platform === "linux"
        ? "linux-unpacked"
        : process.platform === "darwin"
          ? "macos-unpacked"
          : "windows-unpacked"),
    signingState: process.platform === "darwin" ? "ci-ad-hoc-or-local" : "not-recorded",
    launchToRuntimeReadyMs: readiness.timestampMs - launchedAt,
    shutdownToProcessExitMs: exit.endedAt - shutdownStartedAt,
    postExitCleanupMs: cleanupCompletedAt - exit.endedAt,
    mainPid: readiness.mainPid,
    runtimePid: readiness.runtimePid,
    generation: readiness.generation,
  };
  const benchmarkReport = process.env.INERTIA_PACKAGE_BENCHMARK_REPORT;
  if (benchmarkReport) {
    const target = resolve(benchmarkReport);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(benchmark, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  console.log(`Packaged smoke passed (${process.platform}/${process.arch}); main=${readiness.mainPid}, runtime=${readiness.runtimePid}, generation=${readiness.generation}, runtimeObserved=${runtimeWasObserved}, pdfExtraction=true, imageRetention=true, launchToReadyMs=${benchmark.launchToRuntimeReadyMs}, shutdownMs=${benchmark.shutdownToProcessExitMs}, exit=${exit.code ?? exit.signal ?? "unknown"}.`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (stdout.trim()) console.error(`Packaged app stdout:\n${stdout.trim()}`);
  if (stderr.trim()) console.error(`Packaged app stderr:\n${stderr.trim()}`);
  if (readiness) {
    const lifecycle = Object.fromEntries(await Promise.all(
      ["before-quit", "runtime-stopped", "app-exit"].map(async (stage) => [
        stage,
        Boolean(await readJsonIfPresent(`${markerPath}.${stage}.json`)),
      ]),
    ));
    console.error("Packaged app lifecycle:", {
      mainAlive: processExists(readiness.mainPid),
      runtimeAlive: processExists(readiness.runtimePid),
      lifecycle,
      ...(process.platform !== "win32"
        ? {
            mainProcess: spawnSync(
              "ps",
              ["-o", "pid=,ppid=,state=,command=", "-p", String(readiness.mainPid)],
              { encoding: "utf8" },
            ).stdout.trim(),
          }
        : {}),
    });
  } else if (child) {
    const marker = await readJsonIfPresent(markerPath);
    const mainPid = Number.isSafeInteger(marker?.mainPid) ? marker.mainPid : null;
    const runtimePid = Number.isSafeInteger(marker?.runtimePid) ? marker.runtimePid : null;
    console.error("Packaged readiness diagnostics:", {
      launchMode,
      launcherAlive: processExists(child.pid),
      launcherPid: child.pid,
      markerPresent: marker !== null,
      mainAlive: mainPid === null ? null : processExists(mainPid),
      mainPid,
      mainProcessGroupId: mainPid === null ? null : processGroupId(mainPid),
      ownedProcessGroupId: child.pid,
      runtimeAlive: runtimePid === null ? null : processExists(runtimePid),
      runtimePid,
      runtimeProcessGroupId: runtimePid === null ? null : processGroupId(runtimePid),
    });
  }
  throw new Error(`Packaged smoke failed: ${detail}`, { cause: error });
} finally {
  const mainPid = readiness?.mainPid ?? cleanupOwnedPids?.mainPid ?? child?.pid ?? null;
  const runtimePid = readiness?.runtimePid ?? cleanupOwnedPids?.runtimePid ?? null;
  const launchedPid = child?.pid ?? null;
  const ownedProcessGroupId = launchedPid;
  if ((ownedProcessGroupId && processGroupExists(ownedProcessGroupId)) || (mainPid && processExists(mainPid)) || (runtimePid && processExists(runtimePid))) {
    forceTerminateProcessTree(ownedProcessGroupId, mainPid, runtimePid);
    await waitUntil(
      () => packageSmokeProcessesExited({
        launcherPid: launchedPid,
        ownedProcessGroupId,
        mainPid,
        runtimePid,
        processExists,
        processGroupExists,
      }),
      CLEANUP_TIMEOUT_MS,
      "forced packaged process cleanup",
    );
  }
  await updateNetworkTrap.close();
  if (supervisedProcessGroup && launchedPid !== null) {
    writeFileSync(supervisorProcessGroupFile, `${JSON.stringify({
      ownerToken: supervisorProcessGroupToken,
      processGroupId: launchedPid,
      state: "released",
      supervisorPid: process.pid,
      timestampMs: Date.now(),
    })}\n`, { encoding: "utf8", mode: 0o600 });
  }
  if (!supervisedProcessGroup) {
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      // Chromium can briefly retain profile WAL handles after its owning
      // process exits on Windows. Keep cleanup bounded while allowing the OS to
      // release those handles instead of turning a successful smoke into EBUSY.
      maxRetries: process.platform === "win32" ? 10 : 0,
      retryDelay: 100,
    });
  }
}
