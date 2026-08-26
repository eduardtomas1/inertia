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

import { directRuntimeJournalIdentityMatches } from "../../src/node/direct-runtime-journal";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";

const directories: string[] = [];
const generationA = "11111111-1111-4111-8111-111111111111:1";
const generationB = "22222222-2222-4222-8222-222222222222:2";
const bootA = "linux:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bootB = "linux:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const prefix = ".runtime-generation-lease-";

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "inertia-generation-leases-"));
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

describe("runtime generation lease journal", () => {
  it("distinguishes adjacent high-bit file identities without number rounding", () => {
    const firstInode = 9_007_199_254_740_992n;
    const secondInode = firstInode + 1n;
    expect(Number(firstInode)).toBe(Number(secondInode));
    expect(directRuntimeJournalIdentityMatches(
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

  it("discards publisher and finishes consumer transients after a crash", () => {
    const path = directory();
    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.publish(generationA, bootA)).toBe(true);
    const canonical = join(path, canonicalName(generationA));
    const publishing = join(path, transientName(generationA, "publish"));
    copyFileSync(canonical, publishing);
    expect(new RuntimeGenerationLeaseJournal(path).all()).toHaveLength(1);
    expect(readdirSync(path).filter((name) => name.startsWith(prefix))).toEqual([
      canonicalName(generationA),
    ]);

    renameSync(canonical, join(path, transientName(generationA, "consume")));
    expect(new RuntimeGenerationLeaseJournal(path).safetyLocked()).toBe(false);
    expect(readdirSync(path).filter((name) => name.startsWith(prefix))).toEqual([]);
  });

  it("discards zero-byte and torn publisher temps before parsing", () => {
    const path = directory();
    writeFileSync(join(path, transientName(generationA, "publish")), "", {
      mode: 0o600,
    });
    writeFileSync(join(path, transientName(generationB, "publish")), "{", {
      mode: 0o600,
    });

    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.isValid()).toBe(true);
    expect(journal.safetyLocked()).toBe(false);
    expect(readdirSync(path).filter((name) => name.startsWith(prefix))).toEqual([]);
  });

  it("refreshes stale instances before exact and prior-boot clearing", () => {
    const exactPath = directory();
    const exactClearer = new RuntimeGenerationLeaseJournal(exactPath);
    expect(new RuntimeGenerationLeaseJournal(exactPath).publish(generationA, bootA))
      .toBe(true);
    expect(exactClearer.clearRuntimeGeneration(generationA)).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(exactPath).all()).toEqual([]);

    const priorPath = directory();
    const priorClearer = new RuntimeGenerationLeaseJournal(priorPath);
    expect(new RuntimeGenerationLeaseJournal(priorPath).publish(generationA, bootA))
      .toBe(true);
    expect(priorClearer.clearPriorBootSessions(bootB)).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(priorPath).all()).toEqual([]);
  });

  it("rejects malformed owned leaves and enforces the exact schema", () => {
    const path = directory();
    writeFileSync(join(path, `${prefix}foreign.tmp`), "foreign");
    expect(new RuntimeGenerationLeaseJournal(path).isValid()).toBe(false);
    rmSync(join(path, `${prefix}foreign.tmp`));

    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.publish(generationA, bootA)).toBe(true);
    const canonical = join(path, canonicalName(generationA));
    const stored = JSON.parse(readFileSync(canonical, "utf8")) as object;
    writeFileSync(canonical, JSON.stringify({ ...stored, extra: true }));
    expect(new RuntimeGenerationLeaseJournal(path).isValid()).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "preserves group- or world-accessible canonical and transient leaves",
    () => {
      const canonicalPath = directory();
      const canonicalJournal = new RuntimeGenerationLeaseJournal(canonicalPath);
      expect(canonicalJournal.publish(generationA, bootA)).toBe(true);
      const canonical = join(canonicalPath, canonicalName(generationA));
      chmodSync(canonical, 0o666);
      expect(new RuntimeGenerationLeaseJournal(canonicalPath).isValid()).toBe(false);
      expect(lstatSync(canonical).mode & 0o777).toBe(0o666);

      const transientPath = directory();
      const transientJournal = new RuntimeGenerationLeaseJournal(transientPath);
      expect(transientJournal.publish(generationA, bootA)).toBe(true);
      const transient = join(transientPath, transientName(generationA, "publish"));
      copyFileSync(join(transientPath, canonicalName(generationA)), transient);
      chmodSync(transient, 0o666);
      expect(new RuntimeGenerationLeaseJournal(transientPath).isValid()).toBe(false);
      expect(lstatSync(transient).mode & 0o777).toBe(0o666);
    },
  );

  it("fails closed on the unreleased directory layout without touching it", () => {
    const path = directory();
    const outside = directory();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "outside");
    redirectLeaf(outside, join(path, ".runtime-generation-leases"), true);

    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.isValid()).toBe(false);
    expect(journal.safetyLocked()).toBe(true);
    expect(journal.publish(generationA, bootA)).toBe(false);
    expect(journal.isValid()).toBe(false);
    expect(journal.safetyLocked()).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("outside");
    expect(lstatSync(join(path, ".runtime-generation-leases")).isSymbolicLink())
      .toBe(true);
  });

  it("preserves an unreleased physical lease directory while failing closed", () => {
    const path = directory();
    const legacy = join(path, ".runtime-generation-leases");
    mkdirSync(legacy);
    const sentinel = join(legacy, "sentinel.txt");
    writeFileSync(sentinel, "legacy");

    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.isValid()).toBe(false);
    expect(journal.publish(generationA, bootA)).toBe(false);
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

    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.isValid()).toBe(false);
    expect(journal.safetyLocked()).toBe(true);
    expect(journal.publish(generationB, bootA)).toBe(false);
    expect(journal.clearRuntimeGeneration(generationA)).toBe(false);
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
    const journal = new RuntimeGenerationLeaseJournal(path, {
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

    expect(journal.publish(generationA, bootA)).toBe(false);
    expect(journal.isValid()).toBe(false);
    expect(journal.safetyLocked()).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("outside");
    expect(lstatSync(sentinel).nlink).toBe(beforeLinks);
    expect(lstatSync(retainedTemporary).isFile()).toBe(true);
    expect(lstatSync(join(path, transientName(generationA, "publish"))).isSymbolicLink())
      .toBe(true);
  });

  it("unlinks only a swapped consume leaf and preserves its outside target", () => {
    const path = directory();
    const outside = directory();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "outside");
    const beforeLinks = lstatSync(sentinel).nlink;
    let retainedConsume = "";
    const journal = new RuntimeGenerationLeaseJournal(path, {
      beforeUnlink: (consuming) => {
        if (!consuming.endsWith(".consume.tmp")) return;
        retainedConsume = join(path, "retained-generation-consume.json");
        renameSync(consuming, retainedConsume);
        redirectLeaf(
          process.platform === "win32" ? outside : sentinel,
          consuming,
          process.platform === "win32",
        );
      },
    });
    expect(journal.publish(generationA, bootA)).toBe(true);

    expect(journal.clearRuntimeGeneration(generationA)).toBe(false);
    expect(journal.all()).toEqual([
      expect.objectContaining({ runtimeGenerationId: generationA }),
    ]);
    expect(journal.safetyLocked()).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("outside");
    expect(lstatSync(sentinel).nlink).toBe(beforeLinks);
    expect(lstatSync(retainedConsume).isFile()).toBe(true);
  });

  it("fails closed when a live canonical leaf is replaced", () => {
    const path = directory();
    const outside = directory();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "replacement");
    const canonical = join(path, canonicalName(generationA));
    const retained = join(path, "retained-generation-lease.json");
    const journal = new RuntimeGenerationLeaseJournal(path);
    expect(journal.publish(generationA, bootA)).toBe(true);
    renameSync(canonical, retained);
    redirectLeaf(
      process.platform === "win32" ? outside : sentinel,
      canonical,
      process.platform === "win32",
    );

    expect(journal.publish(generationB, bootA)).toBe(false);
    expect(journal.clearRuntimeGeneration(generationA)).toBe(false);
    expect(journal.isValid()).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("replacement");
    expect(lstatSync(retained).isFile()).toBe(true);
  });

  it("enforces the 32-generation bound", () => {
    const path = directory();
    const journal = new RuntimeGenerationLeaseJournal(path);
    for (let index = 0; index < 32; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      expect(journal.publish(
        `00000000-0000-4000-8000-${suffix}:1`,
        bootA,
      )).toBe(true);
    }
    expect(journal.publish(generationA, bootA)).toBe(false);
  });

  it("reserves one current slot for an exact modern batch across a boot-probe transition", () => {
    const path = directory();
    const journal = new RuntimeGenerationLeaseJournal(path);
    const authorized: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      const generationId = `00000000-0000-4000-8000-${suffix}:1`;
      authorized.push(generationId);
      expect(journal.publish(generationId, bootA)).toBe(true);
    }
    expect(journal.publishWithModernRecoveryReserve(
      generationA,
      "unavailable",
      authorized,
    )).toBe(true);
    expect(journal.all()).toHaveLength(33);
  });

  it("reserves one current slot for an exact mixed modern and legacy batch", () => {
    const path = directory();
    const journal = new RuntimeGenerationLeaseJournal(path);
    const legacy: string[] = [];
    const modern: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      const generationId = `00000000-0000-4000-8000-${suffix}:1`;
      const target = index % 2 === 0 ? legacy : modern;
      target.push(generationId);
      expect(journal.publish(
        generationId,
        index % 2 === 0 ? "unavailable" : bootA,
      )).toBe(true);
    }
    expect(journal.publishWithManualRecoveryReserve(
      generationA,
      bootA,
      legacy,
      modern,
    )).toBe(true);
    expect(journal.all()).toHaveLength(33);

    const changed = directory();
    const changedJournal = new RuntimeGenerationLeaseJournal(changed);
    for (const generationId of [...legacy, ...modern]) {
      expect(changedJournal.publish(
        generationId,
        legacy.includes(generationId) ? "unavailable" : bootA,
      )).toBe(true);
    }
    expect(changedJournal.publishWithManualRecoveryReserve(
      generationB,
      bootA,
      legacy.slice(1),
      modern,
    )).toBe(false);
    expect(changedJournal.all()).toHaveLength(32);

    const unavailable = directory();
    const unavailableJournal = new RuntimeGenerationLeaseJournal(unavailable);
    for (const generationId of [...legacy, ...modern]) {
      expect(unavailableJournal.publish(
        generationId,
        legacy.includes(generationId) ? "unavailable" : bootA,
      )).toBe(true);
    }
    expect(unavailableJournal.publishWithManualRecoveryReserve(
      generationB,
      "unavailable",
      legacy,
      modern,
    )).toBe(true);
    expect(unavailableJournal.all()).toHaveLength(33);
  });
});
