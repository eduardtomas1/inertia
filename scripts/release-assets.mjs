import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { parseDocument, stringify } from "yaml";

const MAX_UPDATE_METADATA_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_DOCUMENT_DEPTH = 8;
const MAX_DOCUMENT_NODES = 256;
const MAX_STRING_BYTES = 32 * 1024;
const MAX_PACKAGED_MANIFEST_BYTES = 256 * 1024;
const MAX_ASAR_HEADER_BYTES = 64 * 1024 * 1024;
const releaseChannel = process.env.INERTIA_RELEASE_CHANNEL ?? "stable";
if (releaseChannel !== "stable" && releaseChannel !== "canary") {
  throw new Error("INERTIA_RELEASE_CHANNEL must be stable or canary.");
}
const canary = releaseChannel === "canary";
const UPDATE_FEED_URL = canary
  ? "https://raw.githubusercontent.com/eduardtomas1/inertia/canary-feed"
  : "https://github.com/eduardtomas1/inertia/releases/latest/download";

const command = process.argv[2] ?? "";
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const version = packageJson.version;
if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
  throw new Error("Release assets require a strict stable package version.");
}

const releaseTag = process.env.RELEASE_TAG;
const expectedReleaseTag = `${canary ? "canary-v" : "v"}${version}`;
if (releaseTag !== expectedReleaseTag) {
  throw new Error(`RELEASE_TAG must exactly match package version ${expectedReleaseTag}.`);
}

const platformPolicies = {
  "macos-x64": {
    packages: [
      canary ? `Inertia-Canary-${version}-x64.dmg` : `Inertia-${version}.dmg`,
      canary ? `Inertia-Canary-${version}-x64.zip` : `Inertia-${version}-mac.zip`,
    ],
    metadata: canary ? "canary-mac.yml" : "latest-mac.yml",
    companions: [canary
      ? `Inertia-Canary-${version}-x64.zip.blockmap`
      : `Inertia-${version}-mac.zip.blockmap`],
    packagedUpdateConfig: `mac/${canary ? "Inertia Canary" : "Inertia"}.app/Contents/Resources/app-update.yml`,
    packagedAppArchive: `mac/${canary ? "Inertia Canary" : "Inertia"}.app/Contents/Resources/app.asar`,
  },
  "macos-arm64": {
    packages: [
      canary ? `Inertia-Canary-${version}-arm64.dmg` : `Inertia-${version}-arm64.dmg`,
      canary ? `Inertia-Canary-${version}-arm64.zip` : `Inertia-${version}-arm64-mac.zip`,
    ],
    metadata: canary ? "canary-mac.yml" : "latest-mac.yml",
    companions: [canary
      ? `Inertia-Canary-${version}-arm64.zip.blockmap`
      : `Inertia-${version}-arm64-mac.zip.blockmap`],
    packagedUpdateConfig: `mac-arm64/${canary ? "Inertia Canary" : "Inertia"}.app/Contents/Resources/app-update.yml`,
    packagedAppArchive: `mac-arm64/${canary ? "Inertia Canary" : "Inertia"}.app/Contents/Resources/app.asar`,
  },
  "windows-x64": {
    packages: [canary ? `Inertia.Canary.Setup.${version}.exe` : `Inertia.Setup.${version}.exe`],
    metadata: canary ? "canary.yml" : "latest.yml",
    companions: [canary
      ? `Inertia.Canary.Setup.${version}.exe.blockmap`
      : `Inertia.Setup.${version}.exe.blockmap`],
    packagedUpdateConfig: "win-unpacked/resources/app-update.yml",
    packagedAppArchive: "win-unpacked/resources/app.asar",
  },
  "windows-arm64": {
    packages: [canary
      ? `Inertia.Canary.Setup.${version}.arm64.exe`
      : `Inertia.Setup.${version}.arm64.exe`],
    metadata: canary ? "canary.yml" : "latest.yml",
    companions: [canary
      ? `Inertia.Canary.Setup.${version}.arm64.exe.blockmap`
      : `Inertia.Setup.${version}.arm64.exe.blockmap`],
    packagedUpdateConfig: "win-arm64-unpacked/resources/app-update.yml",
    packagedAppArchive: "win-arm64-unpacked/resources/app.asar",
  },
  "linux-x64": {
    packages: [canary ? `Inertia-Canary-${version}.AppImage` : `Inertia-${version}.AppImage`],
    metadata: canary ? "canary-linux.yml" : "latest-linux.yml",
    companions: [],
    packagedUpdateConfig: "linux-unpacked/resources/app-update.yml",
    packagedAppArchive: "linux-unpacked/resources/app.asar",
  },
  "linux-arm64": {
    packages: [canary
      ? `Inertia-Canary-${version}-arm64.AppImage`
      : `Inertia-${version}-arm64.AppImage`],
    metadata: canary ? "canary-linux-arm64.yml" : "latest-linux-arm64.yml",
    companions: [],
    packagedUpdateConfig: "linux-arm64-unpacked/resources/app-update.yml",
    packagedAppArchive: "linux-arm64-unpacked/resources/app.asar",
  },
};

