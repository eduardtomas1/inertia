import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
  readDarwinProcessIdentity,
  recoverPriorRuntimeGenerations,
  recoverRuntimeOwnedProcesses,
} from "../../src/main/runtime-owned-process-recovery";
import { windowsRuntimeJobName } from "../../src/main/windows-runtime-job";
import { RuntimeCleanupReceiptJournal } from "../../src/main/runtime-cleanup-receipts";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import {
  activateRuntimeOwnedProcessRegistry,
  confirmRuntimeOwnedProcessStopped,
  darwinProcessGuardianReady,
  darwinProcessSessionEmpty,
  readLinuxProcessIdentity,
  runtimeOwnedProcessInvocation,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import { runtimeOwnedPtyInvocation } from "../../src/node/runtime-owned-pty-invocation";

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
    process.platform === "darwin" || process.platform === "linux"
      ? {
          darwinGuardianPath: join(
            process.cwd(),
            "resources/generated/runtime-process-guardian/runtime-process-guardian",
          ),
        }
      : {},
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
  const invocation = runtimeOwnedProcessInvocation(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
  );
  const child = spawnRuntimeOwnedProcess(() => spawn(
    invocation.command,
    invocation.args,
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ESRCH"
    );
  }
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

      child.kill("SIGTERM");
      await close;
      deactivate();
      const recovery = recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        { deadlineAt: Date.now() + 2_000 },
      );
      expect(recovery).toBe(true);
      expect(journal.records(runtimeGenerationId)).toEqual([]);
      expect(journal.finishSession(runtimeGenerationId)).toBe(true);
    });

    it("retires a normally closed child and its completed session", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const journal = new RuntimeOwnedProcessJournal(directory);

      child.kill("SIGTERM");
      await closeOf(child);
      await vi.waitFor(() => {
        expect(confirmRuntimeOwnedProcessStopped(child)).toBe(true);
      });
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
      if (!("startTimeTicks" in record.process)) throw new Error("Missing Linux claim");
      const processIdentity = record.process;
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
            ...processIdentity,
            startTimeTicks: `${BigInt(processIdentity.startTimeTicks) + 1n}`,
          }),
        },
      );

      await expect(recovery).resolves.toBe(false);
      expect(forceKill).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(journal.records(runtimeGenerationId)).toHaveLength(1);
      hardStop(child);
    });

    it("keeps a missing Linux guardian fail-closed without terminal proof", async () => {
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
          darwinGuardianPath: join(
            process.cwd(),
            "resources/generated/runtime-process-guardian/runtime-process-guardian",
          ),
          forceKill,
          readIdentity: () => null,
        },
      )).resolves.toBe(false);

      expect(forceKill).not.toHaveBeenCalled();
      expect(journal.records(runtimeGenerationId)).toEqual([record]);
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

