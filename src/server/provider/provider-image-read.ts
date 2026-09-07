import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import {
  MAX_CHAT_ATTACHMENT_BYTES as MAX_IMAGE_FILE_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES as MAX_IMAGE_BYTES,
} from "../../shared/attachments";

const IMAGE_READ_CHUNK_BYTES = 64 * 1024;

export async function readBoundedProviderImage(
  providerName: string,
  path: string,
  accumulatedBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfProviderImageAborted(providerName, signal);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`A ${providerName} image attachment is not a regular file.`);
  }
  const nonBlocking = "O_NONBLOCK" in fsConstants
    ? fsConstants.O_NONBLOCK
    : 0;
  const file = await open(
    path,
    fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW | nonBlocking,
  );
  try {
    throwIfProviderImageAborted(providerName, signal);
    const initial = await file.stat({ bigint: true });
    if (
      !initial.isFile()
      || !sameFileIdentity(before, initial)
      || initial.size <= 0n
    ) {
      throw new Error(`A ${providerName} image attachment is empty or not a regular file.`);
    }
    if (initial.size > BigInt(MAX_IMAGE_FILE_BYTES)) {
      throw new Error(`A ${providerName} image attachment exceeds the 10 MB safety limit.`);
    }
    if (initial.size > BigInt(MAX_IMAGE_BYTES - accumulatedBytes)) {
      throw new Error(`${providerName} image attachments exceed the 20 MB safety limit.`);
    }

    // Allocate only after fstat proves both per-file and aggregate bounds. Read
    // through the retained descriptor so a path replacement cannot redirect us.
    const data = Buffer.allocUnsafe(Number(initial.size));
    let offset = 0;
    while (offset < data.byteLength) {
      throwIfProviderImageAborted(providerName, signal);
      const length = Math.min(IMAGE_READ_CHUNK_BYTES, data.byteLength - offset);
      const { bytesRead } = await file.read(data, offset, length, offset);
      if (bytesRead === 0) {
        throw new Error(`A ${providerName} image attachment changed while it was being read.`);
      }
      offset += bytesRead;
    }
    throwIfProviderImageAborted(providerName, signal);
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await file.read(
      trailing,
      0,
      1,
      data.byteLength,
    );
    const final = await file.stat({ bigint: true });
    if (trailingBytes !== 0 || !sameFileSnapshot(initial, final)) {
      throw new Error(`A ${providerName} image attachment changed while it was being read.`);
    }
    return data;
  } finally {
    await file.close();
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function throwIfProviderImageAborted(providerName: string, signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error(`${providerName} image attachment preparation was cancelled.`);
  error.name = "AbortError";
  throw error;
}
