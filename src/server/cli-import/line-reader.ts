import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

export const CLI_RECORD_MAX_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
export const CLI_HEAD_CHUNK_BYTES = 16 * 1024;

export class CliTranscriptDeadline extends Error {}

export interface CliLineRead { bytes: number; revision: string; droppedRecords: number; complete: boolean }

export async function readCliLines(handle: FileHandle, options: {
  size: number;
  deadline: number;
  limit?: number;
  maxLineBytes?: number;
  chunkBytes?: number;
  signal?: AbortSignal;
  onLine(line: string, terminated: boolean): boolean | void;
  onDropped?(): void;
}): Promise<CliLineRead> {
  const maxLineBytes = options.maxLineBytes ?? CLI_RECORD_MAX_BYTES;
  const limit = Math.min(options.limit ?? Number.POSITIVE_INFINITY, options.size + 1);
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(options.chunkBytes ?? CHUNK_BYTES);
  let parts: Buffer[] = [];
  let lineBytes = 0;
  let skipping = false;
  let droppedRecords = 0;
  let bytes = 0;
  let ended = false;
  let stopped = false;
  const append = (segment: Buffer): void => {
    if (skipping || !segment.length) return;
    lineBytes += segment.length;
    if (lineBytes > maxLineBytes) {
      skipping = true;
      droppedRecords += 1;
      parts = [];
      options.onDropped?.();
      return;
    }
    parts.push(Buffer.from(segment));
  };
  const emit = (terminated: boolean): void => {
    if (!skipping && (terminated || lineBytes > 0) && options.onLine(Buffer.concat(parts).toString("utf8"), terminated) === true) stopped = true;
    parts = [];
    lineBytes = 0;
    skipping = false;
  };
  while (bytes < limit && !stopped) {
    options.signal?.throwIfAborted();
    if (Date.now() > options.deadline) throw new CliTranscriptDeadline("Reading the CLI transcript took too long.");
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, limit - bytes), bytes);
    if (!bytesRead) { ended = true; break; }
    const data = chunk.subarray(0, bytesRead);
    hash.update(data);
    bytes += bytesRead;
    let start = 0;
    for (let newline = data.indexOf(10); newline >= 0 && !stopped; newline = data.indexOf(10, start)) {
      append(data.subarray(start, newline));
      emit(true);
      start = newline + 1;
    }
    if (!stopped) append(data.subarray(start));
  }
  if (!stopped) emit(false);
  return { bytes, revision: hash.digest("hex"), droppedRecords, complete: ended && bytes <= options.size };
}
