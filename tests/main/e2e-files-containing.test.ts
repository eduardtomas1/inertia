import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { filesContaining, isChromiumLockFile } from "../e2e/support/files-containing";

let directory = "";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: resource busy or locked, read`), { code });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "files-containing-"));
  await mkdir(join(directory, "Local Storage", "leveldb"), { recursive: true });
  await writeFile(join(directory, "wire.jsonl"), "sentinel-value\n");
  await writeFile(join(directory, "clean.txt"), "nothing here\n");
  await writeFile(join(directory, "Local Storage", "leveldb", "LOCK"), "");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("E2E file scan for a pasted secret", () => {
  it("retries a file that is briefly locked and still finds the needle", async () => {
    const target = join(directory, "wire.jsonl");
    let attempts = 0;
    const wait = vi.fn(async () => undefined);
    const read = vi.fn(async (path: string) => {
      if (path === target && attempts++ < 2) throw errno("EBUSY");
      return await readFile(path);
    });
    await expect(filesContaining(directory, "sentinel-value", { read, wait })).resolves.toEqual({
      matches: [target],
      unreadable: [],
    });
    expect(attempts).toBe(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it.each(["EBUSY", "EPERM", "EACCES"])("lists a file that stays locked with %s as unreadable and keeps scanning", async (code) => {
    const locked = join(directory, "Local Storage", "leveldb", "LOCK");
    const wait = vi.fn(async () => undefined);
    const read = vi.fn(async (path: string) => {
      if (path === locked) throw errno(code);
      return await readFile(path);
    });
    await expect(filesContaining(directory, "sentinel-value", { read, wait })).resolves.toEqual({
      matches: [join(directory, "wire.jsonl")],
      unreadable: [locked],
    });
    expect(read.mock.calls.filter(([path]) => path === locked)).toHaveLength(4);
  });

  it("skips a file that vanished and fails on any other read error", async () => {
    const vanished = join(directory, "clean.txt");
    const read = vi.fn(async (path: string) => {
      if (path === vanished) throw errno("ENOENT");
      return await readFile(path);
    });
    await expect(filesContaining(directory, "sentinel-value", { read })).resolves.toEqual({
      matches: [join(directory, "wire.jsonl")],
      unreadable: [],
    });
    const failing = vi.fn(async () => { throw errno("EIO"); });
    await expect(filesContaining(directory, "sentinel-value", { read: failing })).rejects.toThrow("EIO");
  });

  it.each([
    ["Local Storage/leveldb/LOCK", true],
    ["Session Storage/000003.log", true],
    ["IndexedDB/app_0.indexeddb.leveldb/000005.ldb", true],
    ["Code Cache/js/index/LOCK", true],
    ["Shared Dictionary/cache/lockfile", true],
    ["lockfile", true],
    ["Network/Cookies", false],
    ["runtime/diagnostics.log", false],
    ["Local Storage/leveldb/MANIFEST-000001", false],
    ["data/inertia.sqlite-wal", false],
  ])("treats %s as a Chromium lock or database file: %s", (relative, expected) => {
    expect(isChromiumLockFile(join(directory, ...relative.split("/")))).toBe(expected);
  });
});
