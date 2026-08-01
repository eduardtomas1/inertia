import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const ARTIFACT_SCHEMA_VERSION = 1;
const RELAY_PROTOCOL_RANGE = Object.freeze({ minimum: 2, maximum: 2 });
const REMOTE_PROTOCOL_RANGE = Object.freeze({ minimum: 2, maximum: 2 });
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const GIT_OBJECT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ARCHIVE_NAME = /^inertia-remote-(browser|relay)-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.tar\.gz$/u;

const relayFiles = [
  "compatibility.d.mts",
  "compatibility.mjs",
  "endpoint-auth.d.mts",
  "endpoint-auth.mjs",
  "package-lock.json",
  "package.json",
  "server.d.mts",
  "server.mjs",
];

export async function buildRemoteArtifacts(options = {}) {
  const sourceCommit = options.sourceCommit ?? cleanSourceCommit();
  const browserPackage = await readPackageJson("remote/browser/package.json");
  const relayPackage = await readPackageJson("remote/relay/package.json");
  const browserDirectory = resolve(
    options.browserDirectory ?? "remote/browser/dist",
  );
  const relayDirectory = resolve(options.relayDirectory ?? "remote/relay");
  const browserEntries = await collectDirectory(browserDirectory, "site");
  const relayEntries = await Promise.all([
    ...relayFiles.map(async (path) => ({
      path,
      data: await readRegularFile(join(relayDirectory, path)),
    })),
    (async () => ({
      path: "README.md",
      data: await readRegularFile(resolve("remote/README.md")),
    }))(),
  ]);

  return await writeRemoteArtifactSet({
    outputDirectory: options.outputDirectory ?? "release/remote",
    sourceCommit,
    components: [
      {
        kind: "browser",
        version: browserPackage.version,
        nodeRange: browserPackage.engines?.node,
        lockfilePath: resolve("package-lock.json"),
        entries: browserEntries,
      },
      {
        kind: "relay",
        version: relayPackage.version,
        nodeRange: relayPackage.engines?.node,
        lockfilePath: join(relayDirectory, "package-lock.json"),
        entries: relayEntries,
      },
    ],
  });
}

