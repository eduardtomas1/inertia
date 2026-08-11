import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
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

import {
  consumeRuntimeCleanupReceipt,
  RuntimeCleanupReceiptJournal,
  publishRuntimeCleanupReceipt,
  runtimeCleanupReceiptIds,
} from "../../src/main/runtime-cleanup-receipts";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";

const directories: string[] = [];
const generationA = "11111111-1111-4111-8111-111111111111:1";
const generationB = "22222222-2222-4222-8222-222222222222:2";
const bootA = "linux:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prefix = ".runtime-cleanup-receipt-";

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "inertia-cleanup-receipts-"));
  directories.push(path);
  return path;
}

function generationHash(generationId: string): string {
  return createHash("sha256").update(generationId).digest("hex");
}

function canonicalName(generationId: string): string {
  return `${prefix}${generationHash(generationId)}.json`;
}

function transientName(
  generationId: string,
  operation: "publish" | "consume",
): string {
  return `${prefix}${generationHash(generationId)}.${operation}.tmp`;
}

function storedReceipt(generationId: string): string {
  return JSON.stringify({
    version: 1,
    runtimeGenerationId: generationId,
    confirmedAt: "2026-08-11T12:00:00.000Z",
  });
}

function redirectLeaf(target: string, path: string, directoryTarget = false): void {
  symlinkSync(
    target,
    path,
    process.platform === "win32"
      ? directoryTarget ? "junction" : "file"
      : directoryTarget ? "dir" : "file",
  );
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

  it("promotes authoritative publisher temps and retires duplicate temps", () => {
    const path = directory();
    const publishing = join(path, transientName(generationA, "publish"));
    writeFileSync(publishing, storedReceipt(generationA), { mode: 0o600 });
    expect(runtimeCleanupReceiptIds(path)).toEqual([generationA]);
    const canonical = join(path, canonicalName(generationA));
    expect(readFileSync(canonical, "utf8")).toContain(generationA);

    copyFileSync(canonical, publishing);
    expect(runtimeCleanupReceiptIds(path)).toEqual([generationA]);
    expect(readdirSync(path).filter((name) => name.startsWith(prefix))).toEqual([
      canonicalName(generationA),
    ]);
  });

  it("discards incomplete publisher temps without clearing the generation lease", () => {
    const path = directory();
    const generationLeases = new RuntimeGenerationLeaseJournal(path);
    expect(generationLeases.publish(generationA, bootA)).toBe(true);
    writeFileSync(join(path, transientName(generationA, "publish")), "", {
      mode: 0o600,
    });
    writeFileSync(join(path, transientName(generationB, "publish")), "{", {
      mode: 0o600,
    });

    expect(runtimeCleanupReceiptIds(path)).toEqual([]);
    expect(readdirSync(path).filter((name) => name.startsWith(prefix))).toEqual([]);
    const reconstructed = new RuntimeGenerationLeaseJournal(path);
    expect(reconstructed.safetyLocked()).toBe(true);
    expect(reconstructed.all().map(({ runtimeGenerationId }) =>
      runtimeGenerationId)).toEqual([generationA]);
  });

  it("finishes an exact consume transient after a crash", () => {
    const path = directory();
    expect(publishRuntimeCleanupReceipt(path, generationA)).toBe(true);
    renameSync(
      join(path, canonicalName(generationA)),
      join(path, transientName(generationA, "consume")),
    );

    expect(runtimeCleanupReceiptIds(path)).toEqual([]);
    expect(readdirSync(path).filter((name) => name.startsWith(prefix))).toEqual([]);
  });

  it("retries an exact consume transient in the same journal instance", () => {
    const path = directory();
    let interruptConsume = true;
    const journal = new RuntimeCleanupReceiptJournal(path, {
      afterRename: (_source, target) => {
        if (interruptConsume && target.endsWith(".consume.tmp")) {
          interruptConsume = false;
          throw new Error("simulated interruption after consume rename");
        }
      },
    });
    expect(journal.publish(generationA)).toBe(true);

    expect(journal.consume(generationA)).toBe(false);
    expect(journal.pending()).toEqual([generationA]);
    expect(lstatSync(join(path, transientName(generationA, "consume"))).isFile())
      .toBe(true);
    expect(journal.consume(generationA)).toBe(true);
    expect(journal.pending()).toEqual([]);
    expect(readdirSync(path).filter((name) => name.startsWith(prefix))).toEqual([]);
  });

  it("preserves and rejects malformed canonical and consume leaves", () => {
    const path = directory();
    const foreign = join(path, `${prefix}foreign.txt`);
    writeFileSync(foreign, "do not delete");
    expect(() => runtimeCleanupReceiptIds(path)).toThrow("foreign entry");
    expect(readFileSync(foreign, "utf8")).toBe("do not delete");

    rmSync(foreign);
    const corrupt = join(path, canonicalName(generationA));
    writeFileSync(corrupt, "not-json", { mode: 0o600 });
    expect(() => runtimeCleanupReceiptIds(path)).toThrow("is invalid");
    expect(readFileSync(corrupt, "utf8")).toBe("not-json");

    rmSync(corrupt);
    const consuming = join(path, transientName(generationA, "consume"));
    writeFileSync(consuming, "{", { mode: 0o600 });
    expect(() => runtimeCleanupReceiptIds(path)).toThrow("is invalid");
    expect(readFileSync(consuming, "utf8")).toBe("{");

    rmSync(consuming);
    writeFileSync(corrupt, JSON.stringify({
      ...JSON.parse(storedReceipt(generationA)) as object,
      extra: true,
    }), { mode: 0o600 });
    expect(() => runtimeCleanupReceiptIds(path)).toThrow("is invalid");
  });

  it("preserves and rejects an unsafe publisher temp", () => {
    const path = directory();
    const outside = directory();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "outside");
    const publishing = join(path, transientName(generationA, "publish"));
    redirectLeaf(
      process.platform === "win32" ? outside : sentinel,
      publishing,
      process.platform === "win32",
    );

    expect(() => runtimeCleanupReceiptIds(path)).toThrow("unsafe");
    expect(readFileSync(sentinel, "utf8")).toBe("outside");
    expect(lstatSync(publishing).isSymbolicLink()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "preserves group- or world-accessible canonical and transient leaves",
    () => {
      const canonicalPath = directory();
      expect(publishRuntimeCleanupReceipt(canonicalPath, generationA)).toBe(true);
      const canonical = join(canonicalPath, canonicalName(generationA));
      chmodSync(canonical, 0o666);
      expect(() => runtimeCleanupReceiptIds(canonicalPath)).toThrow("unsafe");
      expect(lstatSync(canonical).mode & 0o777).toBe(0o666);

      const transientPath = directory();
      const transient = join(transientPath, transientName(generationA, "publish"));
      writeFileSync(transient, storedReceipt(generationA), { mode: 0o600 });
      chmodSync(transient, 0o666);
      expect(() => runtimeCleanupReceiptIds(transientPath)).toThrow("unsafe");
      expect(lstatSync(transient).mode & 0o777).toBe(0o666);
    },
  );

  it("fails closed on the unreleased directory layout without touching it", () => {
    const path = directory();
    const outside = directory();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "outside");
    redirectLeaf(outside, join(path, ".runtime-cleanup-receipts"), true);

    expect(() => runtimeCleanupReceiptIds(path)).toThrow("legacy");
    expect(publishRuntimeCleanupReceipt(path, generationA)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("outside");
    expect(lstatSync(join(path, ".runtime-cleanup-receipts")).isSymbolicLink())
      .toBe(true);
  });

  it("preserves an unreleased physical receipt directory while failing closed", () => {
    const path = directory();
    const legacy = join(path, ".runtime-cleanup-receipts");
    mkdirSync(legacy);
    const sentinel = join(legacy, "sentinel.txt");
    writeFileSync(sentinel, "legacy");

    expect(() => new RuntimeCleanupReceiptJournal(path)).toThrow("legacy");
    expect(publishRuntimeCleanupReceipt(path, generationA)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("legacy");
  });

  it("rejects an owned canonical redirect without touching its target", () => {
    const path = directory();
    const outside = directory();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "outside");
    const beforeLinks = lstatSync(sentinel).nlink;
    redirectLeaf(
      process.platform === "win32" ? outside : sentinel,
      join(path, canonicalName(generationA)),
      process.platform === "win32",
    );

    expect(() => runtimeCleanupReceiptIds(path)).toThrow("unsafe");
    expect(() => new RuntimeCleanupReceiptJournal(path)).toThrow("unsafe");
    expect(publishRuntimeCleanupReceipt(path, generationB)).toBe(false);
    expect(consumeRuntimeCleanupReceipt(path, generationA)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("outside");
    expect(lstatSync(sentinel).nlink).toBe(beforeLinks);
  });

  it("fails closed if a fixed publish temp is swapped after its fd write", () => {
    const path = directory();
    const outside = directory();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "outside");
    const beforeLinks = lstatSync(sentinel).nlink;
    let retainedTemporary = "";
    const journal = new RuntimeCleanupReceiptJournal(path, {
      beforeRename: (temporary) => {
        if (!temporary.endsWith(".publish.tmp")) return;
        retainedTemporary = `${temporary}.retained`;
        renameSync(temporary, retainedTemporary);
        redirectLeaf(
          process.platform === "win32" ? outside : sentinel,
          temporary,
          process.platform === "win32",
        );
      },
    });

    expect(journal.publish(generationA)).toBe(false);
    expect(journal.pending()).toEqual([]);
    expect(readFileSync(sentinel, "utf8")).toBe("outside");
    expect(lstatSync(sentinel).nlink).toBe(beforeLinks);
    expect(lstatSync(retainedTemporary).isFile()).toBe(true);
    expect(lstatSync(join(path, transientName(generationA, "publish"))).isSymbolicLink())
      .toBe(true);
  });

  it("does not follow a canonical redirect planted at the consume rename", () => {
    const path = directory();
    const outside = directory();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "outside");
    const beforeLinks = lstatSync(sentinel).nlink;
    let interceptConsume = false;
    let retainedCanonical = "";
    const journal = new RuntimeCleanupReceiptJournal(path, {
      beforeRename: (source, target) => {
        if (!interceptConsume || !target.endsWith(".consume.tmp")) return;
        retainedCanonical = join(path, "retained-cleanup-canonical.json");
        renameSync(source, retainedCanonical);
        redirectLeaf(
          process.platform === "win32" ? outside : sentinel,
          source,
          process.platform === "win32",
        );
      },
    });
    expect(journal.publish(generationA)).toBe(true);
    interceptConsume = true;

    expect(journal.consume(generationA)).toBe(false);
    expect(journal.pending()).toEqual([generationA]);
    expect(readFileSync(sentinel, "utf8")).toBe("outside");
    expect(lstatSync(sentinel).nlink).toBe(beforeLinks);
    expect(lstatSync(retainedCanonical).isFile()).toBe(true);
  });

  it("fails closed when a live canonical leaf is replaced", () => {
    const path = directory();
    const outside = directory();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "replacement");
    const canonical = join(path, canonicalName(generationA));
    const retained = join(path, "retained-cleanup-receipt.json");
    const journal = new RuntimeCleanupReceiptJournal(path);
    expect(journal.publish(generationA)).toBe(true);
    renameSync(canonical, retained);
    redirectLeaf(
      process.platform === "win32" ? outside : sentinel,
      canonical,
      process.platform === "win32",
    );

    expect(journal.publish(generationB)).toBe(false);
    expect(journal.consume(generationA)).toBe(false);
    expect(journal.pending()).toEqual([generationA]);
    expect(readFileSync(sentinel, "utf8")).toBe("replacement");
    expect(lstatSync(retained).isFile()).toBe(true);
  });

  it("enforces the 32-receipt bound", () => {
    const path = directory();
    const journal = new RuntimeCleanupReceiptJournal(path);
    for (let index = 0; index < 32; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      expect(journal.publish(
        `00000000-0000-4000-8000-${suffix}:1`,
      )).toBe(true);
    }
    expect(journal.publish(generationA)).toBe(false);
  });
});
