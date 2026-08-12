import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const GENERATED_DIRECTORY = "runtime-generated-attachments";
const MAX_GENERATED_RECORDS = 256;
const MAX_GENERATED_BYTES = 512 * 1024 * 1024;
const GENERATED_JPEG_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/iu;
const TRANSIENT_UNLINK_CODES = new Set(["EACCES", "EBUSY", "EPERM", "ETXTBSY"]);

export interface PrivateGeneratedAttachmentStoreLimits {
  readonly maxBytes?: number;
  readonly maxRecords?: number;
  /** Retain and inventory prior files while provider cleanup is unconfirmed. */
  readonly preserveExisting?: boolean;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function contained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation !== ".."
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}

async function unlinkGenerated(path: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return;
      if (!code || !TRANSIENT_UNLINK_CODES.has(code) || attempt === 2) throw error;
      await wait(25 * 2 ** attempt);
    }
  }
}

async function secureGeneratedDirectory(dataDirectory: string): Promise<string> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const parent = await realpath(dataDirectory);
  const requested = join(parent, GENERATED_DIRECTORY);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const named = await lstat(requested);
  if (!named.isDirectory() || named.isSymbolicLink()) {
    throw new Error("Generated attachment storage is not a safe directory.");
  }
  if (process.platform !== "win32") await chmod(requested, 0o700);
  const canonical = await realpath(requested);
  const verified = await lstat(canonical);
  if (
    dirname(canonical) !== parent
    || !contained(parent, canonical)
    || !verified.isDirectory()
    || verified.isSymbolicLink()
    || (
      process.platform !== "win32"
      && (verified.mode & 0o777) !== 0o700
    )
    || (
      typeof process.getuid === "function"
      && verified.uid !== process.getuid()
    )
  ) throw new Error("Generated attachment storage could not be secured.");
  return canonical;
}

export class PrivateGeneratedAttachmentStore {
  private readonly records: Map<string, number>;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    readonly directory: string,
    limits: PrivateGeneratedAttachmentStoreLimits,
    records: Map<string, number>,
  ) {
    this.records = records;
    this.maxBytes = Math.max(1, Math.min(
      MAX_GENERATED_BYTES,
      Math.trunc(limits.maxBytes ?? MAX_GENERATED_BYTES),
    ));
    this.maxRecords = Math.max(1, Math.min(
      MAX_GENERATED_RECORDS,
      Math.trunc(limits.maxRecords ?? MAX_GENERATED_RECORDS),
    ));
  }

  static async create(
    dataDirectory: string,
    limits: PrivateGeneratedAttachmentStoreLimits = {},
  ): Promise<PrivateGeneratedAttachmentStore> {
    const directory = await secureGeneratedDirectory(resolve(dataDirectory));
    const records = new Map<string, number>();
    for (const name of await readdir(directory)) {
      if (!GENERATED_JPEG_NAME.test(name)) {
        throw new Error("Generated attachment storage contains an unexpected entry.");
      }
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        if (limits.preserveExisting) {
          throw new Error("Generated attachment storage contains an unsafe entry.");
        }
        await unlinkGenerated(path);
        continue;
      }
      if (limits.preserveExisting) records.set(path, info.size);
      else await unlinkGenerated(path);
    }
    const store = new PrivateGeneratedAttachmentStore(directory, limits, records);
    const usage = store.usage();
    if (usage.records > store.maxRecords || usage.bytes > store.maxBytes) {
      throw new Error("Generated attachment storage exceeds its safe capacity.");
    }
    return store;
  }

  usage(): { bytes: number; records: number } {
    return {
      records: this.records.size,
      bytes: [...this.records.values()].reduce((total, size) => total + size, 0),
    };
  }

  async writeJpeg(bytes: Uint8Array): Promise<string> {
    return await this.serialize(async () => {
      const usage = this.usage();
      if (
        usage.records + 1 > this.maxRecords
        || usage.bytes + bytes.byteLength > this.maxBytes
      ) throw new Error("Generated attachment storage is full.");
      const path = join(this.directory, `${randomUUID()}.jpg`);
      const file = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await file.writeFile(bytes);
      } catch (error) {
        await file.close().catch(() => undefined);
        await unlinkGenerated(path).catch(() => undefined);
        throw error;
      } finally {
        await file.close().catch(() => undefined);
      }
      this.records.set(path, bytes.byteLength);
      return path;
    });
  }

  async release(paths: readonly string[]): Promise<void> {
    await this.serialize(async () => {
      const owned: string[] = [];
      for (const path of new Set(paths)) {
        if (
          dirname(path) !== this.directory
          || !GENERATED_JPEG_NAME.test(basename(path))
        ) throw new Error("A generated attachment lease is invalid.");
        if (this.records.has(path)) owned.push(path);
      }
      const settled = await Promise.allSettled(owned.map(async (path) => {
        await unlinkGenerated(path);
        this.records.delete(path);
      }));
      const failed = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) {
        throw failed.reason;
      }
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let unlock!: () => void;
    this.mutationTail = new Promise<void>((resolveMutation) => {
      unlock = resolveMutation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }
}
