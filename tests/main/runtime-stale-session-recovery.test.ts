import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeCleanupReceiptJournal } from
  "../../src/main/runtime-cleanup-receipts";
import { recoverPriorRuntimeGenerations } from
  "../../src/main/runtime-owned-process-recovery";
import {
  pinDirectRuntimeJournalChildRoot,
  pinDirectRuntimeJournalRoot,
  removeDirectRuntimeJournalChildRoot,
} from "../../src/node/direct-runtime-journal";
import { RuntimeGenerationLeaseJournal } from
  "../../src/node/runtime-generation-leases";
import { runtimeOwnedProcessWriterName } from
  "../../src/node/runtime-owned-process-session-journal";
import { RuntimeOwnedProcessJournal } from
  "../../src/node/runtime-owned-processes";

const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stale runtime ownership session recovery", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "re-fences and retires an empty %s session whose writer disappeared",
    async (platform) => {
      const directory = mkdtempSync(join(tmpdir(), "inertia-stale-session-"));
      chmodSync(directory, 0o700);
      temporaryDirectories.push(directory);
      const leases = new RuntimeGenerationLeaseJournal(directory);
      const receipts = new RuntimeCleanupReceiptJournal(directory);
      expect(leases.publish(runtimeGenerationId, systemBootId)).toBe(true);
      expect(new RuntimeOwnedProcessJournal(directory, { platform })
        .startSession(runtimeGenerationId, systemBootId)).toBe(true);
      const root = pinDirectRuntimeJournalRoot(directory);
      const writerName = runtimeOwnedProcessWriterName(runtimeGenerationId);
      const writer = pinDirectRuntimeJournalChildRoot(root, writerName);
      expect(writer).not.toBeNull();
      expect(removeDirectRuntimeJournalChildRoot(
        root,
        writerName,
        writer!,
      )).toBe(true);

      await expect(recoverPriorRuntimeGenerations({
        dataDirectory: directory,
        systemBootId,
        deadlineAt: Date.now() + 2_000,
        leases,
        receipts,
        platform,
      })).resolves.toBe(true);
      leases.refresh();
      expect(leases.all()).toEqual([]);
      expect(receipts.pending()).toEqual([runtimeGenerationId]);
    },
  );
});
