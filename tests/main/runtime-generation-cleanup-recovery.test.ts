// @inertia-test-suite portable
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeCleanupReceiptJournal } from
  "../../src/main/runtime-cleanup-receipts";
import { recoverPriorRuntimeGenerations } from
  "../../src/main/runtime-owned-process-recovery";
import { RuntimeGenerationLeaseJournal } from
  "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from
  "../../src/node/runtime-owned-processes";

const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime generation cleanup recovery", () => {
  it("retries Windows cleanup after receipt publication fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-cleanup-recovery-"));
    chmodSync(directory, 0o700);
    directories.push(directory);
    const leases = new RuntimeGenerationLeaseJournal(directory);
    const receipts = new RuntimeCleanupReceiptJournal(directory);
    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "win32",
    });
    expect(leases.publish(runtimeGenerationId, systemBootId)).toBe(true);
    expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
    const publish = vi.spyOn(
      RuntimeCleanupReceiptJournal.prototype,
      "publish",
    ).mockImplementationOnce(() => false);

    await expect(recoverPriorRuntimeGenerations({
      dataDirectory: directory,
      systemBootId,
      deadlineAt: Date.now() + 2_000,
      leases,
      receipts,
      platform: "win32",
    })).resolves.toBe(false);
    expect(publish).toHaveBeenCalledOnce();
    leases.refresh();
    expect(leases.all()).toEqual([
      expect.objectContaining({ runtimeGenerationId }),
    ]);
    expect(receipts.pending()).toEqual([]);
    expect(journal.inspectGeneration(runtimeGenerationId)).toMatchObject({
      sessionState: "retiring",
      sessionWriterPresent: false,
      records: [],
      consumingRecords: [],
      containment: null,
    });

    await expect(recoverPriorRuntimeGenerations({
      dataDirectory: directory,
      systemBootId,
      deadlineAt: Date.now() + 2_000,
      leases,
      receipts,
      platform: "win32",
    })).resolves.toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
    leases.refresh();
    expect(leases.all()).toEqual([]);
    expect(receipts.pending()).toEqual([runtimeGenerationId]);
    expect(journal.inspectGeneration(runtimeGenerationId)).toMatchObject({
      session: null,
      sessionState: null,
    });
  });
});
