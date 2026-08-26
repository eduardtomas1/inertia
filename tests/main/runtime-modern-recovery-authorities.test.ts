import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  const ownershipId = journal.begin(runtimeGenerationId, bootId);
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
    ownershipId: journal.begin(runtimeGenerationId, bootId),
  };
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

    journal.begin(generationB, bootId);
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
        readDarwinIdentity: (pid) => identity(pid),
      },
    )).toBe(false);
    expect(new ModernDarwinRecoveryAuthorityJournal(path).pending())
      .not.toBeNull();
    expect(new RuntimeGenerationLeaseJournal(path).all()).toHaveLength(2);
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