const sharedMetadataGroups = [
  {
    metadata: canary ? "canary-mac.yml" : "latest-mac.yml",
    platforms: ["macos-x64", "macos-arm64"],
  },
  {
    metadata: canary ? "canary.yml" : "latest.yml",
    platforms: ["windows-x64", "windows-arm64"],
  },
];
const sharedMetadataByName = new Map(
  sharedMetadataGroups.map((group) => [group.metadata, group]),
);

const releaseSourceRoot = resolve(process.env.INERTIA_RELEASE_SOURCE_DIR ?? "release");

function releaseSource(name) {
  return join(releaseSourceRoot, name);
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeAssetName(name, label = "Release asset") {
  if (
    typeof name !== "string"
    || name.length === 0
    || Buffer.byteLength(name, "utf8") > 180
    || name === "."
    || name === ".."
    || basename(name) !== name
    || /[\\/\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new Error(`${label} has an unsafe filename.`);
  }
}

function validateBoundedDocument(value, label, depth = 0, counter = { nodes: 0 }) {
  counter.nodes += 1;
  if (counter.nodes > MAX_DOCUMENT_NODES || depth > MAX_DOCUMENT_DEPTH) {
    throw new Error(`${label} is too complex.`);
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
      throw new Error(`${label} contains an oversized string.`);
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const item of value) validateBoundedDocument(item, label, depth + 1, counter);
    return;
  }
  if (!isPlainRecord(value)) throw new Error(`${label} contains an unsupported value.`);
  for (const [key, item] of Object.entries(value)) {
    if (Buffer.byteLength(key, "utf8") > 128) throw new Error(`${label} contains an oversized key.`);
    validateBoundedDocument(item, label, depth + 1, counter);
  }
}

async function readBounded(path, maximumBytes, label) {
  const value = await lstat(path);
  if (!value.isFile() || value.size <= 0 || value.size > maximumBytes) {
    throw new Error(`${label} is missing, empty, or oversized: ${basename(path)}`);
  }
  return await readFile(path, "utf8");
}

async function fileMetadata(path) {
  const value = await lstat(path);
  if (!value.isFile() || value.size <= 0) throw new Error(`Release asset is missing or empty: ${path}`);
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return {
    name: basename(path),
    size: value.size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
  };
}

async function readAsarPackageManifest(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The packaged app archive is missing or invalid.");
  }
  const handle = await open(path, "r");
  try {
    const prefix = Buffer.alloc(16);
    if ((await handle.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length) {
      throw new Error("The packaged app archive has no complete header.");
    }
    const headerSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    if (
      headerSize < jsonLength + 8
      || headerSize > MAX_ASAR_HEADER_BYTES
      || jsonLength <= 0
      || jsonLength > MAX_ASAR_HEADER_BYTES
    ) throw new Error("The packaged app archive header is invalid.");
    const header = Buffer.alloc(jsonLength);
    if ((await handle.read(header, 0, jsonLength, 16)).bytesRead !== jsonLength) {
      throw new Error("The packaged app archive header was truncated.");
    }
    let tree;
    try {
      tree = JSON.parse(header.toString("utf8"));
    } catch {
      throw new Error("The packaged app archive header is not valid JSON.");
    }
    const entry = tree?.files?.["package.json"];
    if (
      !entry
      || entry.files
      || entry.link
      || entry.unpacked
      || !Number.isSafeInteger(entry.size)
      || entry.size <= 0
      || entry.size > MAX_PACKAGED_MANIFEST_BYTES
      || typeof entry.offset !== "string"
      || !/^(?:0|[1-9]\d*)$/u.test(entry.offset)
    ) throw new Error("The packaged app archive has no bounded package.json.");
    const offset = Number(entry.offset);
    const position = 8 + headerSize + offset;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(position)) {
      throw new Error("The packaged package.json offset is invalid.");
    }
    const content = Buffer.alloc(entry.size);
    if ((await handle.read(content, 0, entry.size, position)).bytesRead !== entry.size) {
      throw new Error("The packaged package.json was truncated.");
    }
    try {
      return JSON.parse(content.toString("utf8"));
    } catch {
      throw new Error("The packaged package.json is not valid JSON.");
    }
  } finally {
    await handle.close();
  }
}

