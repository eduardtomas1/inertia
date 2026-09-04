import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  recoverPriorRuntimeGenerations,
  recoverRuntimeOwnedProcesses,
} from "../../src/main/runtime-owned-process-recovery";
import { RuntimeCleanupReceiptJournal } from
  "../../src/main/runtime-cleanup-receipts";
import { RuntimeGenerationLeaseJournal } from
  "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from
  "../../src/node/runtime-owned-processes";
import {
  readLinuxGuardianReadyAsync,
  signalLinuxGuardianExact,
} from "../../src/node/runtime-owned-process-linux";

const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const temporaryDirectories: string[] = [];
const liveChildren = new Set<ChildProcess>();

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-update-recovery-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function generatedGuardianPath(): string {
  return join(
    process.cwd(),
    "resources/generated/runtime-process-guardian/runtime-process-guardian",
  );
}

function replacementGuardianPath(directory: string): string {
  const oldGuardianPath = generatedGuardianPath();
  const replacementPath = join(directory, "replacement-runtime-process-guardian");
  copyFileSync(oldGuardianPath, replacementPath);
  chmodSync(replacementPath, 0o700);
  const oldIdentity = statSync(oldGuardianPath, { bigint: true });
  const replacementIdentity = statSync(replacementPath, { bigint: true });
  expect(String(replacementIdentity.ino)).not.toBe(String(oldIdentity.ino));
  return replacementPath;
}

async function completedGuardian(
  directory: string,
  durableState: "owned" | "retiring",
): Promise<{
  guardian: ChildProcess;
  journal: RuntimeOwnedProcessJournal;
}> {
  const guardianPath = generatedGuardianPath();
  const executable = statSync(guardianPath, { bigint: true });
  const journal = new RuntimeOwnedProcessJournal(directory, {
    platform: "linux",
    darwinGuardianPath: guardianPath,
  });
  expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
  const capability = journal.sessionCapability(runtimeGenerationId, systemBootId);
  expect(capability).not.toBeNull();
  const ownershipId = journal.begin(
    runtimeGenerationId,
    systemBootId,
    capability!,
  );
  const guardian = spawn(guardianPath, [
    "watch",
    String(process.pid),
    String(executable.dev),
    String(executable.ino),
    "--",
    "/bin/true",
  ], { detached: true, shell: false, stdio: "ignore" });
  liveChildren.add(guardian);
  guardian.once("close", () => liveChildren.delete(guardian));
  if (!guardian.pid) throw new Error("Missing Linux guardian PID.");
  const identity = await readLinuxGuardianReadyAsync(
    guardian.pid,
    guardianPath,
    process.pid,
  );
  if (!identity) throw new Error("Linux guardian did not become ready.");
  const claim = journal.claim(
    ownershipId,
    runtimeGenerationId,
    systemBootId,
    guardian.pid,
    process.pid,
    { expectedLinuxIdentity: identity },
  );
  if (!("startTimeTicks" in claim.process)) {
    throw new Error("Missing Linux guardian identity.");
  }
  expect(signalLinuxGuardianExact(claim.process, guardianPath, "claim")).toBe(true);
  expect(journal.own(ownershipId)).not.toBeNull();
  if (durableState === "retiring") expect(journal.retire(ownershipId)).toBe(true);
  expect(signalLinuxGuardianExact(claim.process, guardianPath, "exec")).toBe(true);
  await vi.waitFor(() => {
    expect(readFileSync(`/proc/${guardian.pid}/comm`, "utf8").trim())
      .toBe("inertia-exdone");
  });
  return { guardian, journal };
}

function closeOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

afterEach(async () => {
  const closing = [...liveChildren].map(closeOf);
  for (const child of liveChildren) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
    try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
  }
  await Promise.allSettled(closing);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")(
  "runtime owned process update recovery",
  () => {
    it.each(["owned", "retiring"] as const)(
      "recovers a post-update Linux %s record through the replacement helper",
      async (durableState) => {
        const directory = temporaryDirectory();
        const replacementPath = replacementGuardianPath(directory);
        const { guardian, journal } = await completedGuardian(directory, durableState);

        await expect(recoverRuntimeOwnedProcesses(
          directory,
          runtimeGenerationId,
          systemBootId,
          {
            deadlineAt: Date.now() + 2_000,
            darwinGuardianPath: replacementPath,
          },
        )).resolves.toBe(true);

        await closeOf(guardian);
        expect(journal.records(runtimeGenerationId)).toEqual([]);
      },
    );

    it("clears the prior generation lease after replacement-helper recovery", async () => {
      const directory = temporaryDirectory();
      const replacementPath = replacementGuardianPath(directory);
      const leases = new RuntimeGenerationLeaseJournal(directory);
      const receipts = new RuntimeCleanupReceiptJournal(directory);
      expect(leases.publish(runtimeGenerationId, systemBootId)).toBe(true);
      const { guardian, journal } = await completedGuardian(directory, "owned");

      await expect(recoverPriorRuntimeGenerations({
        dataDirectory: directory,
        systemBootId,
        deadlineAt: Date.now() + 2_000,
        leases,
        receipts,
        platform: "linux",
        darwinGuardianPath: replacementPath,
      })).resolves.toBe(true);

      await closeOf(guardian);
      leases.refresh();
      expect(leases.all()).toEqual([]);
      expect(receipts.pending()).toEqual([runtimeGenerationId]);
      expect(journal.sessionExact(runtimeGenerationId)).toBeNull();
    });
  },
);
