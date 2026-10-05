import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { FILE_OPEN_NO_FOLLOW } from "../node/platform-file-open-flags.js";

const FILE_MODE = 0o600;
const PRUNE_TEMPORARY_PATTERN = /^\.runtime-diagnostics-[0-9a-f-]{36}\.prune\.tmp$/u;

export type JournalWrite = (
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number,
) => number;

export interface DiagnosticJournalFilesOptions {
  directory: string;
  baseName: string;
  maxFileBytes: number;
  maxFiles: number;
  retentionMs: number;
  now: () => number;
  write: JournalWrite;
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
}

export function removeStalePruneFiles(directory: string): void {
  for (const name of readdirSync(directory)) {
    if (!PRUNE_TEMPORARY_PATTERN.test(name)) continue;
    const path = join(directory, name);
    const metadata = lstatSync(path);
    if (metadata.isFile() || metadata.isSymbolicLink()) unlinkSync(path);
  }
}

export class DiagnosticJournalFiles {
  readonly activePath: string;
  private readonly pattern: RegExp;

  constructor(private readonly options: DiagnosticJournalFilesOptions) {
    this.activePath = join(options.directory, `${options.baseName}.log`);
    this.pattern = new RegExp(`^${options.baseName}(?:\\.\\d+)?\\.log$`, "u");
  }

  owns(name: string): boolean {
    return this.pattern.test(name);
  }

  appendRecord(line: string, durable = true): void {
    this.rotateIfNeeded(Buffer.byteLength(line));
    this.append(line, durable);
  }