export async function writeRemoteArtifactSet(options) {
  const outputDirectory = resolve(options?.outputDirectory ?? "");
  if (!GIT_OBJECT.test(options?.sourceCommit ?? "")) {
    throw new Error("Remote artifacts require an exact Git source commit.");
  }
  if (!Array.isArray(options?.components) || options.components.length !== 2) {
    throw new Error("Remote artifacts require browser and relay components.");
  }
  await mkdir(outputDirectory, { recursive: true });
  if ((await readdir(outputDirectory)).length !== 0) {
    throw new Error("Remote artifact output directory must be empty.");
  }

  const artifacts = [];
  for (const component of [...options.components].sort((left, right) =>
    compareStrings(left.kind, right.kind))) {
    const archive = await createComponentArchive({
      ...component,
      sourceCommit: options.sourceCommit,
    });
    const name = `inertia-remote-${component.kind}-${component.version}.tar.gz`;
    const path = join(outputDirectory, name);
    await writeFile(path, archive, { flag: "wx" });
    artifacts.push({ name, sha256: sha256(archive), size: archive.byteLength });
  }
  artifacts.sort((left, right) => compareStrings(left.name, right.name));
  await writeFile(
    join(outputDirectory, "REMOTE-SHA256SUMS.txt"),
    `${artifacts.map(({ name, sha256: digest }) => `${digest}  ${name}`).join("\n")}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await verifyRemoteArtifacts(outputDirectory);
  return { outputDirectory, artifacts };
}

export async function verifyRemoteArtifacts(directory = "release/remote") {
  const artifactDirectory = resolve(directory);
  const entries = (await readdir(artifactDirectory)).sort();
  const checksumName = "REMOTE-SHA256SUMS.txt";
  if (entries.length !== 3 || !entries.includes(checksumName)) {
    throw new Error("Unexpected Remote Companion artifact file set.");
  }
  const checksumLines = (await readFile(
    join(artifactDirectory, checksumName),
    "utf8",
  )).split("\n");
  if (checksumLines.at(-1) !== "") {
    throw new Error("Remote Companion checksums require a final newline.");
  }
  checksumLines.pop();
  if (checksumLines.length !== 2) {
    throw new Error("Remote Companion checksums must name exactly two artifacts.");
  }

  const checksums = checksumLines.map((line) => {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9.-]+)$/u.exec(line);
    if (!match) throw new Error("Invalid Remote Companion checksum entry.");
    return { digest: match[1], name: match[2] };
  });
  const names = checksums.map(({ name }) => name).sort();
  if (!sameStrings(entries, [...names, checksumName].sort())) {
    throw new Error("Remote Companion checksums do not match the artifact files.");
  }
  const kinds = new Set();
  for (const { digest, name } of checksums) {
    const match = ARCHIVE_NAME.exec(name);
    if (!match || kinds.has(match[1])) {
      throw new Error("Invalid Remote Companion artifact name.");
    }
    kinds.add(match[1]);
    const archive = await readRegularFile(join(artifactDirectory, name));
    if (archive.byteLength > MAX_ARCHIVE_BYTES || sha256(archive) !== digest) {
      throw new Error(`Remote Companion artifact integrity mismatch: ${name}`);
    }
    verifyComponentArchive(archive, {
      kind: match[1],
      version: match[2],
    });
  }
  if (!kinds.has("browser") || !kinds.has("relay")) {
    throw new Error("Remote Companion browser or relay artifact is missing.");
  }
  return true;
}

async function createComponentArchive(component) {
  if (
    (component.kind !== "browser" && component.kind !== "relay")
    || !STABLE_VERSION.test(component.version ?? "")
    || typeof component.nodeRange !== "string"
    || component.nodeRange.length < 1
    || component.nodeRange.length > 80
    || !Array.isArray(component.entries)
    || component.entries.length < 1
  ) throw new Error("Invalid Remote Companion artifact component.");
  const payload = component.entries.map((entry) => ({
    path: normalizeArchivePath(entry.path),
    data: requireBuffer(entry.data),
  })).sort((left, right) => compareStrings(left.path, right.path));
  if (new Set(payload.map(({ path }) => path)).size !== payload.length) {
    throw new Error("Remote Companion artifact paths must be unique.");
  }
  if (
    component.kind === "browser"
      ? !payload.some(({ path }) => path === "site/index.html")
      : !["package-lock.json", "package.json", "server.mjs", "README.md"]
        .every((required) => payload.some(({ path }) => path === required))
  ) throw new Error(`Remote Companion ${component.kind} payload is incomplete.`);

  const lockfile = await readRegularFile(component.lockfilePath);
  const manifest = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    component: { kind: component.kind, version: component.version },
    sourceCommit: component.sourceCommit,
    supported: {
      relayProtocol: RELAY_PROTOCOL_RANGE,
      remoteProtocol: REMOTE_PROTOCOL_RANGE,
    },
    node: component.nodeRange,
    lockfileSha256: sha256(lockfile),
    files: payload.map(({ path, data }) => ({
      path,
      size: data.byteLength,
      sha256: sha256(data),
    })),
  };
  const root = `inertia-remote-${component.kind}-${component.version}`;
  const archiveEntries = [
    {
      path: `${root}/manifest.json`,
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    },
    ...payload.map(({ path, data }) => ({ path: `${root}/${path}`, data })),
  ].sort((left, right) => compareStrings(left.path, right.path));
  const compressed = gzipSync(createTar(archiveEntries), { level: 9 });
  // Normalize the gzip OS byte as well as the already-zero timestamp so the
  // archives remain identical across release runners.
  compressed[9] = 255;
  return compressed;
}

function verifyComponentArchive(archive, expected) {
  let uncompressed;
  try {
    uncompressed = gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch (error) {
    throw new Error("Remote Companion artifact is not a bounded gzip archive.", {
      cause: error,
    });
  }
  const files = parseTar(uncompressed);
  const root = `inertia-remote-${expected.kind}-${expected.version}`;
  const manifestPath = `${root}/manifest.json`;
  const manifestBytes = files.get(manifestPath);
  if (!manifestBytes) throw new Error("Remote Companion artifact manifest is missing.");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error("Remote Companion artifact manifest is invalid.", { cause: error });
  }
  validateManifest(manifest, expected);
  const expectedPaths = [
    manifestPath,
    ...manifest.files.map(({ path }) => `${root}/${path}`),
  ].sort();
  if (!sameStrings([...files.keys()].sort(), expectedPaths)) {
    throw new Error("Remote Companion artifact contains unexpected files.");
  }
  for (const metadata of manifest.files) {
    const data = files.get(`${root}/${metadata.path}`);
    if (
      !data
      || data.byteLength !== metadata.size
      || sha256(data) !== metadata.sha256
    ) throw new Error(`Remote Companion payload integrity mismatch: ${metadata.path}`);
  }
}

function validateManifest(value, expected) {
  if (
    !plainObject(value)
    || !exactKeys(value, 7)
    || value.schemaVersion !== ARTIFACT_SCHEMA_VERSION
    || !plainObject(value.component)
    || !exactKeys(value.component, 2)
    || value.component.kind !== expected.kind
    || value.component.version !== expected.version
    || !GIT_OBJECT.test(value.sourceCommit ?? "")
    || !plainObject(value.supported)
    || !exactKeys(value.supported, 2)
    || !sameRange(value.supported.relayProtocol, RELAY_PROTOCOL_RANGE)
    || !sameRange(value.supported.remoteProtocol, REMOTE_PROTOCOL_RANGE)
    || typeof value.node !== "string"
    || value.node.length < 1
    || value.node.length > 80
    || !SHA256.test(value.lockfileSha256 ?? "")
    || !Array.isArray(value.files)
    || value.files.length < 1
    || value.files.length > 10_000
  ) throw new Error("Remote Companion artifact manifest schema is invalid.");
  let previous = "";
  for (const file of value.files) {
    if (
      !plainObject(file)
      || !exactKeys(file, 3)
      || normalizeArchivePath(file.path) !== file.path
      || file.path <= previous
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || file.size > MAX_UNCOMPRESSED_BYTES
      || !SHA256.test(file.sha256 ?? "")
    ) throw new Error("Remote Companion artifact file manifest is invalid.");
    previous = file.path;
  }
}

async function collectDirectory(directory, prefix) {
  const root = resolve(directory);
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("Remote Companion browser build directory is unsafe.");
  }
  const collected = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      compareStrings(left.name, right.name))) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Remote Companion artifacts may not contain symlinks.");
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const relativePath = relative(root, path).split(sep).join("/");
        collected.push({
          path: `${prefix}/${relativePath}`,
          data: await readRegularFile(path),
        });
      } else {
        throw new Error("Remote Companion artifacts require regular files.");
      }
    }
  }
  await visit(root);
  return collected;
}

async function readRegularFile(path) {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Remote Companion artifact input is not a regular file: ${path}`);
  }
  return await readFile(path);
}

