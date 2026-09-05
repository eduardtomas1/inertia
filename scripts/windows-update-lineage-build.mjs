import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const MAX_INSTALLER_BYTES = 4 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;

export const WINDOWS_CANDIDATE_DIGEST_MARKER =
  "inertia.windows-candidate-executable-sha256.v1:";

function sameFileIdentity(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

function requireDirectExecutable(metadata) {
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > MAX_EXECUTABLE_BYTES
  ) throw new Error("The packaged Windows candidate executable is invalid.");
}

async function exactExecutableDigest(path) {
  const named = await lstat(path);
  requireDirectExecutable(named);
  const actualPath = await realpath(path);
  const handle = await open(
    actualPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    requireDirectExecutable(opened);
    if (!sameFileIdentity(named, opened) || named.size !== opened.size) {
      throw new Error("The packaged Windows candidate changed before hashing.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;
    while (position < opened.size) {
      const requested = Math.min(buffer.byteLength, opened.size - position);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        requested,
        position,
      );
      if (bytesRead <= 0) {
        throw new Error("The packaged Windows candidate was truncated.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const [openedAfter, namedAfter] = await Promise.all([
      handle.stat(),
      lstat(path),
    ]);
    if (
      position !== opened.size
      || openedAfter.size !== opened.size
      || namedAfter.size !== opened.size
      || !sameFileIdentity(opened, openedAfter)
      || !sameFileIdentity(opened, namedAfter)
    ) throw new Error("The packaged Windows candidate changed while hashing.");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export function windowsCandidateDigestMarker(digest) {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error("The packaged Windows candidate digest is invalid.");
  }
  return `${WINDOWS_CANDIDATE_DIGEST_MARKER}${digest}`;
}

export async function verifyWindowsInstallerCandidateMarker(
  installerPath,
  marker,
) {
  if (
    typeof marker !== "string"
    || !marker.startsWith(WINDOWS_CANDIDATE_DIGEST_MARKER)
    || windowsCandidateDigestMarker(
      marker.slice(WINDOWS_CANDIDATE_DIGEST_MARKER.length),
    ) !== marker
  ) throw new Error("The Windows installer lineage marker is invalid.");
  const named = await lstat(installerPath);
  if (
    named.isSymbolicLink()
    || !named.isFile()
    || named.size <= 0
    || named.size > MAX_INSTALLER_BYTES
  ) throw new Error("The generated Windows installer is invalid.");
  const markerBytes = Buffer.concat([
    Buffer.from(marker, "utf16le"),
    Buffer.alloc(2),
  ]);
  const actualPath = await realpath(installerPath);
  const handle = await open(
    actualPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size !== named.size
      || !sameFileIdentity(opened, named)
    ) throw new Error("The generated Windows installer changed before inspection.");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let tail = Buffer.alloc(0);
    let found = false;
    let position = 0;
    while (position < opened.size) {
      const requested = Math.min(buffer.byteLength, opened.size - position);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        requested,
        position,
      );
      if (bytesRead <= 0) {
        throw new Error("The generated Windows installer was truncated.");
      }
      const chunk = buffer.subarray(0, bytesRead);
      const window = tail.byteLength === 0
        ? chunk
        : Buffer.concat([tail, chunk]);
      if (window.indexOf(markerBytes) >= 0) found = true;
      const retainedBytes = Math.min(markerBytes.byteLength - 1, window.byteLength);
      tail = Buffer.from(window.subarray(window.byteLength - retainedBytes));
      position += bytesRead;
    }
    const [openedAfter, namedAfter] = await Promise.all([
      handle.stat(),
      lstat(installerPath),
    ]);
    if (
      position !== opened.size
      || openedAfter.size !== opened.size
      || namedAfter.size !== opened.size
      || !sameFileIdentity(opened, openedAfter)
      || !sameFileIdentity(opened, namedAfter)
    ) throw new Error("The generated Windows installer changed during inspection.");
    if (!found) {
      throw new Error(
        "The signed Windows installer omits its candidate lineage marker.",
      );
    }
  } finally {
    await handle.close();
  }
}

/**
 * Runs after the application executable has been resource-edited/signed and
 * before the NSIS target is built. The resulting signed installer therefore
 * carries the digest of the exact executable bytes in its application payload.
 */
export async function bindWindowsInstallerToCandidateExecutable(context) {
  if (context?.electronPlatformName !== "win32") return;
  const appOutDir = context.appOutDir;
  const productFilename = context.packager?.appInfo?.productFilename;
  const windowsOptions = context.packager?.platformSpecificBuildOptions;
  if (
    typeof appOutDir !== "string"
    || !isAbsolute(appOutDir)
    || typeof productFilename !== "string"
    || productFilename.length === 0
    || productFilename.length > 128
    || basename(productFilename) !== productFilename
    || !windowsOptions
    || typeof windowsOptions !== "object"
  ) throw new Error("The Windows candidate build context is invalid.");
  if (
    windowsOptions.legalTrademarks !== undefined
    && windowsOptions.legalTrademarks !== null
    && windowsOptions.legalTrademarks !== ""
  ) {
    throw new Error(
      "The Windows LegalTrademarks resource is reserved for update lineage.",
    );
  }
  const executablePath = join(appOutDir, `${productFilename}.exe`);
  const digest = await exactExecutableDigest(executablePath);
  const marker = windowsCandidateDigestMarker(digest);
  windowsOptions.legalTrademarks = marker;
  if (windowsOptions.legalTrademarks !== marker) {
    throw new Error("The Windows installer lineage marker could not be applied.");
  }
}
