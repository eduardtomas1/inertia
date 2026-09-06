import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { recoverWindowsJob } = vi.hoisted(() => ({
  recoverWindowsJob: vi.fn(async () => true),
}));
vi.mock("../../src/main/windows-runtime-job", async (original) => ({
  ...await original<typeof import("../../src/main/windows-runtime-job")>(),
  recoverWindowsRuntimeJob: recoverWindowsJob,
}));

import { runtimeBootstrapAdmissionBlocked } from "../../src/main/runtime-bootstrap-safety";
import { RuntimeCleanupReceiptJournal } from "../../src/main/runtime-cleanup-receipts";
import { recoverPriorRuntimeGenerations } from "../../src/main/runtime-owned-process-recovery";
import { repairLegacyWindowsUnobservedProcessClaims } from "../../src/main/runtime-windows-legacy-claim-recovery";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-process-journal";
import { runtimeOwnedProcessWriterName } from "../../src/node/runtime-owned-process-session-journal";

const directories: string[] = [];
const boot = "win32:00000001";
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-windows-legacy-"));
  directories.push(directory);
  const generations = [randomUUID() + ":1", randomUUID() + ":1"];
  const journal = new RuntimeOwnedProcessJournal(directory, { platform: "win32" });
  const leases = new RuntimeGenerationLeaseJournal(directory);
  const receipts = new RuntimeCleanupReceiptJournal(directory);
  for (const generation of generations) {
    expect(journal.startSession(generation, boot)).toBe(true);
    expect(leases.publish(generation, boot)).toBe(true);
    expect(journal.armContainment(generation, boot, {
      kind: "windows-job-v1", name: `Global\\InertiaRuntime-${digest(generation)}`,
    })).toBe(true);
  }
  expect(journal.fenceSessionExact(journal.sessionExact(generations[1]!)!)).toBe(true);
  const claims = [randomUUID(), randomUUID()].map((ownershipId) => ({
    version: 1,
    state: "owned",
    ownershipId,
    runtimeGenerationId: generations[0]!,
    systemBootId: boot,
    process: { platform: "win32", pid: 0, processGroupId: null, startedAfterMs: 10, startedBeforeMs: 11 },
  }));
  const paths = claims.map((claim) => join(directory, `.runtime-owned-child-${claim.ownershipId}.json`));
  claims.forEach((claim, index) => writeFileSync(paths[index]!, JSON.stringify(claim), { mode: 0o600 }));
  return { directory, journal, leases, receipts, generations, claims, paths };
}