function validateUpdateCapability(value, platform) {
  if (!isPlainRecord(value)) throw new Error("The packaged update capability is invalid.");
  const keys = Object.keys(value).sort();
  const expectedPlatform = platform.startsWith("macos-")
    ? "darwin"
    : platform.startsWith("windows-")
      ? "win32"
      : platform.startsWith("linux-")
        ? "linux"
        : null;
  if (
    keys.length === 2
    && keys[0] === "delivery"
    && keys[1] === "platform"
    && value.delivery === "in-app"
    && value.platform === expectedPlatform
  ) return { delivery: "in-app", platform: expectedPlatform };
  const expectedManualReason = platform.startsWith("macos-")
    ? "macos-signing-unavailable"
    : platform.startsWith("windows-")
      ? "windows-signing-unavailable"
      : null;
  if (
    expectedManualReason
    && keys.length === 2
    && keys[0] === "delivery"
    && keys[1] === "reason"
    && value.delivery === "manual"
    && value.reason === expectedManualReason
  ) return { delivery: "manual", reason: expectedManualReason };
  throw new Error("The packaged update capability does not match the release platform.");
}

async function packagedUpdateCapability(platform) {
  const manifest = await readAsarPackageManifest(
    join(releaseSourceRoot, platformPolicies[platform].packagedAppArchive),
  );
  if (
    !isPlainRecord(manifest)
    || manifest.name !== (canary ? "inertia-canary" : packageJson.name)
    || manifest.version !== version
    || manifest.inertiaReleaseChannel !== releaseChannel
    || !Object.hasOwn(manifest, "inertiaUpdateCapability")
  ) {
    throw new Error("The packaged application has no update capability marker.");
  }
  return validateUpdateCapability(manifest.inertiaUpdateCapability, platform);
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}.`);
  }
}

function assertSha512(value, label) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/u.test(value)) {
    throw new Error(`${label} has an invalid SHA-512 digest.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== value) {
    throw new Error(`${label} has a non-canonical SHA-512 digest.`);
  }
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
}