  readLines(): string[] {
    const active = `${this.options.baseName}.log`;
    const names = readdirSync(this.options.directory)
      .filter((name) => this.pattern.test(name))
      .sort((left, right) => {
        if (left === active) return 1;
        if (right === active) return -1;
        const leftIndex = Number(left.match(/\.(\d+)\./u)?.[1] ?? 0);
        const rightIndex = Number(right.match(/\.(\d+)\./u)?.[1] ?? 0);
        return rightIndex - leftIndex;
      }).slice(-this.options.maxFiles);
    const lines: string[] = [];
    for (const name of names) {
      let content: string;
      try {
        const path = join(this.options.directory, name);
        const metadata = lstatSync(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
        try {
          const opened = fstatSync(descriptor);
          if (
            !opened.isFile()
            || opened.dev !== metadata.dev
            || opened.ino !== metadata.ino
          ) continue;
          const bytes = Buffer.allocUnsafe(
            Math.min(this.options.maxFileBytes, Math.max(0, opened.size)),
          );
          const read = bytes.length > 0
            ? readSync(descriptor, bytes, 0, bytes.length, 0)
            : 0;
          content = bytes.subarray(0, read).toString("utf8");
        } finally {
          closeSync(descriptor);
        }
      } catch {
        continue;
      }
      for (const line of content.split(/\r?\n/u)) {
        if (line) lines.push(line);
      }
    }
    return lines;
  }

  clear(): void {
    for (const name of readdirSync(this.options.directory)) {
      if (!this.pattern.test(name)) continue;
      const path = join(this.options.directory, name);
      const metadata = lstatSync(path);
      if (metadata.isFile() || metadata.isSymbolicLink()) unlinkSync(path);
    }
  }

  prune(cutoff: number, pruneRecords: boolean): void {
    for (const name of readdirSync(this.options.directory)) {
      if (!this.pattern.test(name)) continue;
      const path = join(this.options.directory, name);
      const metadata = lstatSync(path);
      if (
        metadata.isSymbolicLink()
        || !metadata.isFile()
        || metadata.mtimeMs < cutoff
        || metadata.size > this.options.maxFileBytes
      ) {
        unlinkSync(path);
        continue;
      }
      if (pruneRecords) this.pruneExpiredRecords(path, metadata, cutoff);
    }
  }

  private append(line: string, durable: boolean): void {
    const descriptor = openSync(
      this.activePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollowFlag(),
      FILE_MODE,
    );
    try {
      fchmodSync(descriptor, FILE_MODE);
      const bytes = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = this.options.write(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
        );
        if (!Number.isInteger(written) || written <= 0) {
          throw new Error("The runtime diagnostic record could not be written.");
        }
        offset += Math.min(written, bytes.length - offset);
      }
      if (durable) fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private rotatedPath(index: number): string {
    return join(this.options.directory, `${this.options.baseName}.${index}.log`);
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (!existsSync(this.activePath)) return;
    const current = lstatSync(this.activePath);
    if (current.isSymbolicLink() || !current.isFile()) {
      unlinkSync(this.activePath);
      return;
    }
    if (current.size + incomingBytes <= this.options.maxFileBytes) return;
    this.rotateActive();
  }

  private rotateActive(): void {
    const last = this.rotatedPath(this.options.maxFiles - 1);
    if (existsSync(last)) unlinkSync(last);
    for (let index = this.options.maxFiles - 2; index >= 1; index -= 1) {
      const source = this.rotatedPath(index);
      if (!existsSync(source)) continue;
      const target = this.rotatedPath(index + 1);
      if (existsSync(target)) unlinkSync(target);
      renameSync(source, target);
      chmodSync(target, FILE_MODE);
    }
    if (existsSync(this.activePath)) {
      renameSync(this.activePath, this.rotatedPath(1));
      chmodSync(this.rotatedPath(1), FILE_MODE);
    }
  }

  private pruneExpiredRecords(
    path: string,
    metadata: Stats,
    cutoff: number,
  ): void {
    if (metadata.size === 0) return;
    const noFollow = noFollowFlag();
    const descriptor = openSync(path, constants.O_RDONLY | noFollow);
    let content: string;
    try {
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile()
        || opened.dev !== metadata.dev
        || opened.ino !== metadata.ino
        || opened.size !== metadata.size
      ) return;
      const bytes = Buffer.allocUnsafe(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (read <= 0) return;
        offset += read;
      }
      content = bytes.toString("utf8");
    } finally {
      closeSync(descriptor);
    }
    let expired = false;
    const retained = content.split(/\r?\n/u).filter((line) => {
      if (!line) return false;
      try {
        const value = JSON.parse(line) as { at?: unknown };
        if (typeof value.at !== "string") return false;
        const timestamp = Date.parse(value.at);
        if (!Number.isFinite(timestamp)) return false;
        if (timestamp < cutoff) {
          expired = true;
          return false;
        }
        return true;
      } catch {
        return false;
      }
    });
    if (!expired) return;
    const current = lstatSync(path);
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.dev !== metadata.dev
      || current.ino !== metadata.ino
      || current.size !== metadata.size
      || current.mtimeMs !== metadata.mtimeMs
    ) return;
    if (retained.length === 0) {
      unlinkSync(path);
      return;
    }
    const temporary = join(
      this.options.directory,
      `.runtime-diagnostics-${randomUUID()}.prune.tmp`,
    );
    const output = Buffer.from(`${retained.join("\n")}\n`, "utf8");
    let temporaryDescriptor: number | null = null;
    try {
      temporaryDescriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        FILE_MODE,
      );
      fchmodSync(temporaryDescriptor, FILE_MODE);
      let offset = 0;
      while (offset < output.length) {
        const written = writeSync(
          temporaryDescriptor,
          output,
          offset,
          output.length - offset,
        );
        if (written <= 0) return;
        offset += written;
      }
      fsyncSync(temporaryDescriptor);
      closeSync(temporaryDescriptor);
      temporaryDescriptor = null;
      const unchanged = lstatSync(path);
      if (
        unchanged.isFile()
        && !unchanged.isSymbolicLink()
        && unchanged.dev === metadata.dev
        && unchanged.ino === metadata.ino
        && unchanged.size === metadata.size
        && unchanged.mtimeMs === metadata.mtimeMs
      ) {
        renameSync(temporary, path);
        chmodSync(path, FILE_MODE);
      }
    } finally {
      if (temporaryDescriptor !== null) closeSync(temporaryDescriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
