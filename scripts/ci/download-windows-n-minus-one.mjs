import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "eduardtomas1/inertia";
const MAX_RELEASE_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_CHECKSUM_BYTES = 64 * 1_024;
const MAX_INSTALLER_BYTES = 512 * 1_024 * 1_024;
const CONNECT_TIMEOUT_MS = 30_000;
const TEXT_BODY_TIMEOUT_MS = 60_000;
const INSTALLER_BODY_TIMEOUT_MS = 10 * 60_000;
const MAX_REQUEST_TIMEOUT_MS = 15 * 60_000;
const GITHUB_JSON_ACCEPT = "application/vnd.github+json";
const GITHUB_ASSET_ACCEPT = "application/octet-stream";
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function versionTuple(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("The release version is not an exact stable semantic version.");
  }
  return version.split(".").map(Number);
}

export function compareReleaseVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function windowsReleaseAssetName(version, channel, architecture) {
  versionTuple(version);
  if (channel !== "stable" && channel !== "canary") {
    throw new Error("The release channel is invalid.");
  }
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error("The release architecture is invalid.");
  }
  const prefix = channel === "canary"
    ? "Inertia.Canary.Setup"
    : "Inertia.Setup";
  return `${prefix}.${version}${architecture === "arm64" ? ".arm64" : ""}.exe`;
}

