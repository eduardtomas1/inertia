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
  awaitRuntimeOwnedProcessCleanupConfirmed,
  confirmRuntimeOwnedProcessStopped,
  readLinuxProcessIdentity,
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

function processError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function linuxProcessStat(
  pid: number,
  parentPid: number | string,
  processGroupId: number,
  startTimeTicks = "123456",
): string {
  const fields = Array.from({ length: 20 }, () => "1");
  fields[0] = "S";
  fields[1] = String(parentPid);
  fields[2] = String(processGroupId);
  fields[19] = startTimeTicks;
  return `${pid} (runtime owned process) ${fields.join(" ")}`;
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

function rawLongRunningPidChild(): ChildProcess & { readonly pid: number } {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { detached: true, shell: false, stdio: "ignore" },
  );
  if (!child.pid) throw new Error("Missing child PID");
  liveChildren.add(child);
  child.once("close", () => liveChildren.delete(child));
  return child as ChildProcess & { readonly pid: number };
}

function preGroupIdentity(pid: number) {
  const identity = readLinuxProcessIdentity(pid);
  if (!identity) throw new Error("Missing child identity");
  return {
    ...identity,
    processGroupId: pid === 2 ? 3 : pid - 1,
  };
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
    it("reads an exact process identity after Linux reparents it to PID 1", () => {
      expect(readLinuxProcessIdentity(4_242, () =>
        linuxProcessStat(4_242, 1, 4_242, "987654"))).toEqual({
        pid: 4_242,
        parentPid: 1,
        processGroupId: 4_242,
        startTimeTicks: "987654",
      });
    });

    it.each([0, -1, "1.5", "not-a-pid"])(
      "rejects invalid Linux parent PID %s",
      (parentPid) => {
        expect(() => readLinuxProcessIdentity(4_242, () =>
          linuxProcessStat(4_242, parentPid, 4_242))).toThrow(
          "The owned process identity is invalid.",
        );
      },
    );

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

    it("retires a spawn intent when no child PID was created", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const journal = new RuntimeOwnedProcessJournal(directory);

      expect(() => spawnRuntimeOwnedProcess(() => {
        const child = spawn(
          "/inertia-missing-runtime-owned-process",
          [],
          { detached: true, shell: false, stdio: "ignore" },
        );
        child.once("error", () => undefined);
        expect(child.pid).toBeUndefined();
        return child;
      })).toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(journal.records(runtimeGenerationId)).toEqual([]);
      expect(journal.finishSession(runtimeGenerationId)).toBe(true);
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

    it("yields through a pre-setsid PID group transition before exposure", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      let elapsedMs = 0;
      let identityReads = 0;
      const waits: number[] = [];
      const owned = spawnRuntimeOwnedPidProcess(
        rawLongRunningPidChild,
        {
          now: () => elapsedMs,
          wait: (durationMs) => {
            waits.push(durationMs);
            elapsedMs += durationMs;
          },
          readIdentity: (pid) => {
            identityReads += 1;
            return identityReads <= 2
              ? preGroupIdentity(pid)
              : readLinuxProcessIdentity(pid);
          },
        },
      );
      const journal = new RuntimeOwnedProcessJournal(directory);

      expect(waits).toEqual([1, 1]);
      expect(elapsedMs).toBe(2);
      expect(journal.records(runtimeGenerationId)).toMatchObject([{
        state: "owned",
        process: { pid: owned.process.pid, processGroupId: owned.process.pid },
      }]);
      hardStop(owned.process);
      await closeOf(owned.process);
      expect(owned.confirmStopped()).toBe(true);
    });

    it.each([
      ["pid", (pid: number) => ({ ...preGroupIdentity(pid), pid: pid + 1 })],
      ["parent", (pid: number) => ({
        ...preGroupIdentity(pid),
        parentPid: process.pid + 1,
      })],
    ] as const)("rejects an exact %s mismatch before claiming a PID-backed child", async (
      _mismatch,
      identity,
    ) => {
      const directory = temporaryDirectory();
      activate(directory);
      let child!: ChildProcess & { readonly pid: number };
      vi.useFakeTimers();
      try {
        expect(() => spawnRuntimeOwnedPidProcess(
          () => {
            child = rawLongRunningPidChild();
            return child;
          },
          {
            readIdentity: identity,
            processCanExecute: () => null,
          },
        )).toThrow("identity could not be proven");
        const cleanup = awaitRuntimeOwnedProcessCleanupConfirmed();
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(cleanup).resolves.toBe(false);
        expect(new RuntimeOwnedProcessJournal(directory)
          .records(runtimeGenerationId)).toMatchObject([{ state: "pending" }]);
      } finally {
        vi.useRealTimers();
        await closeOf(child);
      }
    });

    it.each(["present", "eperm"] as const)(
      "keeps a failed PID claim pending while its exact group is %s",
      async (groupState) => {
        const directory = temporaryDirectory();
        activate(directory);
        let child!: ChildProcess & { readonly pid: number };
        let elapsedMs = 0;
        const nativeKill = process.kill;
        vi.useFakeTimers();
        const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (child && pid === -child.pid && signal === 0) {
            if (groupState === "eperm") throw processError("EPERM");
            return true;
          }
          return nativeKill(pid, signal);
        });
        try {
          expect(() => spawnRuntimeOwnedPidProcess(
            () => {
              child = rawLongRunningPidChild();
              return child;
            },
            {
              now: () => elapsedMs,
              wait: (durationMs) => {
                elapsedMs += durationMs;
              },
              readIdentity: preGroupIdentity,
              processCanExecute: () => false,
            },
          )).toThrow("group identity did not settle");
          const cleanup = awaitRuntimeOwnedProcessCleanupConfirmed();
          await vi.advanceTimersByTimeAsync(1_000);

          await expect(cleanup).resolves.toBe(false);
          expect(new RuntimeOwnedProcessJournal(directory)
            .records(runtimeGenerationId)).toMatchObject([{ state: "pending" }]);
        } finally {
          kill.mockRestore();
          vi.useRealTimers();
          await closeOf(child);
        }
      },
    );

    it("does not retire a failed PID claim before its direct child stops", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      let child!: ChildProcess & { readonly pid: number };
      let elapsedMs = 0;
      let executionProbes = 0;
      const nativeKill = process.kill;
      vi.useFakeTimers();
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (child && pid === -child.pid && signal === 0) {
          throw processError("ESRCH");
        }
        return nativeKill(pid, signal);
      });
      try {
        expect(() => spawnRuntimeOwnedPidProcess(
          () => {
            child = rawLongRunningPidChild();
            return child;
          },
          {
            now: () => elapsedMs,
            wait: (durationMs) => {
              elapsedMs += durationMs;
            },
            readIdentity: preGroupIdentity,
            processCanExecute: () => {
              executionProbes += 1;
              return executionProbes < 3;
            },
          },
        )).toThrow("group identity did not settle");
        const journal = new RuntimeOwnedProcessJournal(directory);
        const cleanup = awaitRuntimeOwnedProcessCleanupConfirmed();

        expect(journal.records(runtimeGenerationId)).toMatchObject([{
          state: "pending",
        }]);
        expect(kill).not.toHaveBeenCalledWith(-child.pid, 0);
        await vi.advanceTimersByTimeAsync(10);
        expect(journal.records(runtimeGenerationId)).toMatchObject([{
          state: "pending",
        }]);
        await vi.advanceTimersByTimeAsync(10);

        await expect(cleanup).resolves.toBe(true);
        expect(kill).toHaveBeenCalledWith(-child.pid, 0);
        expect(journal.records(runtimeGenerationId)).toEqual([]);
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
        await closeOf(child);
      }
    });

    it("retires a journal claim failure only after exact stopped proof", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      let child!: ChildProcess & { readonly pid: number };
      const journal = new RuntimeOwnedProcessJournal(directory);
      const claim = vi.spyOn(RuntimeOwnedProcessJournal.prototype, "claim")
        .mockImplementationOnce(() => {
          throw new Error("The spawned process ownership could not be persisted.");
        });
      const nativeKill = process.kill;
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (child && pid === -child.pid && signal === 0) {
          throw processError("ESRCH");
        }
        return nativeKill(pid, signal);
      });
      try {
        expect(() => spawnRuntimeOwnedPidProcess(
          () => {
            child = rawLongRunningPidChild();
            return child;
          },
          { processCanExecute: () => false },
        )).toThrow("could not be persisted");

        await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
        expect(claim).toHaveBeenCalledTimes(1);
        expect(journal.records(runtimeGenerationId)).toEqual([]);
      } finally {
        claim.mockRestore();
        kill.mockRestore();
        await closeOf(child);
      }
    });

    it("polls the exact process group until ESRCH before retiring its claim", async () => {
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
      const nativeKill = process.kill;
      let probes = 0;

      vi.useFakeTimers();
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -owned.process.pid && signal === 0) {
          probes += 1;
          if (probes >= 3) throw processError("ESRCH");
          return true;
        }
        return nativeKill(pid, signal);
      });
      try {
        owned.releaseIfGroupExited();
        const cleanup = awaitRuntimeOwnedProcessCleanupConfirmed();
        await vi.advanceTimersByTimeAsync(20);

        await expect(cleanup).resolves.toBe(true);
        expect(probes).toBe(3);
        expect(kill.mock.calls.filter(([pid, signal]) =>
          pid === -owned.process.pid && signal === 0)).toHaveLength(3);
        expect(journal.records(runtimeGenerationId)).toEqual([]);
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
      }
    });

    it.each(["present", "eperm"] as const)(
      "keeps a %s process group claim after the bounded exit poll",
      async (outcome) => {
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
        const nativeKill = process.kill;

        vi.useFakeTimers();
        const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === -owned.process.pid && signal === 0) {
            if (outcome === "eperm") throw processError("EPERM");
            return true;
          }
          return nativeKill(pid, signal);
        });
        try {
          owned.releaseIfGroupExited();
          const cleanup = awaitRuntimeOwnedProcessCleanupConfirmed();
          await vi.advanceTimersByTimeAsync(2_000);

          await expect(cleanup).resolves.toBe(false);
          expect(kill.mock.calls.filter(([pid, signal]) =>
            pid === -owned.process.pid && signal === 0).length).toBeGreaterThan(1);
          expect(journal.records(runtimeGenerationId)).toHaveLength(1);
        } finally {
          kill.mockRestore();
          vi.useRealTimers();
        }
      },
    );

    it("does not retire a claim after the active registry is replaced", async () => {
      const directory = temporaryDirectory();
      const replacementDirectory = temporaryDirectory();
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
      const nativeKill = process.kill;

      vi.useFakeTimers();
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -owned.process.pid && signal === 0) {
          return true;
        }
        return nativeKill(pid, signal);
      });
      try {
        owned.releaseIfGroupExited();
        expect(kill).toHaveBeenCalledTimes(1);
        deactivate();
        activate(replacementDirectory);
        await vi.advanceTimersByTimeAsync(2_000);

        expect(kill).toHaveBeenCalledTimes(1);
        expect(journal.records(runtimeGenerationId)).toHaveLength(1);
        expect(new RuntimeOwnedProcessJournal(replacementDirectory)
          .records(runtimeGenerationId)).toEqual([]);
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
      }
    });

    it("observes immediate group exit before shutdown can overtake a timer", async () => {
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
      const nativeKill = process.kill;
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -owned.process.pid && signal === 0) {
          throw processError("ESRCH");
        }
        return nativeKill(pid, signal);
      });
      try {
        owned.releaseIfGroupExited();

        await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
        expect(kill).toHaveBeenCalledWith(-owned.process.pid, 0);
        expect(journal.records(runtimeGenerationId)).toEqual([]);
      } finally {
        kill.mockRestore();
      }
    });

    it("retires a closed child before later close listeners run", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const journal = new RuntimeOwnedProcessJournal(directory);
      const nativeKill = process.kill;
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -(child.pid ?? 0) && signal === 0) {
          throw processError("ESRCH");
        }
        return nativeKill(pid, signal);
      });
      let recordsAtCallerClose: ReturnType<RuntimeOwnedProcessJournal["records"]>;
      child.once("close", () => {
        recordsAtCallerClose = journal.records(runtimeGenerationId);
      });
      try {
        hardStop(child);
        await closeOf(child);

        expect(recordsAtCallerClose!).toEqual([]);
        expect(kill).toHaveBeenCalledWith(-(child.pid ?? 0), 0);
      } finally {
        kill.mockRestore();
      }
    });

    it("awaits closing claims that appear while an earlier one settles", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const createOwned = () => spawnRuntimeOwnedPidProcess(() => {
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(() => undefined, 1000)"],
          { detached: true, shell: false, stdio: "ignore" },
        );
        if (!child.pid) throw new Error("Missing child PID");
        liveChildren.add(child);
        child.once("close", () => liveChildren.delete(child));
        return child as ChildProcess & { readonly pid: number };
      });
      const first = createOwned();
      const second = createOwned();
      const probes = new Map<number, number>();
      const nativeKill = process.kill;
      vi.useFakeTimers();
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (typeof pid === "number" && pid < 0 && signal === 0) {
          const processId = -pid;
          const count = (probes.get(processId) ?? 0) + 1;
          probes.set(processId, count);
          if (processId === first.process.pid && count >= 2) {
            throw processError("ESRCH");
          }
          if (processId === second.process.pid && count >= 3) {
            throw processError("ESRCH");
          }
          return true;
        }
        return nativeKill(pid, signal);
      });
      try {
        first.releaseIfGroupExited();
        const cleanup = awaitRuntimeOwnedProcessCleanupConfirmed();
        second.releaseIfGroupExited();
        await vi.advanceTimersByTimeAsync(20);

        await expect(cleanup).resolves.toBe(true);
        expect(probes.get(first.process.pid)).toBe(2);
        expect(probes.get(second.process.pid)).toBe(3);
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
      }
    });

    it("fails closed immediately when an owned claim has not begun closing", async () => {
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
      const kill = vi.spyOn(process, "kill");
      try {
        await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(false);
        expect(kill).not.toHaveBeenCalledWith(-owned.process.pid, 0);
      } finally {
        kill.mockRestore();
      }
    });

    it("memoizes close confirmation and lets manual settlement complete it", async () => {
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
      const nativeKill = process.kill;
      vi.useFakeTimers();
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -owned.process.pid && signal === 0) return true;
        return nativeKill(pid, signal);
      });
      try {
        owned.releaseIfGroupExited();
        owned.releaseIfGroupExited();
        expect(owned.confirmStopped()).toBe(true);

        await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
        expect(kill).toHaveBeenCalledTimes(1);
        expect(journal.records(runtimeGenerationId)).toEqual([]);
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
      }
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

    it("recovers an exact owned root after Linux reparents it to PID 1", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const journal = new RuntimeOwnedProcessJournal(directory);
      const record = journal.records(runtimeGenerationId)?.[0];
      if (!record || record.state !== "owned") throw new Error("Missing claim");
      const forceKill = vi.fn(async () => true);
      deactivate();

      const recovery = recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        {
          deadlineAt: Date.now() + 2_000,
          forceKill,
          readIdentity: (pid) => readLinuxProcessIdentity(pid, () =>
            linuxProcessStat(
              record.process.pid,
              1,
              record.process.processGroupId,
              record.process.startTimeTicks,
            )),
        },
      );

      await expect(recovery).resolves.toBe(true);
      expect(forceKill).toHaveBeenCalledWith(record.process.pid, expect.objectContaining({
        rootProcessGroup: true,
      }));
      expect(journal.records(runtimeGenerationId)).toEqual([]);
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
