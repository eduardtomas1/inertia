import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AttachmentImportValidationReceipt } from "./attachment-import-file.js";
import { constants } from "node:fs";
import { FILE_OPEN_NO_FOLLOW } from "../node/platform-file-open-flags.js";
import { readAttachment } from "../node/read-attachment.js";

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
  readonly normalized?: boolean;
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
  const handle = await open(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.nlink !== 1n || Number(opened.size) !== expectedSize
      || (!options.normalized && !isStablePrivateAttachment(before, opened))) throw new Error(VERIFICATION_ERROR);
    const verified = await readAttachment(handle, expectedSize, 0, signal);
    const [verifiedRoot, pinnedAfter, namedAfter, verifiedPath] =
      await Promise.all([
        resolveVerifiedRoot(),
        handle.stat({ bigint: true }),
        lstat(path, { bigint: true }),
        realpath(path),
      ]);
    signal.throwIfAborted();
    if (
      verified.digest !== receipt.digest
      || receipt.size !== expectedSize
      || verifiedRoot !== expectedRoot
      || !isStablePrivateAttachment(opened, pinnedAfter)
      || !isStablePrivateAttachment(pinnedAfter, namedAfter)
      || verifiedPath !== join(verifiedRoot, basename(path))
      || dirname(verifiedPath) !== verifiedRoot
    ) {
      throw new Error(VERIFICATION_ERROR);
    }
  } finally {
    await handle.close();
  }
  signal.throwIfAborted();
}

export function assertAttachmentImportReceipt(
  attachment: import("./attachment-import.js").PreparedAttachmentMetadata,
  receipt: AttachmentImportValidationReceipt,
): void {
  const normalized = receipt.normalized === true && attachment.mimeType.startsWith("image/") && receipt.mimeType === "image/jpeg"
    && receipt.extension === "jpg" && receipt.size <= 10 * 1024 * 1024
    && receipt.displayName === attachment.displayName.replace(/\.[^.]+$/u, "") + ".jpg";
  if (!normalized && (receipt.displayName !== attachment.displayName || receipt.mimeType !== attachment.mimeType
    || receipt.extension !== attachment.extension || receipt.size !== attachment.size)) throw new Error(VERIFICATION_ERROR);
}

export function attachmentPreviewLimit(mimeType: string | undefined): number {
  return mimeType?.startsWith("text/") || mimeType === "application/json" ? 1024 * 1024 : 50 * 1024 * 1024;
}