async function parseUpdateMetadata(path) {
  const text = await readBounded(path, MAX_UPDATE_METADATA_BYTES, "Update metadata");
  const document = parseDocument(text, {
    maxAliasCount: 0,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`Invalid update metadata YAML: ${basename(path)}`);
  }
  const value = document.toJS({ maxAliasCount: 0 });
  validateBoundedDocument(value, "Update metadata");
  if (!isPlainRecord(value)) throw new Error("Update metadata must contain one mapping.");
  return value;
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

async function validatePackagedUpdateConfig(platform, capability) {
  const policy = platformPolicies[platform];
  const path = join(releaseSourceRoot, policy.packagedUpdateConfig);
  const config = await parseUpdateMetadata(path);
  assertExactKeys(config, new Set([
    "provider",
    "url",
    "updaterCacheDirName",
    "channel",
    "useMultipleRangeRequest",
    "publisherName",
  ]), "Packaged update configuration");
  if (config.provider !== "generic" || config.url !== UPDATE_FEED_URL) {
    throw new Error("Packaged update configuration does not use the approved generic feed.");
  }
  if (
    typeof config.updaterCacheDirName !== "string"
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(config.updaterCacheDirName)
  ) {
    throw new Error("Packaged update configuration has an invalid cache directory name.");
  }
  if (canary ? config.channel !== "canary" : config.channel !== undefined && config.channel !== "latest") {
    throw new Error("Packaged update configuration has an unexpected channel.");
  }
  const expectedCache = canary ? "inertia-canary-updater" : "inertia-updater";
  if (config.updaterCacheDirName !== expectedCache) {
    throw new Error("Packaged update configuration does not isolate the channel cache.");
  }
  if (config.useMultipleRangeRequest !== undefined && typeof config.useMultipleRangeRequest !== "boolean") {
    throw new Error("Packaged update configuration has an invalid range-request setting.");
  }
  const signedWindows = platform.startsWith("windows-") && capability.delivery === "in-app";
  if (signedWindows ? !validPublisherName(config.publisherName) : config.publisherName !== undefined) {
    throw new Error("Packaged update configuration has an invalid publisher identity.");
  }
}

async function validateUpdateMetadataPolicy(policy, directory) {
  const metadata = await parseUpdateMetadata(join(directory, policy.metadata));
  assertExactKeys(metadata, new Set([
    "version",
    "files",
    "path",
    "sha512",
    "releaseDate",
    "releaseName",
    "releaseNotes",
    "stagingPercentage",
    "minimumSystemVersion",
  ]), "Update metadata");
  if (metadata.version !== version) throw new Error(`${policy.metadata} does not describe version ${version}.`);
  if (!Array.isArray(metadata.files) || metadata.files.length !== policy.packages.length) {
    throw new Error(`${policy.metadata} has an unexpected package count.`);
  }

  const expectedPackages = new Set(policy.packages);
  const seenPackages = new Set();
  const packageMetadata = new Map();
  for (const [index, entry] of metadata.files.entries()) {
    if (!isPlainRecord(entry)) throw new Error(`${policy.metadata} file entry ${index} is invalid.`);
    assertExactKeys(entry, new Set([
      "url",
      "sha512",
      "size",
      "blockMapSize",
      "isAdminRightsRequired",
    ]), `${policy.metadata} file entry ${index}`);
    assertSafeAssetName(entry.url, `${policy.metadata} file URL`);
    if (!expectedPackages.has(entry.url) || seenPackages.has(entry.url)) {
      throw new Error(`${policy.metadata} references an unexpected or duplicate package.`);
    }
    assertPositiveSafeInteger(entry.size, `${entry.url} size`);
    assertSha512(entry.sha512, entry.url);
    if (entry.blockMapSize !== undefined) {
      assertPositiveSafeInteger(entry.blockMapSize, `${entry.url} block map size`);
    }
    if (entry.isAdminRightsRequired !== undefined && typeof entry.isAdminRightsRequired !== "boolean") {
      throw new Error(`${entry.url} has an invalid administrator requirement.`);
    }
    const actual = await fileMetadata(join(directory, entry.url));
    if (actual.size !== entry.size || actual.sha512 !== entry.sha512) {
      throw new Error(`Update metadata integrity mismatch for ${entry.url}.`);
    }
    const companionName = `${entry.url}.blockmap`;
    if (policy.companions.includes(companionName)) {
      const companion = await fileMetadata(join(directory, companionName));
      if (entry.blockMapSize !== companion.size) {
        throw new Error(`Update metadata blockmap size mismatch for ${entry.url}.`);
      }
    }
    seenPackages.add(entry.url);
    packageMetadata.set(entry.url, actual);
  }
  if (seenPackages.size !== expectedPackages.size) throw new Error(`${policy.metadata} omits a release package.`);

  assertSafeAssetName(metadata.path, `${policy.metadata} primary path`);
  if (!expectedPackages.has(metadata.path)) throw new Error(`${policy.metadata} has an unexpected primary path.`);
  assertSha512(metadata.sha512, `${policy.metadata} primary package`);
  if (packageMetadata.get(metadata.path)?.sha512 !== metadata.sha512) {
    throw new Error(`${policy.metadata} primary digest does not match its package.`);
  }
  return metadata;
}

async function validateUpdateMetadata(platform, directory) {
  return validateUpdateMetadataPolicy(platformPolicies[platform], directory);
}

function expectedAssetNames(policy, capability) {
  return [
    ...policy.packages,
    ...(capability.delivery === "in-app"
      ? [policy.metadata, ...policy.companions]
      : []),
  ].sort();
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readArtifactManifest(path, platform) {
  const text = await readBounded(path, MAX_MANIFEST_BYTES, "Artifact manifest");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`Invalid ${platform} artifact manifest JSON.`);
  }
  validateBoundedDocument(manifest, "Artifact manifest");
  if (!isPlainRecord(manifest)) throw new Error(`Invalid ${platform} artifact manifest.`);
  assertExactKeys(
    manifest,
    new Set(["version", "tag", "channel", "platform", "updateCapability", "assets"]),
    "Artifact manifest",
  );
  if (
    manifest.version !== version
    || manifest.tag !== releaseTag
    || manifest.channel !== releaseChannel
    || manifest.platform !== platform
    || !Array.isArray(manifest.assets)
  ) {
    throw new Error(`Invalid ${platform} artifact manifest.`);
  }
  const updateCapability = validateUpdateCapability(
    manifest.updateCapability,
    platform,
  );
  const expectedNames = expectedAssetNames(platformPolicies[platform], updateCapability);
  const names = manifest.assets.map((asset) => asset?.name).sort();
  if (!sameStrings(names, expectedNames)) throw new Error(`Invalid ${platform} manifest asset set.`);
  return { manifest, updateCapability, expectedNames };
}