function releaseVersion(tag, channel) {
  const prefix = channel === "canary" ? "canary-v" : "v";
  if (typeof tag !== "string" || !tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  return VERSION_PATTERN.test(version) ? version : null;
}

function releaseAssetDownloadUrl(value, tag, assetName) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const expectedPath = `/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  if (
    url.origin !== "https://github.com"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== expectedPath
    || url.search !== ""
    || url.hash !== ""
  ) return null;
  return url.href;
}

export function selectWindowsNMinusOneRelease(
  releases,
  currentVersion,
  channel,
  architecture,
) {
  versionTuple(currentVersion);
  if (!Array.isArray(releases) || releases.length > 100) {
    throw new Error("The GitHub release response is invalid or unbounded.");
  }
  const candidates = releases.flatMap((release) => {
    if (
      !release
      || typeof release !== "object"
      || release.draft === true
      || (channel === "stable" && release.prerelease === true)
    ) return [];
    const version = releaseVersion(release.tag_name, channel);
    if (!version || compareReleaseVersions(version, currentVersion) >= 0) {
      return [];
    }
    const expectedAsset = windowsReleaseAssetName(
      version,
      channel,
      architecture,
    );
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const installer = assets.find((asset) => asset?.name === expectedAsset);
    const checksums = assets.find((asset) => asset?.name === "SHA256SUMS.txt");
    const installerUrl = releaseAssetDownloadUrl(
      installer?.browser_download_url,
      release.tag_name,
      expectedAsset,
    );
    const checksumsUrl = releaseAssetDownloadUrl(
      checksums?.browser_download_url,
      release.tag_name,
      "SHA256SUMS.txt",
    );
    if (
      !installer
      || !checksums
      || installerUrl === null
      || checksumsUrl === null
      || !Number.isSafeInteger(installer.size)
      || installer.size <= 0
      || installer.size > MAX_INSTALLER_BYTES
    ) return [];
    return [{
      tag: release.tag_name,
      version,
      assetName: expectedAsset,
      assetSize: installer.size,
      installerUrl,
      checksumsUrl,
    }];
  }).sort((left, right) =>
    compareReleaseVersions(right.version, left.version));
  const selected = candidates[0];
  if (!selected) {
    throw new Error("No complete packaged Windows N-1 release is available.");
  }
  return selected;
}

export function releaseAssetChecksum(contents, assetName) {
  if (
    typeof contents !== "string"
    || Buffer.byteLength(contents, "utf8") > MAX_CHECKSUM_BYTES
    || basename(assetName) !== assetName
  ) throw new Error("The release checksum manifest is invalid.");
  const matching = contents
    .split(/\r?\n/u)
    .map((line) => /^([0-9a-f]{64}) {2}([^\0\r\n]+)$/u.exec(line))
    .filter((match) => match?.[2] === assetName);
  if (matching.length !== 1 || !DIGEST_PATTERN.test(matching[0][1])) {
    throw new Error("The N-1 installer has no unique release checksum.");
  }
  return matching[0][1];
}

function requestTimeouts(options, bodyDefault) {
  const connectTimeoutMs = options?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const bodyTimeoutMs = options?.bodyTimeoutMs ?? bodyDefault;
  for (const [label, value] of [
    ["connect", connectTimeoutMs],
    ["body", bodyTimeoutMs],
  ]) {
    if (
      !Number.isSafeInteger(value)
      || value <= 0
      || value > MAX_REQUEST_TIMEOUT_MS
    ) throw new Error(`The GitHub ${label} timeout is invalid.`);
  }
  return { bodyTimeoutMs, connectTimeoutMs };
}

async function beforeDeadline(promise, timeoutMs, controller, message) {
  let timer;
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    timer = setTimeout(() => {
      settle(rejectPromise, new Error(message));
      controller.abort();
    }, timeoutMs);
    promise.then(
      (value) => settle(resolvePromise, value),
      (error) => settle(rejectPromise, error),
    );
  });
}

async function responseWithDeadline(url, token, accept, connectTimeoutMs) {
  const controller = new AbortController();
  try {
    const response = await beforeDeadline(fetch(url, {
      headers: {
        Accept: accept,
        "User-Agent": "inertia-lifecycle-certification",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "follow",
      signal: controller.signal,
    }), connectTimeoutMs, controller, "The GitHub connection timed out.");
    return { controller, response };
  } catch (error) {
    controller.abort();
    throw error;
  }
}

async function readBeforeBodyDeadline(reader, deadline, controller) {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) {
    controller.abort();
    throw new Error("The GitHub response body timed out.");
  }
  return await beforeDeadline(
    reader.read(),
    remaining,
    controller,
    "The GitHub response body timed out.",
  );
}

export async function fetchBoundedText(
  url,
  maximumBytes,
  token,
  accept,
  timeoutOptions,
) {
  const { bodyTimeoutMs, connectTimeoutMs } = requestTimeouts(
    timeoutOptions,
    TEXT_BODY_TIMEOUT_MS,
  );
  const { controller, response } = await responseWithDeadline(
    url,
    token,
    accept,
    connectTimeoutMs,
  );
  try {
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) {
      throw new Error("The GitHub response exceeds its bounded size.");
    }
    if (!response.body) throw new Error("The GitHub response has no body.");
    const chunks = [];
    let received = 0;
    const reader = response.body.getReader();
    const deadline = Date.now() + bodyTimeoutMs;
    while (true) {
      const { done, value } = await readBeforeBodyDeadline(
        reader,
        deadline,
        controller,
      );
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        controller.abort();
        void reader.cancel().catch(() => {});
        throw new Error("The GitHub response exceeds its bounded size.");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, received).toString("utf8");
  } finally {
    controller.abort();
  }
}

export async function downloadBoundedFile(
  url,
  destination,
  expectedBytes,
  token,
  timeoutOptions,
) {
  const { bodyTimeoutMs, connectTimeoutMs } = requestTimeouts(
    timeoutOptions,
    INSTALLER_BODY_TIMEOUT_MS,
  );
  const { controller, response } = await responseWithDeadline(
    url,
    token,
    GITHUB_ASSET_ACCEPT,
    connectTimeoutMs,
  );
  try {
    if (!response.ok || !response.body) {
      throw new Error(`GitHub returned HTTP ${response.status}.`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declared)
      && (declared !== expectedBytes || declared > MAX_INSTALLER_BYTES)
    ) throw new Error("The N-1 installer response size does not match its release metadata.");
    const partial = `${destination}.partial-${process.pid}`;
    await rm(partial, { force: true });
    const handle = await open(partial, "wx", 0o600);
    let written = 0;
    let completed = false;
    const reader = response.body.getReader();
    try {
      const deadline = Date.now() + bodyTimeoutMs;
      while (true) {
        const { done, value } = await readBeforeBodyDeadline(
          reader,
          deadline,
          controller,
        );
        if (done) break;
        written += value.byteLength;
        if (written > MAX_INSTALLER_BYTES || written > expectedBytes) {
          throw new Error("The N-1 installer download exceeded its declared size.");
        }
        await handle.write(value);
      }
      await handle.sync();
      completed = true;
    } finally {
      await handle.close();
      if (!completed) await rm(partial, { force: true });
    }
    if (written !== expectedBytes) {
      await rm(partial, { force: true });
      throw new Error("The N-1 installer download was truncated.");
    }
    await rename(partial, destination);
  } finally {
    controller.abort();
  }
}

async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function exactOption(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index < 0 || index === arguments_.length - 1) {
    throw new Error(`Missing required ${name} option.`);
  }
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`The ${name} option is invalid.`);
  }
  return value;
}

export async function main(arguments_ = process.argv.slice(2)) {
  const expectedOptions = new Set([
    "--architecture",
    "--channel",
    "--current-version",
    "--output-directory",
  ]);
  if (
    arguments_.length !== expectedOptions.size * 2
    || arguments_.some((value, index) =>
      index % 2 === 0 ? !expectedOptions.has(value) : value.startsWith("--"))
  ) throw new Error("The N-1 download options are invalid.");
  const currentVersion = exactOption(arguments_, "--current-version");
  const channel = exactOption(arguments_, "--channel");
  const architecture = exactOption(arguments_, "--architecture");
  const outputDirectory = resolve(exactOption(arguments_, "--output-directory"));
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const releasesSource = await fetchBoundedText(
    `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`,
    MAX_RELEASE_RESPONSE_BYTES,
    token,
    GITHUB_JSON_ACCEPT,
  );
  const selected = selectWindowsNMinusOneRelease(
    JSON.parse(releasesSource),
    currentVersion,
    channel,
    architecture,
  );
  const checksumSource = await fetchBoundedText(
    selected.checksumsUrl,
    MAX_CHECKSUM_BYTES,
    token,
    GITHUB_ASSET_ACCEPT,
  );
  const checksum = releaseAssetChecksum(checksumSource, selected.assetName);
  await mkdir(outputDirectory, { recursive: true });
  const outputMetadata = await lstat(outputDirectory);
  if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) {
    throw new Error("The N-1 download directory is invalid.");
  }
  const installerPath = resolve(outputDirectory, selected.assetName);
  if (dirname(installerPath) !== outputDirectory) {
    throw new Error("The N-1 installer escaped its output directory.");
  }
  await downloadBoundedFile(
    selected.installerUrl,
    installerPath,
    selected.assetSize,
    token,
  );
  const actualChecksum = await sha256File(installerPath);
  if (actualChecksum !== checksum) {
    await rm(installerPath, { force: true });
    throw new Error("The downloaded N-1 installer checksum does not match the release.");
  }
  const metadataPath = resolve(outputDirectory, "metadata.json");
  await writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    repository: REPOSITORY,
    tag: selected.tag,
    version: selected.version,
    currentVersion,
    channel,
    architecture,
    assetName: selected.assetName,
    byteLength: selected.assetSize,
    sha256: checksum,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(
    `Downloaded checksummed Windows N-1 artifact ${selected.assetName} (${checksum}).`,
  );
  return metadataPath;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
