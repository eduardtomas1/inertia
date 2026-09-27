import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pinDirectRuntimeJournalRoot,
  writeDirectRuntimeJournalLeafFromRoot,
} from "../../src/node/direct-runtime-journal";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import {
  captureModernDarwinRecoverySnapshot,
  modernDarwinRecoveryAuthorityMatches,
  ModernDarwinRecoveryAuthorityJournal,
} from "../../src/node/runtime-modern-recovery-authorities";
import {
  RuntimeOwnedProcessJournal,
  type DarwinProcessIdentity,
} from "../../src/node/runtime-owned-processes";

const directories: string[] = [];
const bootId = "test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const generationA = "11111111-1111-4111-8111-111111111111:1";
const generationB = "22222222-2222-4222-8222-222222222222:2";
const currentGeneration = "33333333-3333-4333-8333-333333333333:3";
const guardianPath = "/private/tmp/inertia-test-guardian";
const identity = (pid: number): DarwinProcessIdentity => ({
  platform: "darwin",
  pid,
  parentPid: 77,
  processGroupId: pid,
  sessionId: pid,
  startTimeSeconds: String(1_800_000_000 + pid),
  startTimeMicroseconds: 123_456,
});
const absentRoots = {
  guardianPath,
  platform: "darwin" as const,
  readDarwinIdentity: () => null,
  pidExists: () => false,
};

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "inertia-modern-recovery-"));
  directories.push(path);
  return path;
}

function seedOwned(
  path: string,
  runtimeGenerationId: string,
  pid: number,
): { journal: RuntimeOwnedProcessJournal; ownershipId: string } {
  expect(new RuntimeGenerationLeaseJournal(path).publish(
    runtimeGenerationId,
    bootId,
  )).toBe(true);
  const journal = new RuntimeOwnedProcessJournal(path, {
    platform: "darwin",
    darwinGuardianPath: guardianPath,
    readDarwinIdentity: (target) => target === pid ? identity(pid) : null,
  });
  expect(journal.startSession(runtimeGenerationId, bootId)).toBe(true);
  const ownershipId = journal.begin(
    runtimeGenerationId,
    bootId,
    journal.sessionCapability(runtimeGenerationId, bootId)!,
  );
  journal.claim(ownershipId, runtimeGenerationId, bootId, pid, 77);
  return { journal, ownershipId };
}

function seedPending(
  path: string,
  runtimeGenerationId: string,
): { journal: RuntimeOwnedProcessJournal; ownershipId: string } {
  expect(new RuntimeGenerationLeaseJournal(path).publish(
    runtimeGenerationId,
    bootId,
  )).toBe(true);
  const journal = new RuntimeOwnedProcessJournal(path, {
    platform: "darwin",
    darwinGuardianPath: guardianPath,
    readDarwinIdentity: () => null,
  });
  expect(journal.startSession(runtimeGenerationId, bootId)).toBe(true);
  return {
    journal,
    ownershipId: journal.begin(
      runtimeGenerationId,
      bootId,
      journal.sessionCapability(runtimeGenerationId, bootId)!,
    ),
  };
}