if (command === "stage") {
  const platform = process.argv[3] ?? "";
  const policy = platformPolicies[platform];
  if (!policy) throw new Error(`Unknown release platform: ${platform}`);
  const updateCapability = await packagedUpdateCapability(platform);
  const expectedNames = expectedAssetNames(policy, updateCapability);
  for (const name of expectedNames) assertSafeAssetName(name);
  await validatePackagedUpdateConfig(platform, updateCapability);
  if (updateCapability.delivery === "in-app") {
    await validateUpdateMetadata(platform, releaseSourceRoot);
  }

  const stagingRoot = resolve(process.env.INERTIA_RELEASE_STAGE_DIR ?? "release-upload");
  const platformDirectory = join(stagingRoot, platform);
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(platformDirectory);
  const assets = [];
  for (const name of expectedNames) {
    const source = releaseSource(name);
    const metadata = await fileMetadata(source);
    await copyFile(source, join(platformDirectory, name), constants.COPYFILE_EXCL);
    assets.push(metadata);
  }
  await writeFile(
    join(platformDirectory, "manifest.json"),
    `${JSON.stringify({
      version,
      tag: releaseTag,
      channel: releaseChannel,
      platform,
      updateCapability,
      assets,
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  console.log(`Staged ${assets.length} ${platform} release asset(s).`);
} else if (command === "finalize") {
  const downloadRoot = resolve(process.env.INERTIA_RELEASE_DOWNLOAD_DIR ?? "release-assets");
  const finalDirectory = join(downloadRoot, "final");
  await mkdir(finalDirectory);
  const combined = [];
  const combinedNames = new Set();
  const platformCapabilities = new Map();
  const sharedMetadataSources = new Map();
  for (const platform of Object.keys(platformPolicies)) {
    const platformDirectory = join(downloadRoot, platform);
    const entries = (await readdir(platformDirectory)).sort();
    const {
      manifest,
      updateCapability,
      expectedNames,
    } = await readArtifactManifest(join(platformDirectory, "manifest.json"), platform);
    const expectedEntries = [...expectedNames, "manifest.json"].sort();
    if (!sameStrings(entries, expectedEntries)) {
      throw new Error(`Unexpected ${platform} artifact file set: ${entries.join(", ")}`);
    }
    if (updateCapability.delivery === "in-app") {
      await validateUpdateMetadata(platform, platformDirectory);
    }
    platformCapabilities.set(platform, updateCapability);
    for (const expectedName of expectedNames) {
      const path = join(platformDirectory, expectedName);
      const actual = await fileMetadata(path);
      const recorded = manifest.assets.find((asset) => asset?.name === expectedName);
      if (
        !recorded
        || !isPlainRecord(recorded)
        || !sameStrings(Object.keys(recorded).sort(), ["name", "sha256", "sha512", "size"])
        || actual.size !== recorded.size
        || actual.sha256 !== recorded.sha256
        || actual.sha512 !== recorded.sha512
      ) {
        throw new Error(`Artifact integrity mismatch for ${expectedName}.`);
      }
      const metadataGroup = sharedMetadataByName.get(expectedName);
      if (metadataGroup?.platforms.includes(platform)) {
        let sources = sharedMetadataSources.get(expectedName);
        if (!sources) sharedMetadataSources.set(expectedName, sources = new Map());
        sources.set(platform, path);
        continue;
      }
      if (combinedNames.has(expectedName)) throw new Error(`Duplicate consolidated asset name: ${expectedName}`);
      await copyFile(path, join(finalDirectory, expectedName), constants.COPYFILE_EXCL);
      combined.push(actual);
      combinedNames.add(expectedName);
    }
  }
  for (const group of sharedMetadataGroups) {
    const inAppPlatforms = group.platforms.filter(
      (platform) => platformCapabilities.get(platform)?.delivery === "in-app",
    );
    if (inAppPlatforms.length === 0) continue;
    if (inAppPlatforms.length !== group.platforms.length) {
      throw new Error(`${group.metadata} architectures disagree on update delivery capability.`);
    }
    const sources = sharedMetadataSources.get(group.metadata);
    if (!sources || sources.size !== group.platforms.length) {
      throw new Error(`${group.metadata} is missing architecture metadata.`);
    }
    const documents = [];
    for (const platform of group.platforms) {
      const path = sources.get(platform);
      if (!path) throw new Error(`${group.metadata} is missing metadata for ${platform}.`);
      documents.push(await parseUpdateMetadata(path));
    }
    const primary = documents[0];
    const metadata = {
      ...primary,
      files: documents.flatMap((document) => document.files),
    };
    const output = join(finalDirectory, group.metadata);
    await writeFile(output, stringify(metadata), { encoding: "utf8", flag: "wx" });
    const consolidatedPolicy = {
      metadata: group.metadata,
      packages: group.platforms.flatMap(
        (platform) => platformPolicies[platform].packages,
      ),
      companions: group.platforms.flatMap(
        (platform) => platformPolicies[platform].companions,
      ),
    };
    await validateUpdateMetadataPolicy(consolidatedPolicy, finalDirectory);
    const actual = await fileMetadata(output);
    combined.push(actual);
    combinedNames.add(actual.name);
  }
  combined.sort((left, right) => left.name.localeCompare(right.name, "en"));
  await writeFile(
    join(finalDirectory, "SHA256SUMS.txt"),
    combined.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n") + "\n",
    { encoding: "utf8", flag: "wx" },
  );
  const finalEntries = (await readdir(finalDirectory)).sort();
  const expectedFinalEntries = [...combined.map((asset) => asset.name), "SHA256SUMS.txt"].sort();
  if (!sameStrings(finalEntries, expectedFinalEntries)) {
    throw new Error("Unexpected consolidated release asset file set.");
  }
  console.log(`Finalized ${combined.length} release assets and SHA256SUMS.txt for ${releaseTag}.`);
} else {
  throw new Error("Usage: node scripts/release-assets.mjs stage <platform> | finalize");
}
