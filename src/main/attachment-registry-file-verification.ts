import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AttachmentImportValidationReceipt } from "./attachment-import-file.js";
import {
  identity,
  type OpenedSecureFile,
  openVerifiedFile,
} from "./secure-file-io.js";

const VERIFICATION_ERROR =
  "Temporary attachment storage could not be verified safely.";

export async function verifyPinnedAttachmentDirectory(
  directory: string,
  authority: { readonly root: string; readonly identity: BigIntStats },
): Promise<string> {
  const { root, identity } = authority;
  const named = await lstat(directory, { bigint: true });
  if (
    !named.isDirectory() || named.isSymbolicLink()
    || named.dev !== identity.dev || named.ino !== identity.ino
    || await realpath(directory) !== root
    || (process.platform !== "win32" && ((named.mode & 0o777n) !== 0o700n
      || named.uid !== identity.uid))
  ) throw new Error(VERIFICATION_ERROR);
  return root;
}

export function isStablePrivateAttachment(
  before: BigIntStats,
  after: BigIntStats,
): boolean {
  return before.isFile()
    && after.isFile()
    && !before.isSymbolicLink()
    && !after.isSymbolicLink()
    && before.nlink === 1n
    && after.nlink === 1n
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
    && (
      process.platform === "win32"
      || (
        (before.mode & 0o777n) === 0o600n
        && (after.mode & 0o777n) === 0o600n
        && (
          typeof process.getuid !== "function"
          || (
            before.uid === BigInt(process.getuid())
            && after.uid === BigInt(process.getuid())
          )
        )
      )
    );
}

export async function verifyStoredAttachmentAfterValidation(options: {
  readonly before: BigIntStats;
  readonly expectedRoot: string;
  readonly expectedSize: number;
  readonly path: string;
  readonly receipt: AttachmentImportValidationReceipt;
  readonly resolveVerifiedRoot: () => Promise<string>;
  readonly signal: AbortSignal;
}): Promise<void> {
  const {
    before,
    expectedRoot,
    expectedSize,
    path,
    receipt,
    resolveVerifiedRoot,
    signal,
  } = options;
  signal.throwIfAborted();
  let verified: OpenedSecureFile;
  try {
    verified = await openVerifiedFile(path, expectedSize, identity(before));
  } catch {
    signal.throwIfAborted();
    throw new Error(VERIFICATION_ERROR);
  }
  try {
    signal.throwIfAborted();
    const [verifiedRoot, pinnedAfter, namedAfter, verifiedPath] =
      await Promise.all([
        resolveVerifiedRoot(),
        verified.handle.stat({ bigint: true }),
        lstat(path, { bigint: true }),
        realpath(path),
      ]);
    signal.throwIfAborted();
    if (
      verified.linkCount !== 1
      || verified.content.byteLength !== expectedSize
      || verified.metadata.size !== expectedSize
      || verified.metadata.size !== receipt.size
      || verified.metadata.digest !== receipt.digest
      || (
        process.platform !== "win32"
        && verified.metadata.mode !== 0o600
      )
      || verifiedRoot !== expectedRoot
      || !isStablePrivateAttachment(before, pinnedAfter)
      || !isStablePrivateAttachment(pinnedAfter, namedAfter)
      || verifiedPath !== join(verifiedRoot, basename(path))
      || dirname(verifiedPath) !== verifiedRoot
    ) {
      throw new Error(VERIFICATION_ERROR);
    }
  } finally {
    await verified.handle.close();
  }
  signal.throwIfAborted();
}
