import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  metadataFromUnknown,
  type PersistedAttachmentMetadata,
} from "../../node/conversation-attachment-store-metadata";
import {
  FILE_OPEN_DIRECTORY,
  FILE_OPEN_NO_FOLLOW,
} from "../../node/platform-file-open-flags";
import type { ChatAttachment } from "../../shared/contracts";
import {
  isTarBundleHeader,
  TAR_BLOCK_BYTES,
  TAR_STREAM_CHUNK_BYTES,
} from "./recovery-tar";

export const RECOVERY_ATTACHMENT_STORE_DIRECTORY = "conversation-attachments";
export const RECOVERY_ATTACHMENT_METADATA_FILE = "metadata.json";
export const RECOVERY_ATTACHMENT_MAX_METADATA_BYTES = 4 * 1024;
export const RECOVERY_ATTACHMENT_DIRECTORY_MODE = 0o700;
export const RECOVERY_ATTACHMENT_FILE_MODE = 0o600;
export const RECOVERY_ATTACHMENT_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STAGING_DIRECTORY_PATTERN =
  /^\.recovery-import-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.partial$/iu;

export interface AttachmentRootAuthority {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: string | null;
}

export function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

export function isContained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation !== ""
    && relation !== ".."
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation);
}

export function isPrivateEntry(
  entry: { readonly mode: bigint; readonly uid: bigint },
  mode: 0o600 | 0o700,
): boolean {
  if (process.platform === "win32") return true;
  return (entry.mode & 0o777n) === BigInt(mode)
    && (
      typeof process.getuid !== "function"
      || entry.uid === BigInt(process.getuid())
    );
}

