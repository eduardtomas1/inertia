import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { snapshotFixture } from "../helpers/snapshot-fixture";
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, constants: { ...fs.constants, O_NOFOLLOW: 0 } };
});
import { SnapshotQueue } from "../../src/main/snapshot-queue";

const png = (seed: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([seed, 1, 2, 3])]);
let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "inertia-snapshot-queue-links-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each(["image", "metadata"])("refuses a link planted as a queued %s where the platform cannot refuse it while opening, as on Windows", async (planted) => {
  const pending = new SnapshotQueue(root);
  await pending.add(png(1), snapshotFixture());
  const directory = join(root, "snapshot-queue");
  const name = (await readdir(directory)).find((entry) => entry.endsWith(planted === "image" ? ".png" : ".json"))!;
  const target = join(root, `outside-${name}`);
  await writeFile(target, await readFile(join(directory, name)));
  await rm(join(directory, name));
  await symlink(target, join(directory, name));
  expect(await pending.take()).toEqual([]);
  expect(await readdir(directory)).toEqual([]);
  expect((await readFile(target)).length).toBeGreaterThan(0);
});
