import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { journalDirectoryIdentityMatches } from "../../src/node/pinned-journal-directory";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";

const directories: string[] = [];
const generationA = "11111111-1111-4111-8111-111111111111:1";
const generationB = "22222222-2222-4222-8222-222222222222:2";
const bootA = "linux:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bootB = "linux:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "inertia-generation-leases-"));
  directories.push(path);
  return path;
}

function redirectDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("runtime generation lease journal", () => {
  it("distinguishes adjacent high-bit directory identities without number rounding", () => {
    const firstInode = 9_007_199_254_740_992n;
    const secondInode = firstInode + 1n;
    expect(Number(firstInode)).toBe(Number(secondInode));
    expect(journalDirectoryIdentityMatches(
      { device: 1n, inode: firstInode },
      { dev: 1n, ino: secondInode },
    )).toBe(false);
  });

  it("persists exact main-owned generations across app reconstruction", () => {
    const path = directory();
    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.publish(generationA, bootA)).toBe(true);
    expect(journal.publish(generationB, bootA)).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(path).all().map(
      ({ runtimeGenerationId }) => runtimeGenerationId,
    )).toEqual([generationA, generationB]);
  });

  it("rejects a boot-identity conflict without replacing the lease", () => {
    const path = directory();
    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.publish(generationA, bootA)).toBe(true);
    expect(journal.publish(generationA, bootB)).toBe(false);
    expect(new RuntimeGenerationLeaseJournal(path).all()[0]?.systemBootId).toBe(bootA);
  });

  it("clears exact receipts and only credible prior boot sessions", () => {
    const path = directory();
    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.publish(generationA, bootA)).toBe(true);
    expect(journal.publish(generationB, "unavailable")).toBe(true);
    expect(journal.clearRuntimeGeneration(generationA)).toBe(true);
    expect(journal.all().map(({ runtimeGenerationId }) => runtimeGenerationId)).toEqual([
      generationB,
    ]);
    expect(journal.clearPriorBootSessions(bootB)).toBe(true);
    expect(journal.all()).toHaveLength(1);
    expect(journal.clearPriorBootSessions("unavailable")).toBe(true);
    expect(journal.all()).toHaveLength(1);
  });

  it("recovers exact publisher and consumer transients after a crash", () => {
    const path = directory();
    const leaseDirectory = join(path, ".runtime-generation-leases");
    const temporary = ".aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp";
    const consuming = ".bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.consume";
    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.publish(generationA, bootA)).toBe(true);
    const canonical = readdirSync(leaseDirectory)[0]!;
    copyFileSync(join(leaseDirectory, canonical), join(leaseDirectory, temporary));
    expect(new RuntimeGenerationLeaseJournal(path).all()).toHaveLength(1);
    expect(readdirSync(leaseDirectory)).toEqual([canonical]);

    renameSync(join(leaseDirectory, canonical), join(leaseDirectory, consuming));
    expect(new RuntimeGenerationLeaseJournal(path).safetyLocked()).toBe(false);
    expect(readdirSync(leaseDirectory)).toEqual([]);
  });

  it("preserves and rejects malformed or foreign entries", () => {
    const path = directory();
    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.publish(generationA, bootA)).toBe(true);
    const leaseDirectory = join(path, ".runtime-generation-leases");
    writeFileSync(join(leaseDirectory, "foreign.tmp"), "foreign");
    const reopened = new RuntimeGenerationLeaseJournal(path);
    expect(reopened.isValid()).toBe(false);
    expect(reopened.safetyLocked()).toBe(true);
    expect(reopened.clearRuntimeGeneration(generationA)).toBe(false);
  });

  it("rejects a pre-existing journal redirect without touching its target", () => {
    const path = directory();
    const outside = directory();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "outside");
    redirectDirectory(outside, join(path, ".runtime-generation-leases"));

    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.isValid()).toBe(false);
    expect(journal.safetyLocked()).toBe(true);
    expect(journal.all()).toEqual([]);
    expect(journal.publish(generationA, bootA)).toBe(false);
    expect(journal.clearRuntimeGeneration(generationA)).toBe(false);
    expect(journal.clearPriorBootSessions(bootB)).toBe(false);
    expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
    expect(readFileSync(sentinel, "utf8")).toBe("outside");
  });

  it("fails closed when the pinned journal directory is replaced", () => {
    const path = directory();
    const journalDirectory = join(path, ".runtime-generation-leases");
    const retainedDirectory = join(path, "retained-generation-leases");
    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.publish(generationA, bootA)).toBe(true);
    renameSync(journalDirectory, retainedDirectory);
    mkdirSync(journalDirectory);
    const sentinel = join(journalDirectory, "sentinel.txt");
    writeFileSync(sentinel, "replacement");

    expect(journal.publish(generationB, bootA)).toBe(false);
    expect(journal.clearRuntimeGeneration(generationA)).toBe(false);
    expect(journal.clearPriorBootSessions(bootB)).toBe(false);
    expect(journal.isValid()).toBe(false);
    expect(readdirSync(journalDirectory)).toEqual(["sentinel.txt"]);
    expect(readFileSync(sentinel, "utf8")).toBe("replacement");
    expect(readdirSync(retainedDirectory)).toHaveLength(1);
  });
});
