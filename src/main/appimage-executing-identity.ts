import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_PATH_BYTES = 4 * 1_024;
const MAX_APPIMAGE_BYTES = 4 * 1_024 * 1_024 * 1_024;
const HASH_BUFFER_BYTES = 1024 * 1_024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

interface ExpectedAppImageIdentity {
  readonly artifactDigest: string;
  readonly executableIdentityDigest: string;
}

interface InspectedAppImageIdentity extends ExpectedAppImageIdentity {
  readonly metadata: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mode: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  };
}

export interface HeldAppImageIdentity extends ExpectedAppImageIdentity {
  readonly fileDescriptor: number;
  readonly device: string;
  readonly inode: string;
  close(): Promise<void>;
}

function exactPath(path: string): boolean {
  return path.length > 0
    && path === path.trim()
    && isAbsolute(path)
    && !path.includes("\0")
    && Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES;
}

function sameFile(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireCandidateFile(metadata: {
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
  readonly uid: bigint;
  readonly size: bigint;
}): void {
  const uid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || (uid !== null && metadata.uid !== BigInt(uid))
    || metadata.size <= 0n
    || metadata.size > BigInt(MAX_APPIMAGE_BYTES)
  ) throw new Error("The held AppImage candidate is not a trusted regular file.");
}

function stableMetadata(
  before: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mode: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  },
  after: typeof before,
): boolean {
  return sameFile(before, after)
    && before.size === after.size
    && before.mode === after.mode
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function requireBeforeDeadline(deadlineAt: number | null): void {
  if (
    deadlineAt !== null
    && (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt)
  ) {
    throw new Error("The AppImage candidate verification deadline expired.");
  }
}

async function inspectOpenCandidate(
  handle: FileHandle,
  deadlineAt: number | null,
): Promise<InspectedAppImageIdentity> {
  requireBeforeDeadline(deadlineAt);
  const openedBefore = await handle.stat({ bigint: true });
  requireCandidateFile(openedBefore);
  const artifact = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  const size = Number(openedBefore.size);
  let position = 0;
  while (position < size) {
    requireBeforeDeadline(deadlineAt);
    const requested = Math.min(buffer.byteLength, size - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead <= 0) {
      throw new Error("The held AppImage candidate was truncated while hashing.");
    }
    artifact.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  requireBeforeDeadline(deadlineAt);
  const openedAfter = await handle.stat({ bigint: true });
  requireBeforeDeadline(deadlineAt);
  requireCandidateFile(openedAfter);
  if (
    position !== size
    || !stableMetadata(openedBefore, openedAfter)
  ) throw new Error("The held AppImage candidate changed while hashing.");
  return Object.freeze({
    artifactDigest: artifact.digest("hex"),
    executableIdentityDigest: createHash("sha256")
      .update("inertia.appimage-executable-identity.v1\0", "utf8")
      .update(JSON.stringify([
        String(openedBefore.dev),
        String(openedBefore.ino),
        size,
        Number(openedBefore.mode & 0o777n),
      ]), "utf8")
      .digest("hex"),
    metadata: openedBefore,
  });
}

async function inspectHeldCandidate(
  path: string,
  handle: FileHandle,
  deadlineAt: number | null,
): Promise<HeldAppImageIdentity> {
  requireBeforeDeadline(deadlineAt);
  const namedBefore = await lstat(path, { bigint: true });
  requireCandidateFile(namedBefore);
  const inspected = await inspectOpenCandidate(handle, deadlineAt);
  requireBeforeDeadline(deadlineAt);
  const namedAfter = await lstat(path, { bigint: true });
  requireBeforeDeadline(deadlineAt);
  requireCandidateFile(namedAfter);
  if (
    !stableMetadata(namedBefore, inspected.metadata)
    || !stableMetadata(inspected.metadata, namedAfter)
  ) throw new Error(
    "The held AppImage candidate does not match its direct path.",
  );
  return Object.freeze({
    artifactDigest: inspected.artifactDigest,
    executableIdentityDigest: inspected.executableIdentityDigest,
    fileDescriptor: handle.fd,
    device: String(inspected.metadata.dev),
    inode: String(inspected.metadata.ino),
    close: async () => await handle.close(),
  });
}

function requireExpectedIdentity(expected: ExpectedAppImageIdentity): void {
  if (
    !DIGEST_PATTERN.test(expected.artifactDigest)
    || !DIGEST_PATTERN.test(expected.executableIdentityDigest)
  ) throw new Error("The expected AppImage candidate identity is invalid.");
}

function requireIdentityMatch(
  actual: HeldAppImageIdentity,
  expected: ExpectedAppImageIdentity,
): void {
  if (
    actual.artifactDigest !== expected.artifactDigest
    || actual.executableIdentityDigest !== expected.executableIdentityDigest
  ) throw new Error("The held AppImage candidate identity does not match.");
}

/** Opens, hashes, and retains the exact direct file that the guardian executes. */
export async function holdAppImageCandidate(
  candidatePath: string,
  expected: ExpectedAppImageIdentity,
  deadlineAt?: string,
): Promise<HeldAppImageIdentity> {
  if (!exactPath(candidatePath)) {
    throw new Error("The AppImage candidate path is invalid.");
  }
  requireExpectedIdentity(expected);
  const deadline = deadlineAt === undefined ? null : Date.parse(deadlineAt);
  requireBeforeDeadline(deadline);
  const handle = await open(
    candidatePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const identity = await inspectHeldCandidate(candidatePath, handle, deadline);
    requireIdentityMatch(identity, expected);
    return identity;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Re-proves that an inherited executable fd is the named journal candidate. */
export async function validateExecutingAppImageCandidate(options: {
  readonly candidatePath: string;
  readonly fileDescriptor: number;
  readonly expected: ExpectedAppImageIdentity;
  readonly deadlineAt: string;
}): Promise<void> {
  if (
    !Number.isSafeInteger(options.fileDescriptor)
    || options.fileDescriptor < 3
    || options.fileDescriptor > 1_024
  ) throw new Error("The executing AppImage candidate descriptor is invalid.");
  requireExpectedIdentity(options.expected);
  const deadline = Date.parse(options.deadlineAt);
  requireBeforeDeadline(deadline);
  if (!exactPath(options.candidatePath)) {
    throw new Error("The AppImage candidate path is invalid.");
  }
  const namedHandle = await open(
    options.candidatePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let executionHandle: FileHandle | null = null;
  try {
    executionHandle = await open(
      `/proc/self/fd/${options.fileDescriptor}`,
      constants.O_RDONLY,
    );
    const namedIdentity = await inspectHeldCandidate(
      options.candidatePath,
      namedHandle,
      deadline,
    );
    requireIdentityMatch(namedIdentity, options.expected);
    const executionIdentity = await inspectOpenCandidate(
      executionHandle,
      deadline,
    );
    if (executionIdentity.artifactDigest !== options.expected.artifactDigest) {
      throw new Error("The executing AppImage candidate bytes do not match.");
    }
  } finally {
    await Promise.allSettled([
      namedHandle.close(),
      ...(executionHandle ? [executionHandle.close()] : []),
    ]);
  }
}
