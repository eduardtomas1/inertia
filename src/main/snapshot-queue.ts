import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SNAPSHOT_MAX_IMAGE_BYTES, SNAPSHOT_MAX_SOURCE_BYTES, snapshotSourceSchema, type SnapshotSource } from "../shared/snapshots.js";

export const SNAPSHOT_QUEUE_LIMIT = 4;
export const SNAPSHOT_QUEUE_TTL_MS = 10 * 60_000;
export interface QueuedSnapshot { id: string; png: Buffer; source: SnapshotSource }

const ENTRY = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const metadataSchema = z.object({ queuedAt: z.number().int().nonnegative(), source: snapshotSourceSchema }).strict();

async function missing<T>(operation: Promise<T>): Promise<T | null> {
  return await operation.catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

function parseJson(bytes: Buffer | null): unknown {
  try { return bytes ? JSON.parse(bytes.toString("utf8")) as unknown : null; } catch { return null; }
}

async function readContained(path: string, limit: number): Promise<Buffer | null> {
  const handle = await missing(open(path, constants.O_RDONLY | constants.O_NOFOLLOW)).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    return stat.isFile() && stat.size <= limit ? await handle.readFile() : null;
  } finally { await handle.close(); }
}

export class SnapshotQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private known: boolean | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly root: string, private readonly now: () => number = Date.now) {}

  mayHaveEntries(): boolean { return this.known !== false; }

  add(png: Buffer, source: SnapshotSource): Promise<boolean> {
    return this.serial(async () => {
      const directory = await this.directory(true);
      if (!directory) throw new Error("Snapshot queue is unavailable.");
      if ((await this.scan(directory)).length >= SNAPSHOT_QUEUE_LIMIT) return false;
      const id = randomUUID();
      const image = await open(join(directory, `${id}.png`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await image.writeFile(png); } finally { await image.close(); }
      const temporary = join(directory, `${id}.json.tmp`);
      const metadata = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await metadata.writeFile(JSON.stringify({ queuedAt: this.now(), source })); } finally { await metadata.close(); }
      await rename(temporary, join(directory, `${id}.json`));
      this.known = true;
      if (!this.timer) this.schedule(SNAPSHOT_QUEUE_TTL_MS + 1);
      return true;
    });
  }

  count(): Promise<number> {
    return this.serial(async () => {
      const directory = await this.directory(false);
      return directory ? (await this.scan(directory)).length : 0;
    });
  }

  take(): Promise<QueuedSnapshot[]> {
    return this.serial(async () => {
      const directory = await this.directory(false);
      return directory ? await this.scan(directory) : [];
    });
  }

  prune(): Promise<void> { return this.take().then(() => undefined); }

  remove(ids: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const directory = await this.directory(false);
      if (!directory) return;
      await Promise.all(ids.filter((id) => ENTRY.test(`${id}.json`)).flatMap((id) => [
        rm(join(directory, `${id}.json`), { force: true }), rm(join(directory, `${id}.png`), { force: true }),
      ]));
      await this.scan(directory);
    });
  }

  clear(): Promise<void> {
    return this.serial(async () => {
      this.schedule(null);
      const directory = await this.directory(false);
      if (directory) await rm(directory, { recursive: true, force: true });
      this.known = false;
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private schedule(delay: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (delay === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.prune().catch(() => undefined);
    }, Math.max(0, delay));
    this.timer.unref();
  }

  private async directory(create: boolean): Promise<string | null> {
    const root = await missing(realpath(this.root));
    if (!root) { this.known = false; return null; }
    const directory = join(root, "snapshot-queue");
    if (create) await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const stat = await missing(lstat(directory));
    if (!stat) { this.known = false; return null; }
    if (!stat.isDirectory() || await realpath(directory) !== directory) throw new Error("Snapshot queue is unavailable.");
    return directory;
  }

  private async scan(directory: string): Promise<QueuedSnapshot[]> {
    const names = await readdir(directory);
    const entries: (QueuedSnapshot & { queuedAt: number })[] = [];
    const keep = new Set<string>();
    for (const name of names) {
      const id = ENTRY.exec(name)?.[1];
      if (!id) continue;
      const metadata = await readContained(join(directory, name), SNAPSHOT_MAX_SOURCE_BYTES + 1024);
      const parsed = metadataSchema.safeParse(parseJson(metadata));
      if (!parsed.success || this.now() - parsed.data.queuedAt > SNAPSHOT_QUEUE_TTL_MS || parsed.data.queuedAt > this.now()) continue;
      const png = await readContained(join(directory, `${id}.png`), SNAPSHOT_MAX_IMAGE_BYTES);
      if (!png || png.length <= 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) continue;
      entries.push({ id, png, source: parsed.data.source, queuedAt: parsed.data.queuedAt });
      keep.add(name); keep.add(`${id}.png`);
    }
    await Promise.all(names.filter((name) => !keep.has(name)).map((name) => rm(join(directory, name), { recursive: true, force: true })));
    this.known = entries.length > 0;
    const oldest = Math.min(...entries.map(({ queuedAt }) => queuedAt));
    this.schedule(entries.length > 0 ? oldest + SNAPSHOT_QUEUE_TTL_MS + 1 - this.now() : null);
    return entries.sort((left, right) => left.queuedAt - right.queuedAt).slice(0, SNAPSHOT_QUEUE_LIMIT)
      .map(({ id, png, source }) => ({ id, png, source }));
  }
}
