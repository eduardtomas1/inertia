import * as nodeFs from "node:fs";
import { createRequire } from "node:module";

const MAX_HEADER_BYTES = 16 * 1_024 * 1_024;

function rawFileSystem(): typeof nodeFs {
  // Electron's normal fs can allocate an ASAR header or extract an entire
  // entry before callers can inspect its size. Read the archive bytes directly.
  return process.versions.electron
    ? createRequire(process.execPath)("original-fs") as typeof nodeFs
    : nodeFs;
}

function sameFile(left: nodeFs.BigIntStats, right: nodeFs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads only the bounded packed manifest from one held, unchanged raw archive. */
export function readLinuxSingletonManifest(archivePath: string, maxBytes: number): string {
  const fs = rawFileSystem();
  const named = fs.lstatSync(archivePath, { bigint: true });
  if (!named.isFile() || fs.realpathSync(archivePath) !== archivePath) {
    throw new Error("Invalid singleton archive.");
  }
  const fd = fs.openSync(archivePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFile(named, opened) || opened.size < 16n) {
      throw new Error("Invalid singleton archive identity.");
    }
    const read = (size: number, position: number): Buffer => {
      const bytes = Buffer.alloc(size);
      let length = 0;
      while (length < size) {
        const count = fs.readSync(fd, bytes, length, size - length, position + length);
        if (!count) throw new Error("Truncated singleton archive.");
        length += count;
      }
      return bytes;
    };
    const prefix = read(16, 0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    if (
      prefix.readUInt32LE(0) !== 4 || headerSize < jsonLength + 8
      || headerSize > MAX_HEADER_BYTES || jsonLength === 0
      || jsonLength > MAX_HEADER_BYTES || BigInt(8 + headerSize) > opened.size
    ) throw new Error("Invalid bounded singleton archive header.");
    const tree: unknown = JSON.parse(read(jsonLength, 16).toString("utf8"));
    const entry = object(tree) && object(tree.files) ? tree.files["package.json"] : null;
    if (
      !object(entry) || "files" in entry || "link" in entry || "unpacked" in entry
      || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size)
      || entry.size < 0 || entry.size > maxBytes
      || typeof entry.offset !== "string" || !/^(?:0|[1-9]\d*)$/u.test(entry.offset)
    ) throw new Error("Invalid bounded packed singleton manifest.");
    const offset = Number(entry.offset);
    const position = 8 + headerSize + offset;
    const end = position + entry.size;
    if (
      !Number.isSafeInteger(offset) || !Number.isSafeInteger(position)
      || !Number.isSafeInteger(end) || BigInt(end) > opened.size
    ) throw new Error("Invalid singleton manifest offset.");
    const content = read(entry.size, position);
    if (
      !sameFile(opened, fs.fstatSync(fd, { bigint: true }))
      || !sameFile(opened, fs.lstatSync(archivePath, { bigint: true }))
    ) throw new Error("The singleton archive changed during inspection.");
    return content.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