describe("cross-platform runtime owned process recovery", () => {
  it("preserves a verbatim Windows PTY command line without array quoting", () => {
    const commandLine = '/d /s /v:off /c "C:\\Tools\\agent.cmd ^"hello world^""';
    expect(runtimeOwnedPtyInvocation(
      "C:\\Windows\\System32\\cmd.exe",
      commandLine,
    )).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: commandLine,
    });
  });

  it("wraps every macOS owned command behind the native guardian", () => {
    const directory = temporaryDirectory();
    const deactivateRegistry = activateRuntimeOwnedProcessRegistry(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        darwinGuardianPath: "/trusted/runtime-process-guardian",
      },
    );
    expect(runtimeOwnedProcessInvocation("/usr/bin/git", ["status"])).toEqual({
      command: "/trusted/runtime-process-guardian",
      args: ["watch", String(process.pid), "--", "/usr/bin/git", "status"],
    });
    expect(runtimeOwnedPtyInvocation("/usr/bin/login", "-fp test-user"))
      .toEqual({
        command: "/trusted/runtime-process-guardian",
        args: [
          "watch",
          String(process.pid),
          "--",
          "/usr/bin/login",
          "-fp test-user",
        ],
      });
    deactivateRegistry?.();
  });

  it("wraps Linux PTY commands behind the native guardian", () => {
    const directory = temporaryDirectory();
    const guardianPath = join(directory, "runtime-process-guardian");
    writeFileSync(guardianPath, "trusted helper", { mode: 0o700 });
    const executable = statSync(guardianPath, { bigint: true });
    const deactivateRegistry = activateRuntimeOwnedProcessRegistry(
      directory,
      runtimeGenerationId,
      systemBootId,
      { platform: "linux", darwinGuardianPath: guardianPath },
    );
    try {
      expect(runtimeOwnedPtyInvocation("/bin/sh", ["-l"])).toEqual({
        command: guardianPath,
        args: [
          "watch",
          String(process.pid),
          String(executable.dev),
          String(executable.ino),
          "--",
          "/bin/sh",
          "-l",
        ],
      });
    } finally {
      deactivateRegistry?.();
    }
  });

  it("retires an unarmed macOS spawn window after its runtime parent is gone", async () => {
    const directory = temporaryDirectory();
    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "darwin",
      darwinGuardianPath: "/trusted/runtime-process-guardian",
    });
    expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
    journal.begin(runtimeGenerationId, systemBootId);
    const kill = vi.fn<typeof process.kill>((pid, signal) => {
      expect(pid).toBe(process.pid);
      expect(signal).toBe(0);
      throw processError("ESRCH");
    });
    const waitForProcessGroupDrain = vi.fn(async () => undefined);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        kill,
        waitForProcessGroupDrain,
      },
    )).resolves.toBe(true);

    expect(waitForProcessGroupDrain).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledOnce();
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("retires an unarmed macOS spawn window across an exact boot change", async () => {
    const directory = temporaryDirectory();
    const priorBootId = "test:30000000-0000-4000-8000-000000000003";
    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "darwin",
      darwinGuardianPath: "/trusted/runtime-process-guardian",
    });
    expect(journal.startSession(runtimeGenerationId, priorBootId)).toBe(true);
    journal.begin(runtimeGenerationId, priorBootId);
    const kill = vi.fn<typeof process.kill>(() => true);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        kill,
      },
    )).resolves.toBe(true);

    expect(kill).not.toHaveBeenCalled();
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("keeps guarded macOS spawn windows while their runtime parent exists", async () => {
    const directory = temporaryDirectory();
    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "darwin",
      darwinGuardianPath: "/trusted/runtime-process-guardian",
    });
    expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
    journal.begin(runtimeGenerationId, systemBootId);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        kill: () => true,
        waitForProcessGroupDrain: async () => undefined,
      },
    )).resolves.toBe(false);

    expect(journal.records(runtimeGenerationId)).toMatchObject([{
      state: "pending",
      containment: "darwin-parent-watchdog-v1",
      runtimeParentPid: process.pid,
    }]);
  });

  it("keeps unguarded macOS spawn windows fail-closed", async () => {
    const directory = temporaryDirectory();
    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "darwin",
    });
    expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
    journal.begin(runtimeGenerationId, systemBootId);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        kill: () => { throw processError("ESRCH"); },
        waitForProcessGroupDrain: async () => undefined,
      },
    )).resolves.toBe(false);

    expect(journal.records(runtimeGenerationId)).toMatchObject([{
      state: "pending",
    }]);
  });

  function portableClaim(
    directory: string,
    platform: "darwin" | "win32",
    pid = 4_242,
  ) {
    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform,
      ...(platform === "darwin"
        ? {
            darwinGuardianPath: "/trusted/runtime-process-guardian",
            readDarwinIdentity: () => ({
              platform: "darwin" as const,
              pid,
              parentPid: 101,
              processGroupId: pid,
              sessionId: pid,
              startTimeSeconds: "1756100000",
              startTimeMicroseconds: 123_456,
            }),
          }
        : {}),
    });
    expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
    const ownershipId = journal.begin(runtimeGenerationId, systemBootId);
    const claim = journal.claim(
      ownershipId,
      runtimeGenerationId,
      systemBootId,
      pid,
      101,
      { spawnedAfterMs: 10_000, spawnedBeforeMs: 10_001 },
    );
    if (!("platform" in claim.process)) {
      throw new Error("Expected a portable process claim");
    }
    return { claim, journal };
  }

  it.each(["missing", "mismatched"] as const)(
    "rejects a Darwin ownership record with a %s session identity",
    (sessionIdentity) => {
      const directory = temporaryDirectory();
      const { claim, journal } = portableClaim(directory, "darwin");
      const claimFile = join(
        directory,
        `.runtime-owned-child-${claim.ownershipId}.json`,
      );
      const stored = JSON.parse(readFileSync(claimFile, "utf8")) as {
        process: { sessionId?: number };
      };
      if (sessionIdentity === "missing") {
        delete stored.process.sessionId;
      } else {
        stored.process.sessionId = claim.process.pid + 1;
      }
      writeFileSync(claimFile, JSON.stringify(stored), {
        encoding: "utf8",
        mode: 0o600,
      });

      expect(journal.records(runtimeGenerationId)).toBeNull();
    },
  );

  it("rejects a Darwin guardian outside its own private session at claim time", () => {
    const directory = temporaryDirectory();
    const pid = 4_242;
    const journal = new RuntimeOwnedProcessJournal(directory, {
      platform: "darwin",
      darwinGuardianPath: "/trusted/runtime-process-guardian",
      readDarwinIdentity: () => ({
        platform: "darwin",
        pid,
        parentPid: 101,
        processGroupId: pid,
        sessionId: pid + 1,
        startTimeSeconds: "1756100000",
        startTimeMicroseconds: 123_456,
      }),
    });
    expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
    const ownershipId = journal.begin(runtimeGenerationId, systemBootId);

    expect(() => journal.claim(
      ownershipId,
      runtimeGenerationId,
      systemBootId,
      pid,
      101,
    )).toThrow("ownership could not be proven");
  });

  it("recovers an exact Windows Job Object without rebooting", async () => {
    const directory = temporaryDirectory();
    const { journal } = portableClaim(directory, "win32");
    const containment = {
      kind: "windows-job-v1" as const,
      name: windowsRuntimeJobName(runtimeGenerationId),
    };
    expect(journal.armContainment(
      runtimeGenerationId,
      systemBootId,
      containment,
    )).toBe(true);
    const recoverWindowsJob = vi.fn(async () => true);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "win32",
        deadlineAt: Date.now() + 2_000,
        recoverWindowsJob,
      },
    )).resolves.toBe(true);

    expect(recoverWindowsJob).toHaveBeenCalledWith(
      containment,
      expect.any(Number),
    );
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("keeps Windows claims fail-closed without a durable Job Object", async () => {
    const directory = temporaryDirectory();
    const { claim, journal } = portableClaim(directory, "win32");
    const recoverWindowsJob = vi.fn(async () => true);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "win32",
        deadlineAt: Date.now() + 2_000,
        recoverWindowsJob,
      },
    )).resolves.toBe(false);

    expect(recoverWindowsJob).not.toHaveBeenCalled();
    expect(journal.records(runtimeGenerationId)).toEqual([claim]);
  });

  it("keeps Windows claims when exact Job Object termination is unconfirmed", async () => {
    const directory = temporaryDirectory();
    const { claim, journal } = portableClaim(directory, "win32");
    const containment = {
      kind: "windows-job-v1" as const,
      name: windowsRuntimeJobName(runtimeGenerationId),
    };
    expect(journal.armContainment(
      runtimeGenerationId,
      systemBootId,
      containment,
    )).toBe(true);
    const recoverWindowsJob = vi.fn(async () => false);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "win32",
        deadlineAt: Date.now() + 2_000,
        recoverWindowsJob,
      },
    )).resolves.toBe(false);

    expect(recoverWindowsJob).toHaveBeenCalledOnce();
    expect(journal.records(runtimeGenerationId)).toEqual([claim]);
  });

  it("rejects a malformed Windows containment marker", async () => {
    const directory = temporaryDirectory();
    const { claim, journal } = portableClaim(directory, "win32");
    const containment = {
      kind: "windows-job-v1" as const,
      name: windowsRuntimeJobName(runtimeGenerationId),
    };
    expect(journal.armContainment(
      runtimeGenerationId,
      systemBootId,
      containment,
    )).toBe(true);
    const marker = readdirSync(directory).find((name) =>
      name.startsWith(".runtime-owned-process-containment-")
      && name.endsWith(".json"));
    if (!marker) throw new Error("Missing containment marker");
    writeFileSync(join(directory, marker), "{}", { mode: 0o600 });
    const recoverWindowsJob = vi.fn(async () => true);

    expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "win32",
        deadlineAt: Date.now() + 2_000,
        recoverWindowsJob,
      },
    )).toBeNull();

    expect(recoverWindowsJob).not.toHaveBeenCalled();
    expect(journal.records(runtimeGenerationId)).toEqual([claim]);
  });

  it("asks the exact macOS guardian to drain its session without rebooting", async () => {
    const directory = temporaryDirectory();
    const { claim, journal } = portableClaim(directory, "darwin");
    const forceKill = vi.fn(async () => true);
    let guardianAlive = true;
    const identity = {
      platform: "darwin" as const,
      pid: claim.process.pid,
      parentPid: 101,
      processGroupId: claim.process.pid,
      sessionId: claim.process.pid,
      startTimeSeconds: "1756100000",
      startTimeMicroseconds: 123_456,
    };
    const kill = vi.fn<(
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => true>((pid, signal) => {
      expect(pid).toBe(claim.process.pid);
      expect(signal).toBe("SIGTERM");
      guardianAlive = false;
      return true;
    });

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        forceKill,
        kill,
        readIdentity: () => guardianAlive ? identity : null,
        readDarwinSessionEmpty: () => !guardianAlive,
      },
    )).resolves.toBe(true);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(forceKill).not.toHaveBeenCalled();
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("never signals a reused macOS guardian PID during recovery", async () => {
    const directory = temporaryDirectory();
    const { claim, journal } = portableClaim(directory, "darwin");
    if (!("platform" in claim.process) || claim.process.platform !== "darwin") {
      throw new Error("Missing macOS claim");
    }
    const darwinProcess = claim.process;
    const kill = vi.fn<typeof process.kill>(() => true);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        kill,
        readIdentity: () => ({
          ...darwinProcess,
          startTimeMicroseconds: darwinProcess.startTimeMicroseconds + 1,
        }),
        readDarwinSessionEmpty: () => false,
      },
    )).resolves.toBe(false);

    expect(kill).not.toHaveBeenCalled();
    expect(journal.records(runtimeGenerationId)).toEqual([claim]);
  });

  it("retires a missing macOS guardian only when its session is empty", async () => {
    const directory = temporaryDirectory();
    const { journal } = portableClaim(directory, "darwin");
    const kill = vi.fn<(
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => true>(() => true);
    const readDarwinSessionEmpty = vi.fn(() => true);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        kill,
        readIdentity: () => null,
        readDarwinSessionEmpty,
      },
    )).resolves.toBe(true);

    expect(kill).not.toHaveBeenCalled();
    expect(readDarwinSessionEmpty).toHaveBeenCalledWith(4_242);
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("waits for a missing macOS guardian's session to drain", async () => {
    const directory = temporaryDirectory();
    const { journal } = portableClaim(directory, "darwin");
    let probe = 0;
    const readDarwinSessionEmpty = vi.fn(() => {
      probe += 1;
      return probe >= 3;
    });
    const waitForProcessGroupDrain = vi.fn(async () => undefined);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        readIdentity: () => null,
        readDarwinSessionEmpty,
        waitForProcessGroupDrain,
      },
    )).resolves.toBe(true);

    expect(waitForProcessGroupDrain).toHaveBeenCalledTimes(2);
    expect(waitForProcessGroupDrain).toHaveBeenCalledWith(20);
    expect(readDarwinSessionEmpty).toHaveBeenCalledTimes(3);
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("keeps an occupied macOS session fail-closed when its guardian is missing", async () => {
    const directory = temporaryDirectory();
    const { claim, journal } = portableClaim(directory, "darwin");
    const readDarwinSessionEmpty = vi.fn(() => false);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        readIdentity: () => null,
        readDarwinSessionEmpty,
        waitForProcessGroupDrain: async () => undefined,
      },
    )).resolves.toBe(false);

    expect(readDarwinSessionEmpty).toHaveBeenCalledTimes(51);
    expect(journal.records(runtimeGenerationId)).toEqual([claim]);
  });

  it.each(["darwin", "win32"] as const)(
    "retires an empty %s ownership session and its generation lease",
    async (platform) => {
      const directory = temporaryDirectory();
      const leases = new RuntimeGenerationLeaseJournal(directory);
      const receipts = new RuntimeCleanupReceiptJournal(directory);
      expect(leases.publish(runtimeGenerationId, systemBootId)).toBe(true);
      expect(new RuntimeOwnedProcessJournal(directory, { platform })
        .startSession(runtimeGenerationId, systemBootId)).toBe(true);

      const recovery = recoverPriorRuntimeGenerations({
        dataDirectory: directory,
        systemBootId,
        deadlineAt: Date.now() + 2_000,
        leases,
        receipts,
        platform,
      });

      await expect(recovery).resolves.toBe(true);
      leases.refresh();
      expect(leases.all()).toEqual([]);
      expect(receipts.pending()).toEqual([runtimeGenerationId]);
    },
  );

  it.each([
    ["unavailable", systemBootId],
    [systemBootId, "unavailable"],
  ] as const)(
    "recovers an empty Linux exact session across boot probe transition %s -> %s",
    async (recordedBootId, currentBootId) => {
      const directory = temporaryDirectory();
      const leases = new RuntimeGenerationLeaseJournal(directory);
      const receipts = new RuntimeCleanupReceiptJournal(directory);
      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      expect(leases.publish(runtimeGenerationId, recordedBootId)).toBe(true);
      expect(new RuntimeOwnedProcessJournal(directory, {
        platform: "linux",
        darwinGuardianPath: guardianPath,
      }).startSession(runtimeGenerationId, recordedBootId)).toBe(true);

      await expect(recoverPriorRuntimeGenerations({
        dataDirectory: directory,
        systemBootId: currentBootId,
        deadlineAt: Date.now() + 2_000,
        leases,
        receipts,
        platform: "linux",
        darwinGuardianPath: guardianPath,
      })).resolves.toBe(true);
      leases.refresh();
      expect(leases.all()).toEqual([]);
      expect(receipts.pending()).toEqual([runtimeGenerationId]);
    },
  );

  it("reads a bounded macOS process birth identity", () => {
    const spawnProcessSync = vi.fn(() => ({
      status: 0,
      stdout: "4242|101|4242|4242|1756100000|123456\n",
      stderr: "",
    }));

    expect(readDarwinProcessIdentity(4_242, "/trusted/runtime-process-guardian", {
      platform: "darwin",
      deadlineAt: Date.now() + 2_000,
      spawnProcessSync: spawnProcessSync as never,
    })).toEqual({
      platform: "darwin",
      pid: 4_242,
      parentPid: 101,
      processGroupId: 4_242,
      sessionId: 4_242,
      startTimeSeconds: "1756100000",
      startTimeMicroseconds: 123_456,
    });
    expect(spawnProcessSync).toHaveBeenCalledWith(
      "/trusted/runtime-process-guardian",
      ["identity", "4242"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("reads macOS session emptiness without accepting helper output", () => {
    const empty = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    expect(darwinProcessSessionEmpty(
      4_242,
      "/trusted/runtime-process-guardian",
      { platform: "darwin", spawnProcessSync: empty as never },
    )).toBe(true);
    expect(empty).toHaveBeenCalledWith(
      "/trusted/runtime-process-guardian",
      ["session-empty", "4242"],
      expect.objectContaining({ shell: false }),
    );

    const occupied = vi.fn(() => ({ status: 4, stdout: "", stderr: "" }));
    expect(darwinProcessSessionEmpty(
      4_242,
      "/trusted/runtime-process-guardian",
      { platform: "darwin", spawnProcessSync: occupied as never },
    )).toBe(false);

    const noisy = vi.fn(() => ({ status: 0, stdout: "true\n", stderr: "" }));
    expect(() => darwinProcessSessionEmpty(
      4_242,
      "/trusted/runtime-process-guardian",
      { platform: "darwin", spawnProcessSync: noisy as never },
    )).toThrow("session result is invalid");
  });

  it("requires an exact bounded macOS guardian readiness identity", () => {
    const ready = vi.fn(() => ({
      status: 0,
      stdout: "4242|101|4242|4242|1756100000|123456\n",
      stderr: "",
    }));
    expect(darwinProcessGuardianReady(
      4_242,
      "/trusted/runtime-process-guardian",
      { platform: "darwin", spawnProcessSync: ready as never },
    )).toMatchObject({ pid: 4_242, sessionId: 4_242 });
    expect(ready).toHaveBeenCalledWith(
      "/trusted/runtime-process-guardian",
      ["ready", "4242"],
      expect.objectContaining({ shell: false }),
    );

    const notReady = vi.fn(() => ({ status: 4, stdout: "", stderr: "" }));
    expect(darwinProcessGuardianReady(
      4_242,
      "/trusted/runtime-process-guardian",
      { platform: "darwin", spawnProcessSync: notReady as never },
    )).toBeNull();

    const reused = vi.fn(() => ({
      status: 0,
      stdout: "4242|101|4242|4242|1756100001|123456\n",
      stderr: "",
    }));
    const journal = new RuntimeOwnedProcessJournal(temporaryDirectory(), {
      platform: "darwin",
      darwinGuardianPath: "/trusted/runtime-process-guardian",
      readDarwinGuardianReady: () => ({
        platform: "darwin",
        pid: 4_242,
        parentPid: 101,
        processGroupId: 4_242,
        sessionId: 4_242,
        startTimeSeconds: "1756100001",
        startTimeMicroseconds: 123_456,
      }),
    });
    expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
    const ownershipId = journal.begin(runtimeGenerationId, systemBootId);
    expect(() => journal.claim(
      ownershipId,
      runtimeGenerationId,
      systemBootId,
      4_242,
      101,
      {
        expectedDarwinIdentity: {
          platform: "darwin",
          pid: 4_242,
          parentPid: 101,
          processGroupId: 4_242,
          sessionId: 4_242,
          startTimeSeconds: "1756100000",
          startTimeMicroseconds: 123_456,
        },
      },
    )).toThrow("could not be proven");
    expect(reused).not.toHaveBeenCalled();
  });

  it("never signals a reused macOS guardian PID after a claim failure", () => {
    const directory = temporaryDirectory();
    const expected = {
      platform: "darwin" as const,
      pid: 4_242,
      parentPid: process.pid,
      processGroupId: 4_242,
      sessionId: 4_242,
      startTimeSeconds: "1756100000",
      startTimeMicroseconds: 123_456,
    };
    const deactivate = activateRuntimeOwnedProcessRegistry(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        darwinGuardianPath: "/trusted/runtime-process-guardian",
        readDarwinGuardianReady: () => expected,
        readDarwinIdentity: () => ({
          ...expected,
          startTimeSeconds: "1756100001",
        }),
      },
    );
    if (deactivate) deactivators.push(deactivate);
    const claim = vi.spyOn(RuntimeOwnedProcessJournal.prototype, "claim")
      .mockImplementationOnce(() => {
        throw new Error("The spawned process ownership could not be persisted.");
      });
    const childKill = vi.fn(() => true);
    const processKill = vi.spyOn(process, "kill");
    try {
      expect(() => spawnRuntimeOwnedProcess(() => ({
        pid: 4_242,
        spawnfile: "/trusted/runtime-process-guardian",
        kill: childKill,
        once: vi.fn(),
      } as unknown as ChildProcess))).toThrow("could not be persisted");
      expect(childKill).not.toHaveBeenCalled();
      expect(processKill).not.toHaveBeenCalledWith(4_242, "SIGUSR1");
      expect(processKill).not.toHaveBeenCalledWith(4_242, "SIGKILL");
      expect(processKill).not.toHaveBeenCalledWith(-4_242, "SIGKILL");
    } finally {
      claim.mockRestore();
      processKill.mockRestore();
      deactivate?.();
      if (deactivate) deactivators.splice(deactivators.indexOf(deactivate), 1);
    }
  });

  it("distinguishes an absent macOS PID from an invalid guardian result", () => {
    const missing = vi.fn(() => ({ status: 3, stdout: "", stderr: "" }));
    expect(readDarwinProcessIdentity(
      4_242,
      "/trusted/runtime-process-guardian",
      { platform: "darwin", spawnProcessSync: missing as never },
    )).toBeNull();

    const malformed = vi.fn(() => ({
      status: 0,
      stdout: "4242|101|4242|4242|seconds|0\n",
      stderr: "",
    }));
    expect(() => readDarwinProcessIdentity(
      4_242,
      "/trusted/runtime-process-guardian",
      { platform: "darwin", spawnProcessSync: malformed as never },
    )).toThrow("identity is invalid");

    const wrongSession = vi.fn(() => ({
      status: 0,
      stdout: "4242|101|4242|4243|1756100000|123456\n",
      stderr: "",
    }));
    expect(() => readDarwinProcessIdentity(
      4_242,
      "/trusted/runtime-process-guardian",
      { platform: "darwin", spawnProcessSync: wrongSession as never },
    )).toThrow("identity is invalid");
  });

  it.runIf(process.platform === "darwin")(
    "macOS guardian drains a setsid descendant without touching an unrelated session",
    async () => {
      const directory = temporaryDirectory();
      const payloadSourcePath = join(directory, "session-payload.c");
      const payloadPath = join(directory, "session-payload");
      const rootIdentityPath = join(directory, "root.identity");
      const childIdentityPath = join(directory, "child.identity");
      writeFileSync(payloadSourcePath, [
        "#include <stdio.h>",
        "#include <stdlib.h>",
        "#include <sys/types.h>",
        "#include <unistd.h>",
        "static void publish(const char *path) {",
        "  FILE *stream = fopen(path, \"w\");",
        "  if (!stream) _exit(72);",
        "  fprintf(stream, \"%d|%d|%d\\n\", getpid(), getpgrp(), getsid(0));",
        "  if (fclose(stream) != 0) _exit(73);",
        "}",
        "int main(int argc, char **argv) {",
        "  if (argc != 3) return 64;",
        "  if (setsid() != getpid()) return 74;",
        "  publish(argv[1]);",
        "  publish(argv[2]);",
        "  for (;;) pause();",
        "}",
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
      const built = spawnSync(
        "/usr/bin/xcrun",
        [
          "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
          payloadSourcePath, "-o", payloadPath,
        ],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          shell: false,
          timeout: 30_000,
        },
      );
      expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)"],
        { detached: true, shell: false, stdio: "ignore" },
      );
      liveChildren.add(unrelated);
      unrelated.once("close", () => liveChildren.delete(unrelated));
      expect(unrelated.pid).toBeGreaterThan(1);
      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      const parentSource = [
        "const {spawn,spawnSync}=require('node:child_process')",
        `const guardian=spawn(${JSON.stringify(guardianPath)},['watch',String(process.pid),'--',${JSON.stringify(payloadPath)},${JSON.stringify(rootIdentityPath)},${JSON.stringify(childIdentityPath)}],{detached:true,stdio:'ignore'})`,
        "process.stdout.write(String(guardian.pid)+'\\n')",
        `process.stdin.once('data',()=>{const ready=spawnSync(${JSON.stringify(guardianPath)},['ready',String(guardian.pid)],{stdio:'ignore',timeout:2000});if(ready.status!==0)process.exit(75);process.kill(guardian.pid,'SIGUSR1')})`,
        "setInterval(() => undefined, 1000)",
      ].join(";");
      const parent = spawn(process.execPath, ["-e", parentSource], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      liveChildren.add(parent);
      parent.once("close", () => liveChildren.delete(parent));
      let guardianOutput = "";
      parent.stdout?.on("data", (chunk: Buffer) => {
        guardianOutput += chunk.toString("utf8");
      });

      let guardianPid = 0;
      await expect.poll(() => {
        guardianPid = Number(guardianOutput.trim());
        return Number.isSafeInteger(guardianPid) && guardianPid > 1;
      }, { timeout: 5_000 }).toBe(true);
      await expect.poll(
        () => darwinProcessGuardianReady(guardianPid, guardianPath)?.pid ?? 0,
        { timeout: 5_000 },
      ).toBe(guardianPid);
      expect(existsSync(rootIdentityPath)).toBe(false);
      expect(existsSync(childIdentityPath)).toBe(false);
      process.kill(guardianPid, "SIGUSR1");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(rootIdentityPath)).toBe(false);
      expect(existsSync(childIdentityPath)).toBe(false);
      parent.stdin?.write("authorize\n");
      let rootIdentity: number[] = [];
      let childIdentity: number[] = [];
      await expect.poll(() => {
        if (existsSync(rootIdentityPath)) {
          rootIdentity = readFileSync(rootIdentityPath, "utf8")
            .trim().split("|").map(Number);
        }
        if (existsSync(childIdentityPath)) {
          childIdentity = readFileSync(childIdentityPath, "utf8")
            .trim().split("|").map(Number);
        }
        return rootIdentity.length === 3 && childIdentity.length === 3;
      }, { timeout: 5_000 }).toBe(true);
      const [rootPid, rootGroupId, rootSessionId] = rootIdentity;
      const [childPid, childGroupId, childSessionId] = childIdentity;
      expect(rootPid).toBeGreaterThan(1);
      expect(childPid).toBeGreaterThan(1);
      expect(rootPid).toBe(childPid);
      expect(rootGroupId).toBe(rootPid);
      expect(childGroupId).toBe(childPid);
      expect(rootSessionId).toBe(rootPid);
      expect(childSessionId).toBe(childPid);

      parent.kill("SIGKILL");
      await closeOf(parent);
      await expect.poll(
        () => !processIsAlive(guardianPid)
          && !processIsAlive(rootPid!)
          && !processIsAlive(childPid!),
        { timeout: 5_000 },
      ).toBe(true);
      expect(processIsAlive(unrelated.pid ?? 0)).toBe(true);
      unrelated.kill("SIGKILL");
      await closeOf(unrelated);
    },
    10_000,
  );

  it.runIf(process.platform === "darwin")(
    "macOS guardian never starts its payload when stopped or orphaned before authorization",
    async () => {
      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      for (const termination of ["guardian", "runtime-parent"] as const) {
        const payloadPath = join(temporaryDirectory(), `${termination}.started`);
        const parentSource = [
          "const {spawn}=require('node:child_process')",
          `const guardian=spawn(${JSON.stringify(guardianPath)},['watch',String(process.pid),'--','/usr/bin/touch',${JSON.stringify(payloadPath)}],{detached:true,stdio:'ignore'})`,
          "process.stdout.write(String(guardian.pid)+'\\n')",
          "setInterval(() => undefined,1000)",
        ].join(";");
        const parent = spawn(process.execPath, ["-e", parentSource], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        liveChildren.add(parent);
        parent.once("close", () => liveChildren.delete(parent));
        let output = "";
        parent.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        let guardianPid = 0;
        await expect.poll(() => {
          guardianPid = Number(output.trim());
          return Number.isSafeInteger(guardianPid) && guardianPid > 1;
        }, { timeout: 5_000 }).toBe(true);
        await expect.poll(
          () => darwinProcessGuardianReady(guardianPid, guardianPath)?.pid ?? 0,
          { timeout: 5_000 },
        ).toBe(guardianPid);
        if (termination === "guardian") process.kill(guardianPid, "SIGTERM");
        else parent.kill("SIGKILL");
        await expect.poll(
          () => !processIsAlive(guardianPid),
          { timeout: 5_000 },
        ).toBe(true);
        expect(existsSync(payloadPath)).toBe(false);
        if (processIsAlive(parent.pid ?? 0)) parent.kill("SIGKILL");
        await closeOf(parent);
      }
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "macOS retains a claim when exact non-fork cleanup becomes unprovable",
    async () => {
      const directory = temporaryDirectory();
      const guardianPath = join(directory, "runtime-process-guardian-unproved");
      const payloadSourcePath = join(directory, "setsid-payload.c");
      const payloadPath = join(directory, "setsid-payload");
      const payloadPidPath = join(directory, "setsid-payload.pid");
      writeFileSync(payloadSourcePath, [
        "#include <stdio.h>",
        "#include <sys/types.h>",
        "#include <unistd.h>",
        "int main(int argc, char **argv) {",
        "  if (argc != 2) return 64;",
        "  if (setsid() != getpid()) return 65;",
        "  FILE *stream = fopen(argv[1], \"w\");",
        "  if (!stream) return 66;",
        "  fprintf(stream, \"%d\\n\", getpid());",
        "  if (fclose(stream) != 0) return 67;",
        "  for (;;) pause();",
        "}",
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
      const guardianBuilt = spawnSync(
        "/usr/bin/xcrun",
        [
          "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
          "-DINERTIA_RUNTIME_GUARDIAN_TEST_CLEANUP_UNPROVED=1",
          join(process.cwd(), "native/runtime-process-guardian/darwin.c"),
          "-o", guardianPath,
        ],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          shell: false,
          timeout: 30_000,
        },
      );
      expect(
        guardianBuilt.status,
        `${guardianBuilt.stderr}\n${guardianBuilt.stdout}`,
      ).toBe(0);
      const payloadBuilt = spawnSync(
        "/usr/bin/xcrun",
        [
          "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
          payloadSourcePath, "-o", payloadPath,
        ],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          shell: false,
          timeout: 30_000,
        },
      );
      expect(payloadBuilt.status, `${payloadBuilt.stderr}\n${payloadBuilt.stdout}`)
        .toBe(0);
      const deactivate = activateRuntimeOwnedProcessRegistry(
        directory,
        runtimeGenerationId,
        systemBootId,
        { darwinGuardianPath: guardianPath },
      );
      if (deactivate) deactivators.push(deactivate);
      const invocation = runtimeOwnedProcessInvocation(
        payloadPath,
        [payloadPidPath],
      );
      const guardian = spawnRuntimeOwnedProcess(() => spawn(
        invocation.command,
        invocation.args,
        { detached: true, shell: false, stdio: "ignore" },
      ));
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));
      let payloadPid = 0;
      await expect.poll(() => {
        if (existsSync(payloadPidPath)) {
          payloadPid = Number(readFileSync(payloadPidPath, "utf8").trim());
        }
        return Number.isSafeInteger(payloadPid) && payloadPid > 1;
      }, { timeout: 5_000 }).toBe(true);

      guardian.kill("SIGTERM");
      await closeOf(guardian);

      expect(guardian.exitCode).toBeNull();
      expect(guardian.signalCode).toBe("SIGUSR2");
      await expect.poll(() => !processIsAlive(payloadPid), {
        timeout: 5_000,
      }).toBe(true);
      expect(new RuntimeOwnedProcessJournal(directory, {
        platform: "darwin",
        darwinGuardianPath: guardianPath,
      }).records(runtimeGenerationId)).toHaveLength(1);
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "macOS fork-tainted guardian exits while retaining uncertainty leaves",
    async () => {
      const directory = temporaryDirectory();
      const payloadSourcePath = join(directory, "double-fork-payload.c");
      const payloadPath = join(directory, "double-fork-payload");
      const grandchildPidPath = join(directory, "grandchild.pid");
      writeFileSync(payloadSourcePath, [
        "#include <stdio.h>",
        "#include <stdlib.h>",
        "#include <sys/types.h>",
        "#include <unistd.h>",
        "int main(int argc, char **argv) {",
        "  if (argc != 2) return 64;",
        "  const pid_t child = fork();",
        "  if (child < 0) return 71;",
        "  if (child > 0) for (;;) pause();",
        "  if (setsid() != getpid()) _exit(72);",
        "  const pid_t grandchild = fork();",
        "  if (grandchild < 0) _exit(73);",
        "  if (grandchild > 0) _exit(0);",
        "  FILE *stream = fopen(argv[1], \"w\");",
        "  if (!stream) _exit(74);",
        "  fprintf(stream, \"%d\\n\", getpid());",
        "  if (fclose(stream) != 0) _exit(75);",
        "  for (;;) pause();",
        "}",
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
      const built = spawnSync(
        "/usr/bin/xcrun",
        [
          "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
          payloadSourcePath, "-o", payloadPath,
        ],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          shell: false,
          timeout: 30_000,
        },
      );
      expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      activate(directory);
      const invocation = runtimeOwnedProcessInvocation(
        payloadPath,
        [grandchildPidPath],
      );
      const guardian = spawnRuntimeOwnedProcess(() => spawn(
        invocation.command,
        invocation.args,
        { detached: true, shell: false, stdio: "ignore" },
      ));
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));
      const guardianPid = guardian.pid ?? 0;
      expect(guardianPid).toBeGreaterThan(1);
      let grandchildPid = 0;
      await expect.poll(() => {
        if (existsSync(grandchildPidPath)) {
          grandchildPid = Number(readFileSync(grandchildPidPath, "utf8").trim());
        }
        return Number.isSafeInteger(grandchildPid) && grandchildPid > 1;
      }, { timeout: 5_000 }).toBe(true);
      expect(processIsAlive(grandchildPid)).toBe(true);
      expect(processIsAlive(guardianPid)).toBe(true);
      guardian.kill("SIGTERM");
      await expect.poll(
        () => !processIsAlive(guardianPid),
        { timeout: 5_000 },
      ).toBe(true);
      await closeOf(guardian);
      expect(guardian.exitCode).toBeNull();
      expect(guardian.signalCode).toBe("SIGUSR2");
      // The distinct uncertain-containment exit must not let the live parent
      // release the durable evidence merely because the private session is
      // now empty. An unknown detached descendant is not claimed killed.
      const records = new RuntimeOwnedProcessJournal(directory, {
        platform: "darwin",
        darwinGuardianPath: guardianPath,
      }).records(runtimeGenerationId);
      expect(records).toHaveLength(1);
      expect(processIsAlive(grandchildPid)).toBe(true);
      process.kill(grandchildPid, "SIGKILL");
      await expect.poll(() => !processIsAlive(grandchildPid), {
        timeout: 5_000,
      }).toBe(true);
    },
    15_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "win32").each(
    [0, 78],
  )(
    "retires a normally closed real process with exit %i on the host platform",
    async (exitCode) => {
      const directory = temporaryDirectory();
      activate(directory);
      const invocation = runtimeOwnedProcessInvocation(
        process.execPath,
        ["-e", `process.exit(${exitCode})`],
      );
      const child = spawnRuntimeOwnedProcess(() => spawn(
        invocation.command,
        invocation.args,
        {
          detached: process.platform !== "win32",
          shell: false,
          stdio: "ignore",
        },
      ));
      liveChildren.add(child);
      child.once("close", () => liveChildren.delete(child));
      await closeOf(child);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(child.exitCode).toBe(exitCode);
      expect(child.signalCode).toBeNull();
      expect(new RuntimeOwnedProcessJournal(directory)
        .records(runtimeGenerationId)).toEqual([]);
      deactivate();
    },
    10_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "recovers a real owned process on the host platform",
    async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const child = longRunningChild();
      const close = closeOf(child);
      const journal = new RuntimeOwnedProcessJournal(directory);
      expect(journal.records(runtimeGenerationId)).toHaveLength(1);
      deactivate();

      const recovery = recoverRuntimeOwnedProcesses(
        directory,
        runtimeGenerationId,
        systemBootId,
        {
          deadlineAt: Date.now() + 5_000,
          ...(process.platform === "darwin"
            ? {
                darwinGuardianPath: join(
                  process.cwd(),
                  "resources/generated/runtime-process-guardian/runtime-process-guardian",
                ),
              }
            : {}),
        },
      );

      await expect(recovery).resolves.toBe(true);
      await close;
      expect(journal.records(runtimeGenerationId)).toEqual([]);
    },
    10_000,
  );
});
