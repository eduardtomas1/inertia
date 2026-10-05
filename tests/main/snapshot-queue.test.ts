import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotFixture } from "../helpers/snapshot-fixture";
import { SNAPSHOT_QUEUE_LIMIT, SNAPSHOT_QUEUE_TTL_MS, SnapshotQueue } from "../../src/main/snapshot-queue";

const png = (seed: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([seed, 1, 2, 3])]);
let root = "";
let clock = 1_000_000;
const queue = (): SnapshotQueue => new SnapshotQueue(root, () => clock);
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "inertia-snapshot-queue-")); clock = 1_000_000; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("pending snapshot queue", () => {
  it("keeps captures oldest first in a private directory until they are removed", async () => {
    const pending = queue();
    expect(await pending.add(png(1), snapshotFixture())).toBe(true);
    clock += 1;
    expect(await pending.add(png(2), { ...snapshotFixture(), windowTitle: "Second" })).toBe(true);
    const items = await queue().take();
    expect(items.map(({ png: bytes, source }) => [bytes[8], source.windowTitle])).toEqual([[1, "Release checklist"], [2, "Second"]]);
    const directory = join(await realpath(root), "snapshot-queue");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(directory)) expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    await pending.remove(items.map(({ id }) => id));
    expect(await pending.take()).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses captures beyond its bound", async () => {
    const pending = queue();
    for (let index = 0; index < SNAPSHOT_QUEUE_LIMIT; index += 1) expect(await pending.add(png(index), snapshotFixture())).toBe(true);
    expect(await pending.add(png(9), snapshotFixture())).toBe(false);
    expect(await pending.count()).toBe(SNAPSHOT_QUEUE_LIMIT);
  });

  it("deletes captures whose lease expired instead of delivering them", async () => {
    const pending = queue();
    await pending.add(png(1), snapshotFixture());
    clock += SNAPSHOT_QUEUE_TTL_MS + 1;
    expect(await pending.take()).toEqual([]);
    expect(await readdir(join(root, "snapshot-queue"))).toEqual([]);
  });

  it("drops malformed, oversized and orphaned entries", async () => {
    const pending = queue();
    await pending.add(png(1), snapshotFixture());
    const directory = join(root, "snapshot-queue");
    const [json] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    await writeFile(join(directory, json!), JSON.stringify({ queuedAt: clock, source: { ...snapshotFixture(), width: 100_000 } }));
    await writeFile(join(directory, "00000000-0000-4000-8000-000000000000.png"), png(2));
    await writeFile(join(directory, "notes.txt"), "unrelated");
    expect(await pending.take()).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a queue directory that is a symbolic link out of application data", async () => {
    const outside = await mkdtemp(join(tmpdir(), "inertia-snapshot-outside-"));
    try {
      await symlink(outside, join(root, "snapshot-queue"));
      await expect(queue().add(png(1), snapshotFixture())).rejects.toThrow("Snapshot queue is unavailable.");
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("does not follow a symbolic link planted as a queued image", async () => {
    const pending = queue();
    await pending.add(png(1), snapshotFixture());
    const directory = join(root, "snapshot-queue");
    const image = (await readdir(directory)).find((name) => name.endsWith(".png"))!;
    const secret = join(root, "secret.png");
    await writeFile(secret, png(7));
    await rm(join(directory, image));
    await symlink(secret, join(directory, image));
    expect(await pending.take()).toEqual([]);
    expect(await readFile(secret)).toEqual(png(7));
    expect((await lstat(join(directory))).isDirectory()).toBe(true);
  });

  it("removes every queued capture when cleared", async () => {
    const pending = queue();
    await pending.add(png(1), snapshotFixture());
    await pending.clear();
    await expect(stat(join(root, "snapshot-queue"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await pending.count()).toBe(0);
    expect(pending.mayHaveEntries()).toBe(false);
  });

  it("reports nothing pending when the application data folder has no queue", async () => {
    await mkdir(join(root, "other"));
    expect(await queue().count()).toBe(0);
    await chmod(root, 0o700);
    expect(await queue().take()).toEqual([]);
  });

  it("prunes entries older than the lease even when their file times were changed", async () => {
    const pending = queue();
    await pending.add(png(1), snapshotFixture());
    const directory = join(root, "snapshot-queue");
    for (const name of await readdir(directory)) await utimes(join(directory, name), new Date(), new Date());
    clock += SNAPSHOT_QUEUE_TTL_MS + 1;
    await pending.prune();
    expect(await readdir(directory)).toEqual([]);
  });
});
