import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { persistRuntimeGenerationCleanup } from
  "../../src/main/runtime-generation-cleanup";
import { RuntimeCleanupReceiptJournal } from
  "../../src/main/runtime-cleanup-receipts";
import type { RuntimeProcessRecord } from
  "../../src/main/runtime-supervisor-types";
import {
  activateRuntimeOwnedProcessRegistry,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import {
  createDirectRuntimeJournalChildRoot,
  pinDirectRuntimeJournalChildRoot,
  pinDirectRuntimeJournalRoot,
  removeDirectRuntimeJournalChildRoot,
  writeDirectRuntimeJournalLeaf,
} from "../../src/node/direct-runtime-journal";
import { RuntimeGenerationLeaseJournal } from
  "../../src/node/runtime-generation-leases";
import {
  runtimeOwnedProcessSessionName,
  runtimeOwnedProcessWriterName,
} from "../../src/node/runtime-owned-process-session-journal";

const directories: string[] = [];
const generation = "20000000-0000-4000-8000-000000000002:1";
const boot = "test:10000000-0000-4000-8000-000000000001";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime owned-process session fence", () => {
  it("repairs the exact empty writer-directory crash prefix", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-session-fence-"));
    directories.push(directory);
    const root = pinDirectRuntimeJournalRoot(directory);
    expect(createDirectRuntimeJournalChildRoot(
      root,
      runtimeOwnedProcessWriterName(generation),
    )).not.toBeNull();

    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "darwin",
    });
    expect(journal.inspectGeneration(generation)).toBeNull();
    expect(pinDirectRuntimeJournalChildRoot(
      root,
      runtimeOwnedProcessWriterName(generation),
    )).not.toBeNull();
    expect(journal.repairSessionCrashPrefixes()).toBe(true);
    expect(journal.inspectGeneration(generation)).toMatchObject({
      session: null,
      sessionState: null,
      records: [],
      consumingRecords: [],
    });
    expect(pinDirectRuntimeJournalChildRoot(
      root,
      runtimeOwnedProcessWriterName(generation),
    )).toBeNull();
    expect(journal.startSession(generation, boot)).toBe(true);
  });

  it("repairs a session publication crash after its temporary closes", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-session-fence-"));
    directories.push(directory);
    const root = pinDirectRuntimeJournalRoot(directory);
    expect(createDirectRuntimeJournalChildRoot(
      root,
      runtimeOwnedProcessWriterName(generation),
    )).not.toBeNull();
    const canonical = runtimeOwnedProcessSessionName(generation);
    const hash = createHash("sha256").update(generation).digest("hex");
    expect(writeDirectRuntimeJournalLeaf(
      root,
      `.runtime-owned-process-session-${hash}.publish.tmp`,
      canonical,
      Buffer.from(JSON.stringify({
        version: 1,
        runtimeGenerationId: generation,
        systemBootId: boot,
      }), "utf8"),
      { afterTemporaryFileClosed: () => { throw new Error("simulated crash"); } },
    )).toBe(false);

    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "darwin",
    });
    expect(journal.inspectGeneration(generation)).toBeNull();
    expect(journal.repairSessionCrashPrefixes()).toBe(true);
    expect(journal.inspectGeneration(generation)).toMatchObject({
      session: null,
      sessionState: null,
      records: [],
      consumingRecords: [],
    });
    expect(pinDirectRuntimeJournalChildRoot(
      root,
      runtimeOwnedProcessWriterName(generation),
    )).toBeNull();
  });

  it("re-fences a valid session whose empty writer directory disappeared", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-session-fence-"));
    directories.push(directory);
    const root = pinDirectRuntimeJournalRoot(directory);
    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "darwin",
    });
    expect(journal.startSession(generation, boot)).toBe(true);
    const staleCapability = journal.sessionCapability(generation, boot);
    expect(staleCapability).not.toBeNull();
    const writerName = runtimeOwnedProcessWriterName(generation);
    const writer = pinDirectRuntimeJournalChildRoot(root, writerName);
    expect(writer).not.toBeNull();
    expect(removeDirectRuntimeJournalChildRoot(
      root,
      writerName,
      writer!,
    )).toBe(true);

    expect(journal.inspectGeneration(generation)).toBeNull();
    expect(journal.repairSessionCrashPrefixes()).toBe(true);
    expect(journal.inspectGeneration(generation)).toMatchObject({
      session: { runtimeGenerationId: generation, systemBootId: boot },
      sessionState: "retiring",
      sessionWriterPresent: false,
      records: [],
      consumingRecords: [],
    });
    expect(journal.sessionCapabilityCurrent(staleCapability!)).toBe(false);
    expect(journal.sessionCapability(generation, boot)).toBeNull();
    expect(journal.finishSession(generation)).toBe(true);
  });

  it("keeps the retiring session until a durable cleanup commit succeeds", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-session-fence-"));
    directories.push(directory);
    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "win32",
    });
    expect(journal.startSession(generation, boot)).toBe(true);
    const staleCapability = journal.sessionCapability(generation, boot);
    expect(staleCapability).not.toBeNull();
    const rejectedCommit = vi.fn(() => {
      expect(journal.inspectGeneration(generation)).toMatchObject({
        sessionState: "retiring",
        sessionWriterPresent: false,
        records: [],
        consumingRecords: [],
        containment: null,
      });
      return false;
    });

    expect(journal.finishSession(generation, rejectedCommit)).toBe(false);
    expect(rejectedCommit).toHaveBeenCalledOnce();
    expect(journal.sessionCapabilityCurrent(staleCapability!)).toBe(false);
    expect(journal.inspectGeneration(generation)).toMatchObject({
      sessionState: "retiring",
      sessionWriterPresent: false,
    });
    expect(journal.finishSession(generation, () => {
      throw new Error("simulated cleanup receipt failure");
    })).toBe(false);
    expect(journal.inspectGeneration(generation)).toMatchObject({
      sessionState: "retiring",
    });
    expect(journal.finishSession(generation, () => true)).toBe(true);
    expect(journal.inspectGeneration(generation)).toMatchObject({
      session: null,
      sessionState: null,
      records: [],
      consumingRecords: [],
      containment: null,
    });
  });

  it("retries lease retirement after cleanup proof is already durable", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-session-fence-"));
    directories.push(directory);
    const ownedProcesses = new RuntimeOwnedProcessJournal(directory, {
      platform: "win32",
    });
    const receipts = new RuntimeCleanupReceiptJournal(directory);
    const leases = new RuntimeGenerationLeaseJournal(directory);
    const record = {
      runtimeGenerationId: generation,
      generationCleanupConfirmed: false,
    } as RuntimeProcessRecord;
    expect(ownedProcesses.startSession(generation, boot)).toBe(true);
    expect(leases.publish(generation, boot)).toBe(true);
    const clearRuntimeGeneration = leases.clearRuntimeGeneration.bind(leases);
    const clear = vi.spyOn(leases, "clearRuntimeGeneration")
      .mockImplementationOnce(() => false)
      .mockImplementation(clearRuntimeGeneration);

    expect(persistRuntimeGenerationCleanup(
      record,
      receipts,
      leases,
      ownedProcesses,
    )).toBe(false);
    expect(receipts.has(generation)).toBe(true);
    expect(ownedProcesses.sessionExact(generation)).toBeNull();
    expect(new RuntimeGenerationLeaseJournal(directory).all()).toEqual([
      expect.objectContaining({ runtimeGenerationId: generation }),
    ]);

    expect(persistRuntimeGenerationCleanup(
      record,
      receipts,
      leases,
      ownedProcesses,
    )).toBe(true);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(record.generationCleanupConfirmed).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(directory).all()).toEqual([]);
  });

  it("never spawns from a surviving registry after its session is fenced", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-session-fence-"));
    directories.push(directory);
    const prepared = new RuntimeOwnedProcessJournal(directory, {
      platform: "darwin",
    });
    expect(() => activateRuntimeOwnedProcessRegistry(
      directory,
      generation,
      boot,
      {
        platform: "darwin",
        darwinGuardianPath: "/trusted/runtime-process-guardian",
      },
    )).toThrow("session identity is unavailable");
    expect(prepared.inspectGeneration(generation)).toMatchObject({
      session: null,
      records: [],
      consumingRecords: [],
    });
    expect(prepared.startSession(generation, boot)).toBe(true);
    const deactivate = activateRuntimeOwnedProcessRegistry(
      directory,
      generation,
      boot,
      {
        platform: "darwin",
        darwinGuardianPath: "/trusted/runtime-process-guardian",
      },
    );
    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "darwin",
    });
    const session = journal.inspectGeneration(generation)?.session;
    expect(session).not.toBeNull();
    expect(journal.fenceSessionExact(session!)).toBe(true);
    const spawnProcess = vi.fn();
    try {
      expect(() => spawnRuntimeOwnedProcess(spawnProcess))
        .toThrow("session is unavailable");
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(journal.inspectGeneration(generation)).toMatchObject({
        sessionState: "retiring",
        records: [],
        consumingRecords: [],
      });
    } finally {
      deactivate?.();
    }
  });
});
