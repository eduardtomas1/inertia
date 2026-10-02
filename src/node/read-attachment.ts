import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

export async function readAttachment(
  file: FileHandle,
  size: number,
  captureBytes: number,
  signal?: AbortSignal,
  onChunk?: (bytes: Buffer) => void,
): Promise<{ bytes: Buffer; digest: string }> {
  const bytes = Buffer.alloc(Math.min(size, captureBytes));
  const chunk = Buffer.allocUnsafe(256 * 1024);
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (bytesRead === 0) throw new Error("Attachment content changed.");
    const data = chunk.subarray(0, bytesRead);
    hash.update(data);
    onChunk?.(data);
    if (offset < bytes.length) data.copy(bytes, offset, 0, Math.min(data.length, bytes.length - offset));
    offset += bytesRead;
  }
  if ((await file.read(chunk, 0, 1, size)).bytesRead !== 0) throw new Error("Attachment content changed.");
  return { bytes, digest: hash.digest("hex") };
}

export interface AttachmentFileSource {
  readonly path: string;
  readonly digest: string;
}
