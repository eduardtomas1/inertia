import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  recoverPriorRuntimeGenerations,
  recoverRuntimeOwnedProcesses,
} from "../../src/main/runtime-owned-process-recovery";
import { RuntimeCleanupReceiptJournal } from "../../src/main/runtime-cleanup-receipts";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import {
  activateRuntimeOwnedProcessRegistry,
  confirmRuntimeOwnedProcessStopped,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedPidProcess,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";

const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const temporaryDirectories: string[] = [];
const liveChildren = new Set<ChildProcess>();
const deactivators: Array<() => void> = [];

function activate(directory: string): void {
  const deactivate = activateRuntimeOwnedProcessRegistry(
    directory,
    runtimeGenerationId,
    systemBootId,
  );
  if (deactivate) deactivators.push(deactivate);
}

function deactivate(): void {
  deactivators.pop()?.();
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-owned-process-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function longRunningChild(): ChildProcess {
  const child = spawnRuntimeOwnedProcess(() => spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    {
      detached: true,
      shell: false,
      stdio: "ignore",
    },
  ));
  liveChildren.add(child);
  child.once("close", () => liveChildren.delete(child));
  return child;
}

function closeOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function hardStop(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
  try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
}

afterEach(async () => {
  while (deactivators.length > 0) deactivate();
  const closing = [...liveChildren].map(closeOf);
  for (const child of liveChildren) hardStop(child);
  await Promise.allSettled(closing);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")(
  "runtime owned process recovery",
  () => {
    it("persists a minimal exact capability before recovering its owned group", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const close = closeOf(child);
      const journal = new RuntimeOwnedProcessJournal(directory);
      const records = journal.records(runtimeGenerationId);
      expect(records).toHaveLength(1);
      expect(records?.[0]).toMatchObject({
        state: "owned",
        runtimeGenerationId,
        systemBootId,
        process: {
          pid: child.pid,
          processGroupId: child.pid,
          startTimeTicks: expect.stringMatching(/^[1-9][0-9]+$/u),
        },
      });
      const claimFile = readdirSync(directory).find((name) =>
        name.startsWith(".runtime-owned-child-")
        && name.endsWith(".json"));
      expect(claimFile).toBeDefined();
      expect(statSync(join(directory, claimFile!)).mode & 0o777).toBe(0o600);
      const raw = readFileSync(join(directory, claimFile!), "utf8");
      expect(raw).not.toContain("setInterval");
      expect(raw).not.toContain("PATH");

      deactivate();
      const recovery = recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        { deadlineAt: Date.now() + 2_000 },
      );
      expect(recovery).not.toBeNull();
      await expect(recovery).resolves.toBe(true);
      await close;
      expect(journal.records(runtimeGenerationId)).toEqual([]);
      expect(journal.finishSession(runtimeGenerationId)).toBe(true);
    });

    it("retires a normally closed child and its completed session", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const journal = new RuntimeOwnedProcessJournal(directory);

      hardStop(child);
      await closeOf(child);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(confirmRuntimeOwnedProcessStopped(child)).toBe(true);
      expect(journal.records(runtimeGenerationId)).toEqual([]);
      expect(journal.finishSession(runtimeGenerationId)).toBe(true);
      expect(readdirSync(directory).some((name) =>
        name.startsWith(".runtime-owned-process-session-"))).toBe(false);
    });

    it("registers and idempotently retires a PID-backed process group", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const owned = spawnRuntimeOwnedPidProcess(() => {
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(() => undefined, 1000)"],
          { detached: true, shell: false, stdio: "ignore" },
        );
        if (!child.pid) throw new Error("Missing child PID");
        return child as ChildProcess & { readonly pid: number };
      });
      liveChildren.add(owned.process);
      owned.process.once("close", () => liveChildren.delete(owned.process));
      const journal = new RuntimeOwnedProcessJournal(directory);

      expect(journal.records(runtimeGenerationId)).toMatchObject([{
        state: "owned",
        process: { pid: owned.process.pid, processGroupId: owned.process.pid },
      }]);
      hardStop(owned.process);
      await closeOf(owned.process);
      expect(owned.confirmStopped()).toBe(true);
      expect(owned.confirmStopped()).toBe(true);
      expect(journal.records(runtimeGenerationId)).toEqual([]);
      expect(journal.finishSession(runtimeGenerationId)).toBe(true);
    });

    it("keeps a crash between spawn intent and identity fail-closed", async () => {
      const directory = temporaryDirectory();
      const journal = new RuntimeOwnedProcessJournal(directory);
      expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
      const ownershipId = journal.begin(runtimeGenerationId, systemBootId);
      const forceKill = vi.fn(async () => true);

      const recovery = recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        { deadlineAt: Date.now() + 2_000, forceKill },
      );

      await expect(recovery).resolves.toBe(false);
      expect(forceKill).not.toHaveBeenCalled();
      expect(journal.records(runtimeGenerationId)).toMatchObject([
        { state: "pending", ownershipId },
      ]);
    });

    it("recovers a prior app session before admitting its replacement", async () => {
      const directory = temporaryDirectory();
      const leases = new RuntimeGenerationLeaseJournal(directory);
      const receipts = new RuntimeCleanupReceiptJournal(directory);
      expect(leases.publish(runtimeGenerationId, systemBootId)).toBe(true);
      activate(directory);
      const child = longRunningChild();
      const close = closeOf(child);
      deactivate();

      const recovery = recoverPriorRuntimeGenerations({
        dataDirectory: directory,
        systemBootId,
        deadlineAt: Date.now() + 2_000,
        leases,
        receipts,
      });

      await expect(recovery).resolves.toBe(true);
      await close;
      leases.refresh();
      expect(leases.all()).toEqual([]);
      expect(receipts.pending()).toEqual([runtimeGenerationId]);
      expect(readdirSync(directory).some((name) =>
        name.startsWith(".runtime-owned-process-session-"))).toBe(false);
    });

    it("keeps a same-boot legacy lease without an ownership journal locked", () => {
      const directory = temporaryDirectory();
      const leases = new RuntimeGenerationLeaseJournal(directory);
      const receipts = new RuntimeCleanupReceiptJournal(directory);
      expect(leases.publish(runtimeGenerationId, systemBootId)).toBe(true);

      expect(recoverPriorRuntimeGenerations({
        dataDirectory: directory,
        systemBootId,
        deadlineAt: Date.now() + 2_000,
        leases,
        receipts,
      })).toBeNull();
      leases.refresh();
      expect(leases.all()).toMatchObject([{
        runtimeGenerationId,
        systemBootId,
      }]);
      expect(receipts.pending()).toEqual([]);
    });

    it("does not signal a reused PID whose start identity differs", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const journal = new RuntimeOwnedProcessJournal(directory);
      const record = journal.records(runtimeGenerationId)?.[0];
      if (!record || record.state !== "owned") throw new Error("Missing claim");
      const forceKill = vi.fn(async () => true);
      const kill = vi.fn<typeof process.kill>(() => true);
      deactivate();

      const recovery = recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        {
          deadlineAt: Date.now() + 2_000,
          forceKill,
          kill,
          readIdentity: () => ({
            ...record.process,
            startTimeTicks: `${BigInt(record.process.startTimeTicks) + 1n}`,
          }),
        },
      );

      await expect(recovery).resolves.toBe(false);
      expect(forceKill).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(journal.records(runtimeGenerationId)).toHaveLength(1);
      hardStop(child);
    });

    it("keeps a missing owned root fail-closed", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const journal = new RuntimeOwnedProcessJournal(directory);
      const record = journal.records(runtimeGenerationId)?.[0];
      if (!record || record.state !== "owned") throw new Error("Missing claim");
      deactivate();
      hardStop(child);
      await closeOf(child);
      const forceKill = vi.fn(async () => true);

      await expect(recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        {
          deadlineAt: Date.now() + 2_000,
          forceKill,
          readIdentity: () => null,
        },
      )).resolves.toBe(false);

      expect(forceKill).not.toHaveBeenCalled();
      expect(journal.records(runtimeGenerationId)).toEqual([record]);
    });

    it("revalidates the injected identity immediately before every signal", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const journal = new RuntimeOwnedProcessJournal(directory);
      const record = journal.records(runtimeGenerationId)?.[0];
      if (!record || record.state !== "owned") throw new Error("Missing claim");
      deactivate();
      let identityRead = 0;
      const readIdentity = vi.fn(() => {
        identityRead += 1;
        return identityRead === 1
          ? record.process
          : {
              ...record.process,
              startTimeTicks: `${BigInt(record.process.startTimeTicks) + 1n}`,
            };
      });
      const kill = vi.fn<typeof process.kill>(() => true);
      const forceKill = vi.fn(async (_pid, dependencies) => {
        try {
          dependencies.kill?.(-record.process.pid, "SIGKILL");
          return true;
        } catch {
          return false;
        }
      });

      await expect(recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        {
          deadlineAt: Date.now() + 2_000,
          forceKill,
          kill,
          readIdentity,
        },
      )).resolves.toBe(false);
      expect(forceKill).toHaveBeenCalledOnce();
      expect(readIdentity).toHaveBeenCalledTimes(2);
      expect(kill).not.toHaveBeenCalled();
      expect(journal.records(runtimeGenerationId)).toHaveLength(1);
      hardStop(child);
    });

    it("finishes a confirmed-remove crash without resurrecting ownership", () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const record = new RuntimeOwnedProcessJournal(directory)
        .records(runtimeGenerationId)?.[0];
      if (!record) throw new Error("Missing claim");
      const canonical = `.runtime-owned-child-${record.ownershipId}.json`;
      renameSync(
        join(directory, canonical),
        join(directory, `.runtime-owned-child-${record.ownershipId}.consume.tmp`),
      );

      expect(new RuntimeOwnedProcessJournal(directory)
        .records(runtimeGenerationId)).toEqual([]);
      deactivate();
      hardStop(child);
    });

    it("rejects malformed ownership instead of clearing the generation", () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const claimFile = readdirSync(directory).find((name) =>
        name.startsWith(".runtime-owned-child-")
        && name.endsWith(".json"));
      if (!claimFile) throw new Error("Missing claim");
      writeFileSync(join(directory, claimFile), "{\"state\":\"owned\"}", {
        encoding: "utf8",
        mode: 0o600,
      });

      expect(recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        { deadlineAt: Date.now() + 2_000 },
      )).toBeNull();
      deactivate();
      hardStop(child);
    });

    it("keeps legacy and unsupported-platform generations fail-closed", () => {
      const directory = temporaryDirectory();
      expect(recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        { deadlineAt: Date.now() + 2_000 },
      )).toBeNull();
      expect(recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        { deadlineAt: Date.now() + 2_000, platform: "win32" },
      )).toBeNull();
    });

    it("keeps ownership sessions as no-ops on unsupported platforms", () => {
      const directory = temporaryDirectory();
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        configurable: true,
        enumerable: true,
        value: "darwin",
      });
      try {
        const journal = new RuntimeOwnedProcessJournal(directory);
        expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
        expect(journal.finishSession(runtimeGenerationId)).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", {
          configurable: true,
          enumerable: true,
          value: originalPlatform,
        });
      }
    });
  },
);
