import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type {
  SecureFileIdentity,
  SecureFileMetadata,
} from "../node/secure-file-protocol.js";

export type SecureFileOperationErrorCode =
  | "conflict"
  | "invalid"
  | "not-found"
  | "too-large"
  | "unsafe"
  | "unavailable";

export class SecureFileOperationError extends Error {
  constructor(
    readonly code: SecureFileOperationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function sameIdentity(
  left: SecureFileIdentity,
  right: SecureFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function identity(
  info: { dev: bigint; ino: bigint },
): SecureFileIdentity {
  return {
    dev: info.dev.toString(10),
    ino: info.ino.toString(10),
  };
}

export function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}

export async function readHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<{ content: Buffer; metadata: SecureFileMetadata }> {
  const info = await handle.stat();
  if (!info.isFile()) {
    throw new SecureFileOperationError(
      "unsafe",
      "The selected path is not a regular file.",
    );
  }
  if (info.size > maxBytes) {
    throw new SecureFileOperationError(
      "too-large",
      "The selected file exceeds the supported size limit.",
    );
  }
  const content = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < content.length) {
    const { bytesRead } = await handle.read(
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const bounded = content.subarray(0, offset);
  return {
    content: bounded,
    metadata: {
      digest: digest(bounded),
      size: bounded.byteLength,
      modifiedAt: info.mtime.toISOString(),
      mode: info.mode & 0o777,
    },
  };
}

export async function writeComplete(
  handle: Awaited<ReturnType<typeof open>>,
  content: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (bytesWritten < 1) {
      throw new SecureFileOperationError(
        "unavailable",
        "The selected file could not be written completely.",
      );
    }
    offset += bytesWritten;
  }
  await handle.truncate(content.length);
}

export interface OpenedSecureFile {
  handle: Awaited<ReturnType<typeof open>>;
  content: Buffer;
  fileIdentity: SecureFileIdentity;
  metadata: SecureFileMetadata;
  linkCount: number;
}

export async function openVerifiedFile(
  basename: string,
  maxBytes: number,
  expectedIdentity?: SecureFileIdentity,
): Promise<OpenedSecureFile> {
  const before = await lstat(basename, { bigint: true }).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new SecureFileOperationError(
      before ? "unsafe" : "not-found",
      "The selected file is missing or no longer safe.",
    );
  }
  if (
    expectedIdentity
    && !sameIdentity(identity(before), expectedIdentity)
  ) {
    throw new SecureFileOperationError(
      "conflict",
      "The selected file changed before it was opened.",
    );
  }
  const handle = await open(
    basename,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || !sameIdentity(identity(before), identity(opened))
    ) {
      throw new SecureFileOperationError(
        "unsafe",
        "The selected file changed while it was being opened.",
      );
    }
    const read = await readHandle(handle, maxBytes);
    return {
      handle,
      ...read,
      fileIdentity: identity(opened),
      linkCount: Number(opened.nlink),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export interface FileSnapshot {
  content: Buffer | null;
  fileIdentity: SecureFileIdentity;
  linkCount: number;
  metadata: SecureFileMetadata | null;
}

export async function snapshotNamedFile(
  name: string,
  maxBytes: number,
): Promise<FileSnapshot | null> {
  const before = await lstat(name, { bigint: true }).catch((error) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new SecureFileOperationError(
      "unsafe",
      "A secure save transaction contains an unsafe file.",
    );
  }
  const handle = await open(
    name,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || !sameIdentity(identity(before), identity(opened))
    ) {
      throw new SecureFileOperationError(
        "unsafe",
        "A secure save transaction changed while it was being inspected.",
      );
    }
    if (opened.size > BigInt(maxBytes)) {
      return {
        content: null,
        fileIdentity: identity(opened),
        linkCount: Number(opened.nlink),
        metadata: null,
      };
    }
    const read = await readHandle(handle, maxBytes);
    return {
      content: read.content,
      fileIdentity: identity(opened),
      linkCount: Number(opened.nlink),
      metadata: read.metadata,
    };
  } finally {
    await handle.close();
  }
}