function seedCurrentSession(path: string): RuntimeOwnedProcessJournal {
  expect(new RuntimeGenerationLeaseJournal(path).publish(
    currentGeneration,
    bootId,
  )).toBe(true);
  const journal = new RuntimeOwnedProcessJournal(path, {
    platform: "darwin",
  });
  expect(journal.startSession(currentGeneration, bootId)).toBe(true);
  return journal;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("modern Darwin runtime recovery authority", () => {
  it("binds the operation to every exact lease, claim, identity, and boot", () => {
    const path = directory();
    seedOwned(path, generationA, 401);
    seedOwned(path, generationB, 402);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId);
    expect(snapshot?.generations).toHaveLength(2);
    const descriptor = snapshot
      ? new ModernDarwinRecoveryAuthorityJournal(path).publish(snapshot)
      : null;
    expect(descriptor?.runtimeGenerationIds).toEqual([
      generationA,
      generationB,
    ]);
    const authority = new ModernDarwinRecoveryAuthorityJournal(path).pending();
    expect(authority).not.toBeNull();
    expect(authority && modernDarwinRecoveryAuthorityMatches(
      path,
      authority,
      absentRoots,
    )).toBe(true);
    expect(authority?.snapshot.systemBootId).toBe(bootId);
    expect(authority?.snapshot.generations[0]?.records[0]).toMatchObject({
      state: "owned",
      ownershipId: expect.any(String),
      process: identity(401),
    });
  });

  it("binds an unavailable boot probe instead of treating it as reboot proof", () => {
    const path = directory();
    expect(new RuntimeGenerationLeaseJournal(path).publish(
      generationA,
      "unavailable",
    )).toBe(true);
    expect(new RuntimeOwnedProcessJournal(path, {
      platform: "darwin",
    }).startSession(generationA, "unavailable")).toBe(true);

    const snapshot = captureModernDarwinRecoverySnapshot(
      path,
      "unavailable",
    );
    expect(snapshot).toMatchObject({
      platform: "darwin",
      systemBootId: "unavailable",
      generations: [{
        lease: {
          runtimeGenerationId: generationA,
          systemBootId: "unavailable",
        },
      }],
    });
    const descriptor = snapshot
      ? new ModernDarwinRecoveryAuthorityJournal(path).publish(snapshot)
      : null;
    const authority = new ModernDarwinRecoveryAuthorityJournal(path).pending();
    expect(descriptor?.runtimeGenerationIds).toEqual([generationA]);
    expect(authority && modernDarwinRecoveryAuthorityMatches(
      path,
      authority,
      absentRoots,
    )).toBe(true);
  });

  it.each([
    ["unavailable", bootId],
    [bootId, "unavailable"],
  ] as const)(
    "binds recorded boot %s independently from current observation %s",
    (recordedBootId, observedBootId) => {
      const path = directory();
      expect(new RuntimeGenerationLeaseJournal(path).publish(
        generationA,
        recordedBootId,
      )).toBe(true);
      expect(new RuntimeOwnedProcessJournal(path, {
        platform: "darwin",
      }).startSession(generationA, recordedBootId)).toBe(true);

      const snapshot = captureModernDarwinRecoverySnapshot(
        path,
        observedBootId,
      );
      expect(snapshot).toMatchObject({
        systemBootId: observedBootId,
        generations: [{
          lease: {
            runtimeGenerationId: generationA,
            systemBootId: recordedBootId,
          },
        }],
      });
      const descriptor = snapshot
        ? new ModernDarwinRecoveryAuthorityJournal(path).publish(snapshot)
        : null;
      const authority = new ModernDarwinRecoveryAuthorityJournal(path)
        .pending();
      expect(descriptor?.runtimeGenerationIds).toEqual([generationA]);
      expect(authority && modernDarwinRecoveryAuthorityMatches(
        path,
        authority,
        absentRoots,
      )).toBe(true);
    },
  );

  it("rejects a pending-to-claimed transition after the prompt", () => {
    const path = directory();
    const { ownershipId } = seedPending(path, generationA);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    expect(new ModernDarwinRecoveryAuthorityJournal(path).publish(snapshot))
      .not.toBeNull();
    const authority = new ModernDarwinRecoveryAuthorityJournal(path).pending()!;

    const claimedJournal = new RuntimeOwnedProcessJournal(path, {
      platform: "darwin",
      darwinGuardianPath: "/private/tmp/inertia-test-guardian",
      readDarwinIdentity: (pid) => pid === 410 ? identity(410) : null,
    });
    claimedJournal.claim(ownershipId, generationA, bootId, 410, 77);

    expect(modernDarwinRecoveryAuthorityMatches(
      path,
      authority,
      absentRoots,
    )).toBe(false);
    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .beginRetirement(
        authority,
        path,
        currentGeneration,
        absentRoots,
      )).toBe(false);
  });

  it("keeps a multi-generation batch all-or-none when one record changes", () => {
    const path = directory();
    seedOwned(path, generationA, 420);
    const { journal } = seedPending(path, generationB);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    new ModernDarwinRecoveryAuthorityJournal(path).publish(snapshot);
    const authority = new ModernDarwinRecoveryAuthorityJournal(path).pending()!;

    journal.begin(
      generationB,
      bootId,
      journal.sessionCapability(generationB, bootId)!,
    );
    expect(modernDarwinRecoveryAuthorityMatches(
      path,
      authority,
      absentRoots,
    )).toBe(false);
    expect(new RuntimeGenerationLeaseJournal(path).all()).toHaveLength(2);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .records(generationA)).toHaveLength(1);
  });

  it("resumes a partially completed acknowledged batch without touching current state", () => {
    const path = directory();
    const first = seedOwned(path, generationA, 430);
    seedOwned(path, generationB, 431);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    new ModernDarwinRecoveryAuthorityJournal(path).publish(snapshot);
    const authority = new ModernDarwinRecoveryAuthorityJournal(path).pending()!;
    const leases = new RuntimeGenerationLeaseJournal(path);
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .startSession(currentGeneration, bootId)).toBe(true);
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);

    expect(first.journal.release(first.ownershipId)).toBe(true);
    expect(first.journal.finishSession(generationA)).toBe(true);
    expect(leases.clearRuntimeGeneration(generationA)).toBe(true);

    const replay = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(replay.completeRetirement(path, authority)).toBe(true);
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring()).toBeNull();
    expect(new RuntimeGenerationLeaseJournal(path).all()).toEqual([
      expect.objectContaining({ runtimeGenerationId: currentGeneration }),
    ]);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .records(currentGeneration)).toEqual([]);
  });

  it("replays exact old ownership after its lease disappeared without touching current ownership", () => {
    const path = directory();
    const old = seedOwned(path, generationA, 432);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    const current = seedOwned(path, currentGeneration, 433);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    const leases = new RuntimeGenerationLeaseJournal(path);
    const currentLease = leases.all().find(({ runtimeGenerationId }) => (
      runtimeGenerationId === currentGeneration
    ));
    const currentRecords = current.journal.records(currentGeneration);
    expect(leases.clearRuntimeGeneration(generationA)).toBe(true);

    expect(old.journal.records(generationA)).toHaveLength(1);
    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path, authority)).toBe(true);
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring()).toBeNull();
    expect(new RuntimeGenerationLeaseJournal(path).all()).toEqual([
      currentLease,
    ]);
    expect(current.journal.records(currentGeneration)).toEqual(currentRecords);
  });

  it("replays an exact subset after lease-free retirement partially completed", () => {
    const path = directory();
    const first = seedOwned(path, generationA, 434);
    const second = seedOwned(path, generationA, 435);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    seedCurrentSession(path);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(path)
      .clearRuntimeGeneration(generationA)).toBe(true);
    expect(first.journal.release(first.ownershipId)).toBe(true);
    expect(second.journal.records(generationA)).toHaveLength(1);

    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path, authority)).toBe(true);
    expect(second.journal.records(generationA)).toBeNull();
  });

  it("replays an exact record already moved into its consuming leaf", () => {
    const path = directory();
    const old = seedOwned(path, generationA, 435);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    seedCurrentSession(path);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    const canonical = join(
      path,
      `.runtime-owned-child-${old.ownershipId}.json`,
    );
    const consuming = join(
      path,
      `.runtime-owned-child-${old.ownershipId}.consume.tmp`,
    );
    renameSync(canonical, consuming);

    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path, authority)).toBe(true);
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring()).toBeNull();
    expect(readdirSync(path)).not.toContain(
      `.runtime-owned-child-${old.ownershipId}.consume.tmp`,
    );
  });

  it("rejects changed old ownership after its exact lease disappeared", () => {
    const path = directory();
    const old = seedOwned(path, generationA, 436);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    seedCurrentSession(path);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(path)
      .clearRuntimeGeneration(generationA)).toBe(true);
    expect(old.journal.retire(old.ownershipId)).toBe(true);
    const changed = old.journal.records(generationA);

    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path, authority)).toBe(false);
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring())
      .toEqual(authority);
    expect(old.journal.records(generationA)).toEqual(changed);
  });

  it("rechecks exact ownership at conditional release time", () => {
    const path = directory();
    const old = seedOwned(path, generationA, 436);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    seedCurrentSession(path);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    const releaseExact = Object.getOwnPropertyDescriptor(
      RuntimeOwnedProcessJournal.prototype,
      "releaseExact",
    )?.value as RuntimeOwnedProcessJournal["releaseExact"];
    let replaced = false;
    const conditionalRelease = vi.spyOn(
      RuntimeOwnedProcessJournal.prototype,
      "releaseExact",
    ).mockImplementation(function (
      this: RuntimeOwnedProcessJournal,
      expected,
    ) {
      if (!replaced) {
        replaced = true;
        expect(old.journal.release(old.ownershipId)).toBe(true);
      }
      return releaseExact.call(this, expected);
    });
    try {
      expect(new ModernDarwinRecoveryAuthorityJournal(path)
        .completeRetirement(path, authority)).toBe(false);
    } finally {
      conditionalRelease.mockRestore();
    }
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring())
      .toEqual(authority);
    expect(old.journal.records(generationA)).toEqual([]);
  });

  it("rejects additional old ownership after its exact lease disappeared", () => {
    const path = directory();
    const old = seedOwned(path, generationA, 437);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    seedCurrentSession(path);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(path)
      .clearRuntimeGeneration(generationA)).toBe(true);
    const staleWriter = new RuntimeOwnedProcessJournal(path, {
      platform: "darwin",
      darwinGuardianPath: guardianPath,
      readDarwinIdentity: (pid) => pid === 438 ? identity(pid) : null,
    });
    const additionalOwnershipId = staleWriter.begin(
      generationA,
      bootId,
      staleWriter.sessionCapability(generationA, bootId)!,
    );
    staleWriter.claim(additionalOwnershipId, generationA, bootId, 438, 77);
    const expanded = old.journal.records(generationA);
    expect(expanded).toHaveLength(2);

    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path, authority)).toBe(false);
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring())
      .toEqual(authority);
    expect(old.journal.records(generationA)).toEqual(expanded);
  });

  it("rejects an orphan old claim when its session and exact lease disappeared", () => {
    const path = directory();
    const old = seedOwned(path, generationA, 439);
    const claimPath = join(
      path,
      `.runtime-owned-child-${old.ownershipId}.json`,
    );
    const claim = readFileSync(claimPath);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    seedCurrentSession(path);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    expect(old.journal.release(old.ownershipId)).toBe(true);
    expect(old.journal.finishSession(generationA)).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(path)
      .clearRuntimeGeneration(generationA)).toBe(true);
    writeFileSync(claimPath, claim, { mode: 0o600 });

    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path, authority)).toBe(false);
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring())
      .toEqual(authority);
    expect(readFileSync(claimPath)).toEqual(claim);
  });

  it("finishes an exact empty old session after its lease disappeared", () => {
    const path = directory();
    const old = seedOwned(path, generationA, 451);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    seedCurrentSession(path);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    expect(old.journal.release(old.ownershipId)).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(path)
      .clearRuntimeGeneration(generationA)).toBe(true);
    expect(old.journal.records(generationA)).toEqual([]);

    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path, authority)).toBe(true);
    expect(old.journal.records(generationA)).toBeNull();
  });

  it("rejects an empty old session whose boot changed after its lease disappeared", () => {
    const path = directory();
    const old = seedOwned(path, generationA, 452);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    seedCurrentSession(path);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    expect(old.journal.release(old.ownershipId)).toBe(true);
    expect(old.journal.finishSession(generationA)).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(path)
      .clearRuntimeGeneration(generationA)).toBe(true);
    const changedBoot = "test:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(old.journal.startSession(generationA, changedBoot)).toBe(true);
    expect(old.journal.records(generationA)).toEqual([]);

    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path, authority)).toBe(false);
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring())
      .toEqual(authority);
    expect(old.journal.records(generationA)).toEqual([]);
  });

  it("does not delete a session replaced at conditional retirement time", () => {
    const path = directory();
    expect(new RuntimeGenerationLeaseJournal(path).publish(
      generationA,
      bootId,
    )).toBe(true);
    const old = new RuntimeOwnedProcessJournal(path, { platform: "darwin" });
    expect(old.startSession(generationA, bootId)).toBe(true);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const authorities = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(authorities.publish(snapshot)).not.toBeNull();
    const authority = authorities.pending()!;
    seedCurrentSession(path);
    expect(authorities.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    const changedBoot = "test:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fenceSessionExact = Object.getOwnPropertyDescriptor(
      RuntimeOwnedProcessJournal.prototype,
      "fenceSessionExact",
    )?.value as RuntimeOwnedProcessJournal["fenceSessionExact"];
    let replaced = false;
    const conditionalFence = vi.spyOn(
      RuntimeOwnedProcessJournal.prototype,
      "fenceSessionExact",
    ).mockImplementation(function (
      this: RuntimeOwnedProcessJournal,
      expected,
    ) {
      if (!replaced) {
        replaced = true;
        expect(old.finishSession(generationA)).toBe(true);
        expect(old.startSession(generationA, changedBoot)).toBe(true);
      }
      return fenceSessionExact.call(this, expected);
    });
    try {
      expect(new ModernDarwinRecoveryAuthorityJournal(path)
        .completeRetirement(path, authority)).toBe(false);
    } finally {
      conditionalFence.mockRestore();
    }
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring())
      .toEqual(authority);
    expect(old.inspectGeneration(generationA)?.session?.systemBootId)
      .toBe(changedBoot);
  });

  it("fences a surviving utility writer before retiring its empty session", () => {
    const path = directory();
    expect(new RuntimeGenerationLeaseJournal(path).publish(
      generationA,
      bootId,
    )).toBe(true);
    const stale = new RuntimeOwnedProcessJournal(path, { platform: "darwin" });
    expect(stale.startSession(generationA, bootId)).toBe(true);
    const capability = stale.sessionCapability(generationA, bootId)!;
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const authorities = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(authorities.publish(snapshot)).not.toBeNull();
    const authority = authorities.pending()!;
    seedCurrentSession(path);
    expect(authorities.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);

    expect(stale.fenceSessionExact(capability.session)).toBe(true);
    expect(() => stale.begin(
      generationA,
      bootId,
      capability,
    )).toThrow("session is unavailable");
    expect(stale.inspectGeneration(generationA)).toMatchObject({
      sessionState: "retiring",
      records: [],
      consumingRecords: [],
    });

    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path, authority)).toBe(true);
    expect(() => stale.begin(
      generationA,
      bootId,
      capability,
    )).toThrow("session is unavailable");
    expect(stale.inspectGeneration(generationA)).toMatchObject({
      session: null,
      sessionState: null,
      records: [],
      consumingRecords: [],
    });
  });

  it("makes a delayed stale publication impossible after retirement wins the fence", () => {
    const path = directory();
    expect(new RuntimeGenerationLeaseJournal(path).publish(
      generationA,
      bootId,
    )).toBe(true);
    const stale = new RuntimeOwnedProcessJournal(path, { platform: "darwin" });
    expect(stale.startSession(generationA, bootId)).toBe(true);
    const capability = stale.sessionCapability(generationA, bootId)!;
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const authorities = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(authorities.publish(snapshot)).not.toBeNull();
    const authority = authorities.pending()!;
    seedCurrentSession(path);
    expect(authorities.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);

    const ownershipId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let completed = false;
    expect(writeDirectRuntimeJournalLeafFromRoot(
      capability.writerRoot,
      `.runtime-owned-child-${ownershipId}.begin.tmp`,
      pinDirectRuntimeJournalRoot(path),
      `.runtime-owned-child-${ownershipId}.json`,
      Buffer.from(JSON.stringify({
        version: 1,
        state: "pending",
        ownershipId,
        runtimeGenerationId: generationA,
        systemBootId: bootId,
      }), "utf8"),
      {
        afterTemporaryFileClosed: () => {
          completed = new ModernDarwinRecoveryAuthorityJournal(path)
            .completeRetirement(path, authority);
        },
      },
    )).toBe(false);
    expect(completed).toBe(true);
    expect(stale.inspectGeneration(generationA)).toMatchObject({
      sessionState: null,
      records: [],
      consumingRecords: [],
    });
    expect(readdirSync(path)).not.toContain(
      `.runtime-owned-child-${ownershipId}.json`,
    );
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring()).toBeNull();
  });

  it("replays a crash-left writer temporary through the exact authority", () => {
    const path = directory();
    expect(new RuntimeGenerationLeaseJournal(path).publish(
      generationA,
      bootId,
    )).toBe(true);
    const old = new RuntimeOwnedProcessJournal(path, { platform: "darwin" });
    expect(old.startSession(generationA, bootId)).toBe(true);
    const capability = old.sessionCapability(generationA, bootId)!;
    const ownershipId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    expect(writeDirectRuntimeJournalLeafFromRoot(
      capability.writerRoot,
      `.runtime-owned-child-${ownershipId}.begin.tmp`,
      pinDirectRuntimeJournalRoot(path),
      `.runtime-owned-child-${ownershipId}.json`,
      Buffer.from(JSON.stringify({
        version: 1,
        state: "pending",
        ownershipId,
        runtimeGenerationId: generationA,
        systemBootId: bootId,
      }), "utf8"),
      { afterTemporaryFileClosed: () => { throw new Error("simulated crash"); } },
    )).toBe(false);

    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    expect(snapshot.generations[0]?.records).toEqual([]);
    const authorities = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(authorities.publish(snapshot)).not.toBeNull();
    const authority = authorities.pending()!;
    seedCurrentSession(path);
    expect(authorities.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    expect(authorities.completeRetirement(path, authority)).toBe(true);
    expect(old.inspectGeneration(generationA)).toMatchObject({
      session: null,
      sessionState: null,
      records: [],
      consumingRecords: [],
    });
  });

  it("does not delete a lease replaced at conditional retirement time", () => {
    const path = directory();
    const leases = new RuntimeGenerationLeaseJournal(path);
    expect(leases.publish(generationA, bootId)).toBe(true);
    const old = new RuntimeOwnedProcessJournal(path, { platform: "darwin" });
    expect(old.startSession(generationA, bootId)).toBe(true);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const authorities = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(authorities.publish(snapshot)).not.toBeNull();
    const authority = authorities.pending()!;
    seedCurrentSession(path);
    expect(authorities.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    const changedBoot = "test:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const consumeExact = Object.getOwnPropertyDescriptor(
      RuntimeGenerationLeaseJournal.prototype,
      "consumeExact",
    )?.value as RuntimeGenerationLeaseJournal["consumeExact"];
    let replaced = false;
    const conditionalConsume = vi.spyOn(
      RuntimeGenerationLeaseJournal.prototype,
      "consumeExact",
    ).mockImplementation(function (
      this: RuntimeGenerationLeaseJournal,
      expected,
    ) {
      if (!replaced) {
        replaced = true;
        expect(leases.clearRuntimeGeneration(generationA)).toBe(true);
        expect(leases.publish(generationA, changedBoot)).toBe(true);
      }
      return consumeExact.call(this, expected);
    });
    try {
      expect(new ModernDarwinRecoveryAuthorityJournal(path)
        .completeRetirement(path, authority)).toBe(false);
    } finally {
      conditionalConsume.mockRestore();
    }
    expect(new ModernDarwinRecoveryAuthorityJournal(path).retiring())
      .toEqual(authority);
    expect(new RuntimeGenerationLeaseJournal(path).all()).toContainEqual(
      expect.objectContaining({
        runtimeGenerationId: generationA,
        systemBootId: changedBoot,
      }),
    );
  });

  it("finishes a crash after leaves and leases cleared but before authority consume", () => {
    const path = directory();
    seedOwned(path, generationA, 440);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    new ModernDarwinRecoveryAuthorityJournal(path).publish(snapshot);
    const authority = new ModernDarwinRecoveryAuthorityJournal(path).pending()!;
    const leases = new RuntimeGenerationLeaseJournal(path);
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .startSession(currentGeneration, bootId)).toBe(true);
    let authorityUnlink = false;
    const crashing = new ModernDarwinRecoveryAuthorityJournal(path, {
      beforeUnlink: (leaf) => {
        if (leaf.endsWith(".retire.tmp")) {
          authorityUnlink = true;
          throw new Error("crash before consume");
        }
      },
    });
    expect(crashing.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);
    expect(crashing.completeRetirement(path, authority)).toBe(false);
    expect(authorityUnlink).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(path).all()).toEqual([
      expect.objectContaining({ runtimeGenerationId: currentGeneration }),
    ]);

    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path)).toBe(true);
  });

  it("resumes after the old session cleared but before its exact lease", () => {
    const path = directory();
    const old = seedOwned(path, generationA, 445);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    const leases = new RuntimeGenerationLeaseJournal(path);
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .startSession(currentGeneration, bootId)).toBe(true);
    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      absentRoots,
    )).toBe(true);

    expect(old.journal.release(old.ownershipId)).toBe(true);
    expect(old.journal.finishSession(generationA)).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(path).all()).toEqual([
      expect.objectContaining({ runtimeGenerationId: generationA }),
      expect.objectContaining({ runtimeGenerationId: currentGeneration }),
    ]);

    expect(new ModernDarwinRecoveryAuthorityJournal(path)
      .completeRetirement(path, authority)).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(path).all()).toEqual([
      expect.objectContaining({ runtimeGenerationId: currentGeneration }),
    ]);
  });

  it("refuses retirement while an exact old guardian root is still alive", () => {
    const path = directory();
    seedOwned(path, generationA, 446);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    const leases = new RuntimeGenerationLeaseJournal(path);
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .startSession(currentGeneration, bootId)).toBe(true);

    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      {
        ...absentRoots,
        pidExists: () => true,
        readDarwinIdentity: (pid) => identity(pid),
      },
    )).toBe(false);
    expect(new ModernDarwinRecoveryAuthorityJournal(path).pending())
      .not.toBeNull();
    expect(new RuntimeGenerationLeaseJournal(path).all()).toHaveLength(2);
  });

  it("retries one unreadable guardian identity before retiring absent roots", () => {
    const path = directory();
    seedOwned(path, generationA, 447);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    const leases = new RuntimeGenerationLeaseJournal(path);
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .startSession(currentGeneration, bootId)).toBe(true);
    let reads = 0;

    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      {
        ...absentRoots,
        pidExists: () => true,
        readDarwinIdentity: () => {
          reads += 1;
          if (reads === 1) throw new Error("transient helper failure");
          return null;
        },
      },
    )).toBe(true);
    expect(reads).toBe(2);
  });

  it("rejects an exact live guardian found by the unreadable retry", () => {
    const path = directory();
    seedOwned(path, generationA, 448);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    const leases = new RuntimeGenerationLeaseJournal(path);
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .startSession(currentGeneration, bootId)).toBe(true);
    let reads = 0;

    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      {
        ...absentRoots,
        pidExists: () => true,
        readDarwinIdentity: (pid) => {
          reads += 1;
          if (reads === 1) throw new Error("transient helper failure");
          return identity(pid);
        },
      },
    )).toBe(false);
    expect(reads).toBe(2);
    expect(journal.pending()).not.toBeNull();
    expect(leases.all()).toHaveLength(2);
  });

  it("fails closed after two unreadable guardian identity probes", () => {
    const path = directory();
    seedOwned(path, generationA, 449);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    const leases = new RuntimeGenerationLeaseJournal(path);
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .startSession(currentGeneration, bootId)).toBe(true);
    let reads = 0;

    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      {
        ...absentRoots,
        pidExists: () => true,
        readDarwinIdentity: () => {
          reads += 1;
          throw new Error("helper unavailable");
        },
      },
    )).toBe(false);
    expect(reads).toBe(2);
    expect(journal.pending()).not.toBeNull();
    expect(leases.all()).toHaveLength(2);
  });

  it("does not invoke the identity helper after exact PID absence", () => {
    const path = directory();
    seedOwned(path, generationA, 450);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    expect(journal.publish(snapshot)).not.toBeNull();
    const authority = journal.pending()!;
    const leases = new RuntimeGenerationLeaseJournal(path);
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .startSession(currentGeneration, bootId)).toBe(true);
    let reads = 0;

    expect(journal.beginRetirement(
      authority,
      path,
      currentGeneration,
      {
        ...absentRoots,
        readDarwinIdentity: () => {
          reads += 1;
          throw new Error("the absent PID must not need a helper");
        },
      },
    )).toBe(true);
    expect(reads).toBe(0);
  });

  it("discards only malformed publish transients and re-prompts", () => {
    const path = directory();
    const transient = ".runtime-modern-darwin-recovery-authority.publish.tmp";
    writeFileSync(join(path, transient), "{", { mode: 0o600 });

    expect(new ModernDarwinRecoveryAuthorityJournal(path).pending()).toBeNull();
    expect(readdirSync(path)).not.toContain(transient);
  });

  it("cancels an unchanged prompt without retiring process ownership", () => {
    const path = directory();
    seedOwned(path, generationA, 450);
    const snapshot = captureModernDarwinRecoverySnapshot(path, bootId)!;
    new ModernDarwinRecoveryAuthorityJournal(path).publish(snapshot);
    const journal = new ModernDarwinRecoveryAuthorityJournal(path);
    const authority = journal.pending()!;
    expect(journal.cancelPending(authority)).toBe(true);
    expect(new ModernDarwinRecoveryAuthorityJournal(path).pending()).toBeNull();
    expect(new RuntimeGenerationLeaseJournal(path).all()).toHaveLength(1);
    expect(new RuntimeOwnedProcessJournal(path, { platform: "darwin" })
      .records(generationA)).toHaveLength(1);
  });
});
