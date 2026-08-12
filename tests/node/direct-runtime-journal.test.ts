import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  pinDirectRuntimeJournalRoot,
  listDirectRuntimeJournalLeaves,
  readDirectRuntimeJournalLeaf,
} from "../../src/node/direct-runtime-journal";

const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("direct runtime journal I/O", () => {
  it.runIf(process.platform !== "win32")(
    "does not block if a regular leaf is replaced with a FIFO before open",
    () => {
      const path = mkdtempSync(join(tmpdir(), "inertia-direct-journal-"));
      directories.push(path);
      const name = ".runtime-test-leaf.json";
      const leaf = join(path, name);
      writeFileSync(leaf, "{}", { mode: 0o600 });
      const root = pinDirectRuntimeJournalRoot(path);

      expect(() => readDirectRuntimeJournalLeaf(root, name, 16, {
        beforeReadFileOpen: () => {
          rmSync(leaf);
          const result = spawnSync("mkfifo", [leaf], {
            shell: false,
            env: { PATH: "/usr/bin:/bin" },
          });
          expect(result.status).toBe(0);
        },
      })).toThrow();
      expect(lstatSync(leaf).isFIFO()).toBe(true);
    },
  );

  it("bounds an fd read when a writable alias grows the leaf", () => {
    const path = mkdtempSync(join(tmpdir(), "inertia-direct-journal-"));
    directories.push(path);
    const name = ".runtime-test-leaf.json";
    const leaf = join(path, name);
    writeFileSync(leaf, "{}");
    if (process.platform !== "win32") chmodSync(leaf, 0o600);
    const root = pinDirectRuntimeJournalRoot(path);

    expect(() => readDirectRuntimeJournalLeaf(root, name, 16, {
      afterReadFileOpened: () => {
        const writer = openSync(leaf, "a");
        try { writeFileSync(writer, Buffer.alloc(32, 0x61)); } finally { closeSync(writer); }
      },
    })).toThrow("changed while it was read");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a group- or world-accessible authority root and leaf",
    () => {
      const unsafeRoot = mkdtempSync(join(tmpdir(), "inertia-direct-journal-"));
      directories.push(unsafeRoot);
      chmodSync(unsafeRoot, 0o777);
      expect(() => pinDirectRuntimeJournalRoot(unsafeRoot)).toThrow("unsafe");

      const path = mkdtempSync(join(tmpdir(), "inertia-direct-journal-"));
      directories.push(path);
      const name = ".runtime-test-leaf.json";
      const leaf = join(path, name);
      writeFileSync(leaf, "{}", { mode: 0o600 });
      const root = pinDirectRuntimeJournalRoot(path);
      chmodSync(leaf, 0o666);
      expect(() => readDirectRuntimeJournalLeaf(root, name, 16)).toThrow("unsafe");
      expect(readFileSync(leaf, "utf8")).toBe("{}");
    },
  );

  it("bounds total root enumeration without hiding owned leaves", () => {
    const path = mkdtempSync(join(tmpdir(), "inertia-direct-journal-"));
    directories.push(path);
    for (let index = 0; index < 3; index += 1) {
      writeFileSync(join(path, `foreign-${index}`), "");
    }
    const owned = ".runtime-test-owned.json";
    writeFileSync(join(path, owned), "{}");
    const root = pinDirectRuntimeJournalRoot(path);
    expect(listDirectRuntimeJournalLeaves(root, ".runtime-test-", 3, 4))
      .toEqual([owned]);

    writeFileSync(join(path, "foreign-overflow"), "");
    expect(() => listDirectRuntimeJournalLeaves(root, ".runtime-test-", 3, 4))
      .toThrow("entry bound");
  });
});