async function readPackageJson(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!STABLE_VERSION.test(value?.version ?? "")) {
    throw new Error(`Remote component package version is invalid: ${path}`);
  }
  return value;
}

function createTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = requireBuffer(entry.data);
    const { name, prefix } = splitTarPath(normalizeArchivePath(entry.path));
    const header = Buffer.alloc(TAR_BLOCK_BYTES);
    writeTarString(header, 0, 100, name);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");
    writeTarString(header, 265, 32, "root");
    writeTarString(header, 297, 32, "root");
    writeTarString(header, 345, 155, prefix);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarChecksum(header, checksum);
    blocks.push(header, data);
    const padding = (TAR_BLOCK_BYTES - data.byteLength % TAR_BLOCK_BYTES)
      % TAR_BLOCK_BYTES;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  return Buffer.concat(blocks);
}

function parseTar(tar) {
  const files = new Map();
  let offset = 0;
  let totalBytes = 0;
  let previousPath = "";
  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + TAR_BLOCK_BYTES * 2 !== tar.byteLength
        || !tar.subarray(offset).every((byte) => byte === 0)
      ) throw new Error("Remote Companion tar terminator is invalid.");
      return files;
    }
    const recordedChecksum = parseTarOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (recordedChecksum !== actualChecksum || header[156] !== 0x30) {
      throw new Error("Remote Companion tar header is invalid.");
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = normalizeArchivePath(prefix ? `${prefix}/${name}` : name);
    if (path <= previousPath || files.has(path)) {
      throw new Error("Remote Companion tar paths are not uniquely sorted.");
    }
    previousPath = path;
    const size = parseTarOctal(header, 124, 12);
    totalBytes += size;
    if (!Number.isSafeInteger(size) || totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("Remote Companion tar payload is oversized.");
    }
    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) {
      throw new Error("Remote Companion tar payload is truncated.");
    }
    files.set(path, Buffer.from(tar.subarray(dataStart, dataEnd)));
    offset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  throw new Error("Remote Companion tar terminator is missing.");
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const slashIndexes = [...path.matchAll(/\//gu)].map((match) => match.index ?? -1);
  for (const index of slashIndexes.reverse()) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Remote Companion artifact path is too long: ${path}`);
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error("Tar string field is too long.");
  bytes.copy(buffer, offset);
}

function readTarString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator < 0 ? field.length : terminator).toString(
    "utf8",
  );
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error("Tar numeric field is too large.");
  writeTarString(buffer, offset, length, `${encoded}\0`);
}

function writeTarChecksum(buffer, value) {
  const encoded = value.toString(8).padStart(6, "0");
  if (encoded.length > 6) throw new Error("Tar checksum is too large.");
  writeTarString(buffer, 148, 8, `${encoded}\0 `);
}

function parseTarOctal(buffer, offset, length) {
  const value = readTarString(buffer, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error("Invalid tar numeric field.");
  return Number.parseInt(value, 8);
}

function normalizeArchivePath(path) {
  if (
    typeof path !== "string"
    || path.length < 1
    || path.length > 240
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
    || /[\u0000-\u001f\u007f]/u.test(path)
  ) throw new Error("Invalid Remote Companion artifact path.");
  return path;
}

function cleanSourceCommit() {
  const status = git("status", "--porcelain", "--untracked-files=all");
  if (status !== "") {
    throw new Error("Remote release artifacts require a clean source checkout.");
  }
  const commit = git("rev-parse", "--verify", "HEAD^{commit}").toLowerCase();
  if (!GIT_OBJECT.test(commit)) throw new Error("Invalid source Git commit.");
  return commit;
}

function git(...arguments_) {
  return execFileSync("git", arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireBuffer(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError("Artifact data must be a Buffer.");
  return value;
}

function sameRange(left, right) {
  return plainObject(left)
    && exactKeys(left, 2)
    && left.minimum === right.minimum
    && left.maximum === right.maximum;
}

function sameStrings(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, count) {
  return Object.keys(value).length === count;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const command = process.argv[2] ?? "";
  const directory = process.argv[3];
  if (command === "build") {
    const result = await buildRemoteArtifacts(
      directory ? { outputDirectory: directory } : {},
    );
    console.log(`Built and verified ${result.artifacts.length} Remote Companion artifacts.`);
  } else if (command === "verify") {
    await verifyRemoteArtifacts(directory);
    console.log("Verified Remote Companion artifacts and checksums.");
  } else {
    throw new Error(
      "Usage: node scripts/remote-artifacts.mjs build [directory] | verify [directory]",
    );
  }
}
