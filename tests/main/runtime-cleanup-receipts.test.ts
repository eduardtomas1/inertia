import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeCleanupReceiptJournal,
  publishRuntimeCleanupReceipt,
  runtimeCleanupReceiptIds,
} from "../../src/main/runtime-cleanup-receipts";

const directories: string[] = [];
const generationA = "11111111-1111-4111-8111-111111111111:1";
const generationB = "22222222-2222-4222-8222-222222222222:2";
const transientA = ".aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp";
const transientB = ".bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.consume";

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "inertia-cleanup-receipts-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("runtime cleanup receipt journal", () => {
  it("persists multiple exact generations across app reconstruction", () => {
    const path = directory();
    const journal = new RuntimeCleanupReceiptJournal(path);
    expect(journal.publish(generationA)).toBe(true);
    expect(journal.publish(generationB)).toBe(true);
    expect(new RuntimeCleanupReceiptJournal(path).pending()).toEqual([
      generationA,
      generationB,
    ]);
  });

  it("recovers pre-link and linked publisher temporary files", () => {
    const path = directory();
    const receipts = join(path, ".runtime-cleanup-receipts");
    mkdirSync(receipts, { recursive: true });
    writeFileSync(join(receipts, transientA), JSON.stringify({
      runtimeGenerationId: generationA,
      confirmedAt: "2026-08-11T12:00:00.000Z",
    }));
    expect(runtimeCleanupReceiptIds(path)).toEqual([generationA]);
    const canonical = readdirSync(receipts)[0]!;
    expect(canonical).toMatch(/^[0-9a-f]{64}\.json$/u);
    copyFileSync(join(receipts, canonical), join(receipts, transientA));
    expect(runtimeCleanupReceiptIds(path)).toEqual([generationA]);
    expect(readdirSync(receipts)).toEqual([canonical]);
  });

  it("finishes a confirmed consume transient after a crash", () => {
    const path = directory();
    expect(publishRuntimeCleanupReceipt(path, generationA)).toBe(true);
    const receipts = join(path, ".runtime-cleanup-receipts");
    const canonical = readdirSync(receipts)[0]!;
    renameSync(join(receipts, canonical), join(receipts, transientB));

    expect(runtimeCleanupReceiptIds(path)).toEqual([]);
    expect(readdirSync(receipts)).toEqual([]);
  });

  it("preserves and rejects malformed or foreign entries", () => {
    const path = directory();
    const receipts = join(path, ".runtime-cleanup-receipts");
    mkdirSync(receipts, { recursive: true });
    const foreign = join(receipts, "foreign.txt");
    writeFileSync(foreign, "do not delete");
    expect(() => runtimeCleanupReceiptIds(path)).toThrow("foreign entry");
    expect(readFileSync(foreign, "utf8")).toBe("do not delete");

    rmSync(foreign);
    const corrupt = join(receipts, transientA);
    writeFileSync(corrupt, "not-json");
    expect(() => runtimeCleanupReceiptIds(path)).toThrow("transient is invalid");
    expect(readFileSync(corrupt, "utf8")).toBe("not-json");
  });
});