afterEach(() => {
  recoverWindowsJob.mockReset().mockResolvedValue(true);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Windows historical unobserved process recovery", () => {
  it("recovers the two-generation failed-launch profile through its exact Jobs before releasing leases", async () => {
    const state = fixture();
    expect(runtimeBootstrapAdmissionBlocked(state.directory, boot, "win32")).toBe(true);
    expect(state.journal.records(state.generations[1]!)).toBeNull();
    expect(repairLegacyWindowsUnobservedProcessClaims(state.directory, { platform: "win32" })).toBe(true);
    expect(state.journal.records(state.generations[0]!)).toHaveLength(2);
    expect(state.journal.records(state.generations[0]!)).toEqual(expect.arrayContaining(state.claims.map((claim) => ({
      version: 1, state: "pending", ownershipId: claim.ownershipId,
      runtimeGenerationId: claim.runtimeGenerationId, systemBootId: boot,
    }))));
    expect(existsSync(join(state.directory, runtimeOwnedProcessWriterName(state.generations[0]!)))).toBe(false);
    expect(new RuntimeGenerationLeaseJournal(state.directory).all()).toHaveLength(2);
    expect(state.receipts.has(state.generations[0]!)).toBe(false);
    expect(recoverWindowsJob).not.toHaveBeenCalled();
    expect(runtimeBootstrapAdmissionBlocked(state.directory, boot, "win32")).toBe(false);

    await expect(recoverPriorRuntimeGenerations({
      dataDirectory: state.directory, systemBootId: boot, platform: "win32",
      deadlineAt: Date.now() + 5_000, leases: state.leases, receipts: state.receipts,
    })).resolves.toBe(true);
    expect(new Set(recoverWindowsJob.mock.calls.map((call) =>
      (call as unknown as [{ name: string }])[0].name))).toEqual(
      new Set(state.generations.map((generation) => `Global\\InertiaRuntime-${digest(generation)}`)),
    );
    expect(new RuntimeGenerationLeaseJournal(state.directory).all()).toEqual([]);
    for (const generation of state.generations) {
      expect(state.journal.sessionExact(generation)).toBeNull();
      expect(state.receipts.has(generation)).toBe(true);
    }
  });

  it("retains the fenced intent, containment and lease when native Job cleanup cannot be proved", async () => {
    const state = fixture();
    recoverWindowsJob.mockResolvedValue(false);
    await expect(recoverPriorRuntimeGenerations({
      dataDirectory: state.directory, systemBootId: boot, platform: "win32",
      deadlineAt: Date.now() + 5_000, leases: state.leases, receipts: state.receipts,
    })).resolves.toBe(false);
    expect(state.journal.inspectGeneration(state.generations[0]!)).toMatchObject({
      sessionState: "retiring", records: [{ state: "pending" }, { state: "pending" }],
      containment: { kind: "windows-job-v1" },
    });
    expect(new RuntimeGenerationLeaseJournal(state.directory).all()).toHaveLength(2);
    expect(state.receipts.has(state.generations[0]!)).toBe(false);
  });

  it.each(["wrong-boot", "wrong-job", "missing-session", "missing-lease", "extra-key", "pid-one", "negative-pid", "non-windows"])(
    "does not rewrite an unproven %s profile",
    (change) => {
      const state = fixture();
      const claim = state.claims[0]!;
      if (change === "wrong-boot") claim.systemBootId = "win32:00000002";
      if (change === "extra-key") Object.assign(claim, { unexpected: true });
      if (change === "pid-one") claim.process.pid = 1;
      if (change === "negative-pid") claim.process.pid = -1;
      if (change === "non-windows") claim.process.platform = "linux";
      writeFileSync(state.paths[0]!, JSON.stringify(claim));
      if (change === "missing-session") unlinkSync(join(state.directory,
        `.runtime-owned-process-session-${digest(state.generations[0]!)}.json`));
      if (change === "missing-lease") expect(state.leases.clearRuntimeGeneration(state.generations[0]!)).toBe(true);
      if (change === "wrong-job") {
        const path = join(state.directory, `.runtime-owned-process-containment-${digest(state.generations[0]!)}.json`);
        const value = JSON.parse(readFileSync(path, "utf8"));
        value.containment.name = `Global\\InertiaRuntime-${digest(randomUUID())}`;
        writeFileSync(path, JSON.stringify(value));
      }
      const before = state.paths.map((path) => readFileSync(path));
      expect(repairLegacyWindowsUnobservedProcessClaims(state.directory, { platform: "win32" })).toBe(false);
      expect(state.paths.map((path) => readFileSync(path))).toEqual(before);
      expect(recoverWindowsJob).not.toHaveBeenCalled();
    },
  );

  it.each(["before-publish", "after-first-publish"] as const)(
    "converges after a crash %s without losing ownership evidence",
    (point) => {
      const state = fixture();
      let interrupted = false;
      const failOnce = (): void => {
        if (!interrupted) { interrupted = true; throw new Error("simulated crash"); }
      };
      expect(repairLegacyWindowsUnobservedProcessClaims(state.directory, {
        platform: "win32",
        hooks: point === "before-publish" ? { beforeRename: failOnce } : { afterRename: failOnce },
      })).toBe(false);
      expect(new RuntimeGenerationLeaseJournal(state.directory).all()).toHaveLength(2);
      expect(state.paths.every(existsSync)).toBe(true);
      expect(state.journal.repairSessionCrashPrefixes()).toBe(true);
      expect(repairLegacyWindowsUnobservedProcessClaims(state.directory, { platform: "win32" })).toBe(true);
      expect(state.journal.records(state.generations[0]!)?.every((claim) => claim.state === "pending")).toBe(true);
    },
  );

  it("does not overwrite a claim changed at publication", () => {
    const state = fixture();
    let changedPath = "";
    expect(repairLegacyWindowsUnobservedProcessClaims(state.directory, {
      platform: "win32", hooks: { beforeRename: (_source, target) => {
        changedPath = target;
        writeFileSync(target, "{}", { mode: 0o600 });
      } },
    })).toBe(false);
    expect(readFileSync(changedPath, "utf8")).toBe("{}");
    expect(new RuntimeGenerationLeaseJournal(state.directory).all()).toHaveLength(2);
  });

  it("does not normalize this Windows-only schema on another platform", () => {
    const state = fixture();
    const before = readdirSync(state.directory);
    expect(repairLegacyWindowsUnobservedProcessClaims(state.directory, { platform: "linux" })).toBe(true);
    expect(readdirSync(state.directory)).toEqual(before);
    expect(state.journal.records(state.generations[0]!)).toBeNull();
  });

  it("leaves ordinary crash-prefix settlement to the existing reader", () => {
    const state = fixture();
    const temporary = join(state.directory,
      `.runtime-owned-child-${state.claims[0]!.ownershipId}.claim.tmp`);
    writeFileSync(temporary, "interrupted publication", { mode: 0o600 });
    expect(repairLegacyWindowsUnobservedProcessClaims(state.directory, { platform: "win32" })).toBe(true);
    expect(existsSync(temporary)).toBe(true);
    expect(state.journal.records(state.generations[0]!)).toHaveLength(2);
    expect(existsSync(temporary)).toBe(false);
  });
});
