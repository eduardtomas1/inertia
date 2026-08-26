import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LegacyRuntimeRecoveryAuthorityJournal } from "../../src/main/runtime-legacy-recovery-authorities";

const directories: string[] = [];
const generationA = "11111111-1111-4111-8111-111111111111:1";
const generationB = "22222222-2222-4222-8222-222222222222:2";
const bootId = "test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prefix = ".runtime-legacy-recovery-authority-";

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "inertia-legacy-recovery-"));
  directories.push(path);
  return path;
}

function canonicalName(generationId: string): string {
  return `${prefix}${createHash("sha256").update(generationId).digest("hex")}.json`;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("legacy runtime recovery authority journal", () => {
  it("persists exact platform-bound authorities and consumes them once", () => {
    const path = directory();
    const journal = new LegacyRuntimeRecoveryAuthorityJournal(path);
    expect(journal.publish(generationA, "win32", bootId)).toBe(true);
    expect(journal.publish(generationB, "darwin", bootId)).toBe(true);

    const replay = new LegacyRuntimeRecoveryAuthorityJournal(path);
    expect(replay.pending("win32", bootId)).toEqual([generationA]);
    expect(replay.pending("darwin", bootId)).toEqual([generationB]);
    expect(replay.pending("win32", "test:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))
      .toEqual([]);
    expect(replay.has(generationA, "win32", bootId)).toBe(true);
    expect(replay.has(
      generationA,
      "win32",
      "test:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    )).toBe(false);
    expect(replay.has(generationA, "win32", "unavailable")).toBe(false);
    expect(replay.consume(generationA, "win32", bootId)).toBe(true);
    expect(replay.consume(generationA, "win32", bootId)).toBe(false);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(path)
      .pending("win32", bootId))
      .toEqual([]);
  });

  it("binds probe-unavailable compatibility recovery to the exact batch", () => {
    const path = directory();
    const journal = new LegacyRuntimeRecoveryAuthorityJournal(path);
    expect(journal.publishBatch(
      [generationA, generationB],
      "win32",
      "unavailable",
    )).toBe(true);
    expect(journal.pending("win32", "unavailable")).toEqual([
      generationA,
      generationB,
    ]);
    expect(journal.pending("darwin", "unavailable")).toEqual([]);
    const stored = JSON.parse(
      readFileSync(join(path, canonicalName(generationA)), "utf8"),
    ) as { runtimeGenerationIds: string[]; snapshotDigest: string };
    expect(stored.runtimeGenerationIds).toEqual([generationA, generationB]);
    expect(stored.snapshotDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("finishes an acknowledged consume transient after a crash", () => {
    const path = directory();
    expect(new LegacyRuntimeRecoveryAuthorityJournal(path)
      .publish(generationA, "darwin", bootId)).toBe(true);
    const canonical = canonicalName(generationA);
    renameSync(
      join(path, canonical),
      join(path, canonical.replace(/\.json$/u, ".consume.tmp")),
    );

    expect(new LegacyRuntimeRecoveryAuthorityJournal(path)
      .pending("darwin", bootId))
      .toEqual([]);
    expect(readdirSync(path).filter((name) => name.startsWith(prefix)))
      .toEqual([]);
  });

  it("rejects malformed or foreign authority leaves without deleting them", () => {
    const malformedPath = directory();
    const malformed = join(malformedPath, canonicalName(generationA));
    writeFileSync(malformed, "{}", { mode: 0o600 });
    expect(() => new LegacyRuntimeRecoveryAuthorityJournal(malformedPath))
      .toThrow("is invalid");
    expect(readdirSync(malformedPath)).toContain(canonicalName(generationA));

    const foreignPath = directory();
    writeFileSync(`${join(foreignPath, prefix)}foreign.tmp`, "foreign", {
      mode: 0o600,
    });
    expect(() => new LegacyRuntimeRecoveryAuthorityJournal(foreignPath))
      .toThrow("foreign entry");

    const consumePath = directory();
    const malformedConsume = join(
      consumePath,
      canonicalName(generationA).replace(/\.json$/u, ".consume.tmp"),
    );
    writeFileSync(malformedConsume, "{", { mode: 0o600 });
    expect(() => new LegacyRuntimeRecoveryAuthorityJournal(consumePath))
      .toThrow("is invalid");
    expect(readdirSync(consumePath)).toContain(
      canonicalName(generationA).replace(/\.json$/u, ".consume.tmp"),
    );
  });

  it("discards only incomplete publish transients so recovery can be reauthorized", () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from("{", "utf8")]) {
      const path = directory();
      const transient = canonicalName(generationA)
        .replace(/\.json$/u, ".publish.tmp");
      writeFileSync(join(path, transient), bytes, { mode: 0o600 });

      expect(new LegacyRuntimeRecoveryAuthorityJournal(path)
        .pending("win32", bootId)).toEqual([]);
      expect(readdirSync(path)).not.toContain(transient);
    }
  });

  it("resumes an exact batch after a persistent partial publication failure", () => {
    const path = directory();
    let writes = 0;
    const journal = new LegacyRuntimeRecoveryAuthorityJournal(path, {
      afterTemporaryFileClosed: (temporary) => {
        writes += 1;
        if (writes >= 2) unlinkSync(temporary);
      },
    });
    expect(journal.publishBatch(
      [generationA, generationB],
      "win32",
      bootId,
    )).toBe(false);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(path)
      .pending("win32", bootId))
      .toEqual([]);
    const resumed = new LegacyRuntimeRecoveryAuthorityJournal(path);
    expect(resumed.publishBatch(
      [generationA, generationB],
      "win32",
      bootId,
    )).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(path)
      .pending("win32", bootId)).toEqual([generationA, generationB]);
  });

  it("retires a changed batch as one cohort so the remaining lease can be reauthorized", () => {
    const path = directory();
    const journal = new LegacyRuntimeRecoveryAuthorityJournal(path);
    expect(journal.publishBatch(
      [generationA, generationB],
      "win32",
      bootId,
    )).toBe(true);

    expect(journal.retireExpired(
      "win32",
      bootId,
      new Set([generationA]),
    )).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(path)
      .pending("win32", bootId)).toEqual([]);
    expect(readdirSync(path).filter((name) => name.startsWith(prefix)))
      .toEqual([]);

    const replacement = new LegacyRuntimeRecoveryAuthorityJournal(path);
    expect(replacement.publishBatch([generationA], "win32", bootId)).toBe(true);
    expect(replacement.pending("win32", bootId)).toEqual([generationA]);
  });
});