export function sameDeviceAndInode(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(
    path,
    constants.O_RDONLY | FILE_OPEN_DIRECTORY,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function ensureSecureAttachmentRoot(
  dataDirectory: string,
): Promise<AttachmentRootAuthority> {
  if (!isAbsolute(dataDirectory) || dataDirectory.includes("\0")) {
    throw new Error("The attachment store root is invalid.");
  }
  await mkdir(dataDirectory, { recursive: true, mode: RECOVERY_ATTACHMENT_DIRECTORY_MODE });
  const parent = await realpath(dataDirectory);
  const requested = join(parent, RECOVERY_ATTACHMENT_STORE_DIRECTORY);
  await mkdir(requested, { recursive: true, mode: RECOVERY_ATTACHMENT_DIRECTORY_MODE });
  const named = await lstat(requested, { bigint: true });
  if (!named.isDirectory() || named.isSymbolicLink()) {
    throw new Error("Conversation attachment storage is not a safe directory.");
  }
  if (process.platform !== "win32") {
    const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
    const directoryOnly = "O_DIRECTORY" in constants ? FILE_OPEN_DIRECTORY : 0;
    const directory = await open(
      requested,
      constants.O_RDONLY | noFollow | directoryOnly,
    );
    try {
      const pinnedBefore = await directory.stat({ bigint: true });
      if (!pinnedBefore.isDirectory() || !sameDeviceAndInode(named, pinnedBefore)) {
        throw new Error("Conversation attachment storage changed.");
      }
      await directory.chmod(RECOVERY_ATTACHMENT_DIRECTORY_MODE);
      const pinnedAfter = await directory.stat({ bigint: true });
      if (
        !pinnedAfter.isDirectory()
        || !sameDeviceAndInode(pinnedBefore, pinnedAfter)
        || !isPrivateEntry(pinnedAfter, RECOVERY_ATTACHMENT_DIRECTORY_MODE)
      ) {
        throw new Error("Conversation attachment storage could not be secured.");
      }
    } finally {
      await directory.close();
    }
  }
  const canonical = await realpath(requested);
  const verified = await lstat(canonical, { bigint: true });
  if (
    canonical !== requested
    || dirname(canonical) !== parent
    || !isContained(parent, canonical)
    || !sameDeviceAndInode(named, verified)
    || !verified.isDirectory()
    || verified.isSymbolicLink()
    || !isPrivateEntry(verified, RECOVERY_ATTACHMENT_DIRECTORY_MODE)
  ) {
    throw new Error("Conversation attachment storage could not be secured.");
  }
  return {
    path: canonical,
    dev: String(verified.dev),
    ino: String(verified.ino),
    uid: process.platform === "win32" ? null : String(verified.uid),
  };
}

export async function resolveExistingAttachmentRoot(
  dataDirectory: string,
): Promise<AttachmentRootAuthority | null> {
  let parent: string;
  try {
    parent = await realpath(dataDirectory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const requested = join(parent, RECOVERY_ATTACHMENT_STORE_DIRECTORY);
  let named: Awaited<ReturnType<typeof lstat>>;
  try {
    named = await lstat(requested, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!named.isDirectory() || named.isSymbolicLink()) {
    throw new Error("Conversation attachment storage is not a safe directory.");
  }
  const canonical = await realpath(requested);
  const verified = await lstat(canonical, { bigint: true });
  if (
    canonical !== requested
    || dirname(canonical) !== parent
    || !isContained(parent, canonical)
    || !sameDeviceAndInode(named, verified)
    || !verified.isDirectory()
    || verified.isSymbolicLink()
    || !isPrivateEntry(verified, RECOVERY_ATTACHMENT_DIRECTORY_MODE)
  ) {
    throw new Error("Conversation attachment storage could not be verified.");
  }
  return {
    path: canonical,
    dev: String(verified.dev),
    ino: String(verified.ino),
    uid: process.platform === "win32" ? null : String(verified.uid),
  };
}

export async function assertAttachmentRootAuthority(
  authority: AttachmentRootAuthority,
): Promise<void> {
  const named = await lstat(authority.path, { bigint: true });
  const canonical = await realpath(authority.path);
  if (
    canonical !== authority.path
    || !named.isDirectory()
    || named.isSymbolicLink()
    || String(named.dev) !== authority.dev
    || String(named.ino) !== authority.ino
    || (
      process.platform !== "win32"
      && (
        !isPrivateEntry(named, RECOVERY_ATTACHMENT_DIRECTORY_MODE)
        || String(named.uid) !== authority.uid
      )
    )
  ) {
    throw new Error("Conversation attachment storage authority changed.");
  }
}

export async function assertContainedPath(root: string, target: string): Promise<string> {
  const canonical = await realpath(target);
  if (!isContained(root, canonical)) {
    throw new Error("Attachment recovery path escaped the attachment store.");
  }
  return canonical;
}

export async function readSmallSecureFile(
  path: string,
  maxBytes: number,
  expectedParent: string,
): Promise<Buffer | null> {
  let named: Awaited<ReturnType<typeof lstat>>;
  try {
    named = await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (
    !named.isFile()
    || named.isSymbolicLink()
    || !isPrivateEntry(named, RECOVERY_ATTACHMENT_FILE_MODE)
    || named.size < 1n
    || named.size > BigInt(maxBytes)
  ) {
    throw new Error("The retained attachment metadata is unsafe.");
  }
  await assertContainedPath(expectedParent, path);
  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || !sameDeviceAndInode(named, before)
      || before.size !== named.size
      || !isPrivateEntry(before, RECOVERY_ATTACHMENT_FILE_MODE)
    ) {
      throw new Error("The retained attachment metadata changed.");
    }
    const size = Number(before.size);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== size
      || !sameDeviceAndInode(before, after)
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("The retained attachment metadata changed.");
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function writeBufferFile(
  path: string,
  data: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, "The database recovery import was cancelled.");
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    RECOVERY_ATTACHMENT_FILE_MODE,
  );
  try {
    let offset = 0;
    while (offset < data.byteLength) {
      throwIfAborted(signal, "The database recovery import was cancelled.");
      const { bytesWritten } = await handle.write(
        data,
        offset,
        data.byteLength - offset,
        offset,
      );
      if (bytesWritten < 1) {
        throw new Error("Failed to write staged attachment metadata.");
      }
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(path, RECOVERY_ATTACHMENT_FILE_MODE);
}

export async function streamCopyFile(
  sourcePath: string,
  destinationPath: string,
  expectedSize: number,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<void> {
  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  const source = await open(sourcePath, constants.O_RDONLY | noFollow);
  const destination = await open(
    destinationPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    RECOVERY_ATTACHMENT_FILE_MODE,
  );
  try {
    const chunk = Buffer.allocUnsafe(TAR_STREAM_CHUNK_BYTES);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < expectedSize) {
      throwIfAborted(signal, "The database recovery import was cancelled.");
      const toRead = Math.min(chunk.length, expectedSize - offset);
      const { bytesRead } = await source.read(chunk, 0, toRead, offset);
      if (bytesRead === 0) {
        throw new Error("A staged attachment file was truncated.");
      }
      const slice = chunk.subarray(0, bytesRead);
      hash.update(slice);
      let written = 0;
      while (written < slice.length) {
        const { bytesWritten } = await destination.write(
          slice,
          written,
          slice.length - written,
          offset + written,
        );
        if (bytesWritten < 1) {
          throw new Error("Failed to copy staged attachment file.");
        }
        written += bytesWritten;
      }
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await source.read(overflow, 0, 1, expectedSize);
    if (overflowBytes !== 0 || hash.digest("hex") !== expectedSha256) {
      throw new Error("A staged attachment file changed during preparation.");
    }
    await destination.sync();
  } finally {
    await destination.close();
    await source.close();
  }
  if (process.platform !== "win32") await chmod(destinationPath, RECOVERY_ATTACHMENT_FILE_MODE);
}

async function hashAndVerifyFile(
  path: string,
  expectedSize: number,
  expectedSha256: string,
  expectedParent: string,
): Promise<boolean> {
  let named: Awaited<ReturnType<typeof lstat>>;
  try {
    named = await lstat(path, { bigint: true });
  } catch {
    return false;
  }
  if (
    !named.isFile()
    || named.isSymbolicLink()
    || !isPrivateEntry(named, RECOVERY_ATTACHMENT_FILE_MODE)
    || named.size !== BigInt(expectedSize)
  ) {
    return false;
  }
  try {
    await assertContainedPath(expectedParent, path);
  } catch {
    return false;
  }
  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || !sameDeviceAndInode(named, before)
      || before.size !== named.size
      || !isPrivateEntry(before, RECOVERY_ATTACHMENT_FILE_MODE)
    ) {
      return false;
    }
    const chunk = Buffer.allocUnsafe(TAR_STREAM_CHUNK_BYTES);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < expectedSize) {
      const toRead = Math.min(chunk.length, expectedSize - offset);
      const { bytesRead } = await handle.read(chunk, 0, toRead, offset);
      if (bytesRead === 0) return false;
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, expectedSize);
    const after = await handle.stat({ bigint: true });
    return offset === expectedSize
      && overflowBytes === 0
      && sameDeviceAndInode(before, after)
      && after.size === before.size
      && hash.digest("hex") === expectedSha256;
  } finally {
    await handle.close();
  }
}

export async function detectRecoveryFileFormat(
  filePath: string,
  signal?: AbortSignal,
): Promise<"json" | "tar"> {
  throwIfAborted(signal, "The database recovery import was cancelled.");
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
    throw new Error("The recovery export file is unavailable or too large.");
  }
  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const head = Buffer.alloc(Math.min(TAR_BLOCK_BYTES, metadata.size));
    let offset = 0;
    while (offset < head.length) {
      const { bytesRead } = await handle.read(head, offset, head.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const sample = head.subarray(0, offset);
    if (sample.length >= TAR_BLOCK_BYTES && isTarBundleHeader(sample)) {
      return "tar";
    }
    for (let index = 0; index < sample.length; index += 1) {
      const byte = sample[index]!;
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
      if (index === 0 && sample.length >= 3 && byte === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
        index += 2;
        continue;
      }
      return byte === 0x7b ? "json" : "tar";
    }
    return "json";
  } finally {
    await handle.close();
  }
}

export async function reconcileRecoveryAttachmentStaging(
  dataDirectory: string,
  referencedAttachments: readonly ChatAttachment[],
): Promise<void> {
  const rootAuthority = await resolveExistingAttachmentRoot(dataDirectory);
  if (!rootAuthority) return;
  const referencedById = new Map<string, ChatAttachment>();
  for (const attachment of referencedAttachments) {
    if (RECOVERY_ATTACHMENT_UUID_V4.test(attachment.id)) {
      referencedById.set(attachment.id, attachment);
    }
  }
  const entries = await readdir(rootAuthority.path, { withFileTypes: true });
  for (const entry of entries) {
    if (!STAGING_DIRECTORY_PATTERN.test(entry.name)) continue;
    await assertAttachmentRootAuthority(rootAuthority);
    const stagingPath = join(rootAuthority.path, entry.name);
    const stagingStat = await lstat(stagingPath, { bigint: true }).catch(() => null);
    if (!stagingStat) continue;
    if (stagingStat.isDirectory() && !stagingStat.isSymbolicLink()) {
      await assertContainedPath(rootAuthority.path, stagingPath);
      const readyPath = join(stagingPath, "ready");
      const readyStat = await lstat(readyPath, { bigint: true }).catch(() => null);
      if (readyStat?.isDirectory() && !readyStat.isSymbolicLink()) {
        await assertContainedPath(stagingPath, readyPath);
        const readyEntries = await readdir(readyPath, { withFileTypes: true });
        for (const candidate of readyEntries) {
          if (!RECOVERY_ATTACHMENT_UUID_V4.test(candidate.name)) continue;
          const referenced = referencedById.get(candidate.name);
          if (!referenced) continue;
          const destinationPath = join(rootAuthority.path, candidate.name);
          const alreadyExists = await lstat(destinationPath).then(() => true, () => false);
          if (alreadyExists) continue;
          const candidatePath = join(readyPath, candidate.name);
          const candidateStat = await lstat(candidatePath, { bigint: true }).catch(() => null);
          if (
            !candidateStat?.isDirectory()
            || candidateStat.isSymbolicLink()
            || !isPrivateEntry(candidateStat, RECOVERY_ATTACHMENT_DIRECTORY_MODE)
          ) continue;
          const canonicalCandidate = await assertContainedPath(readyPath, candidatePath);
          const metadataBuffer = await readSmallSecureFile(
            join(canonicalCandidate, RECOVERY_ATTACHMENT_METADATA_FILE),
            RECOVERY_ATTACHMENT_MAX_METADATA_BYTES,
            canonicalCandidate,
          ).catch(() => null);
          if (!metadataBuffer) continue;
          let parsed: PersistedAttachmentMetadata | null = null;
          try {
            parsed = metadataFromUnknown(JSON.parse(metadataBuffer.toString("utf8")));
          } catch {
            parsed = null;
          }
          if (
            !parsed
            || parsed.id !== referenced.id
            || parsed.name !== referenced.name
            || parsed.mimeType !== referenced.mimeType
            || parsed.size !== referenced.size
          ) continue;
          const contentValid = await hashAndVerifyFile(
            join(canonicalCandidate, `${parsed.id}.${parsed.extension}`),
            parsed.size,
            parsed.digest,
            canonicalCandidate,
          ).catch(() => false);
          if (!contentValid) continue;
          await assertAttachmentRootAuthority(rootAuthority);
          await rename(candidatePath, destinationPath);
        }
        await syncDirectory(rootAuthority.path);
      }
    }
    await rm(stagingPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
    await syncDirectory(rootAuthority.path);
  }
}
