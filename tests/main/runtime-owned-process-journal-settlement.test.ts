import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recoverRuntimeOwnedProcesses } from
  "../../src/main/runtime-owned-process-recovery";
import { windowsRuntimeJobName } from "../../src/main/windows-runtime-job";
import { RuntimeOwnedProcessJournal } from
  "../../src/node/runtime-owned-processes";

const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-journal-settle-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function portableClaim(
  directory: string,
  platform: "darwin" | "win32",
  pid = 4_242,
): RuntimeOwnedProcessJournal {
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
  const capability = journal.sessionCapability(
    runtimeGenerationId,
    systemBootId,
  );
  expect(capability).not.toBeNull();
  const ownershipId = journal.begin(
    runtimeGenerationId,
    systemBootId,
    capability!,
  );
  journal.claim(
    ownershipId,
    runtimeGenerationId,
    systemBootId,
    pid,
    101,
    { spawnedAfterMs: 10_000, spawnedBeforeMs: 10_001 },
  );
  return journal;
}

function rewritePortableClaimAsLinux(
  directory: string,
  journal: RuntimeOwnedProcessJournal,
) {
  const claim = journal.records(runtimeGenerationId)?.[0];
  if (!claim || claim.state === "pending") throw new Error("Missing claim");
  const path = join(
    directory,
    `.runtime-owned-child-${claim.ownershipId}.json`,
  );
  const stored = JSON.parse(readFileSync(path, "utf8")) as {
    process: unknown;
  };
  const identity = {
    pid: 4_242,
    parentPid: 101,
    processGroupId: 4_242,
    startTimeTicks: "123456",
  };
  stored.process = identity;
  writeFileSync(path, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
  return identity;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime-owned journal settlement", () => {
  it("settles a Windows claim read racing child-close retirement", async () => {
    const directory = temporaryDirectory();
    const journal = portableClaim(directory, "win32");
    const containment = {
      kind: "windows-job-v1" as const,
      name: windowsRuntimeJobName(runtimeGenerationId),
    };
    expect(journal.armContainment(
      runtimeGenerationId,
      systemBootId,
      containment,
    )).toBe(true);
    const originalRecords = RuntimeOwnedProcessJournal.prototype.records;
    vi.spyOn(RuntimeOwnedProcessJournal.prototype, "records")
      .mockImplementationOnce(() => null)
      .mockImplementation(function (
        this: RuntimeOwnedProcessJournal,
        generation: string,
      ) {
        return originalRecords.call(this, generation);
      });
    const recoverWindowsJob = vi.fn(async () => true);
    const waitForProcessGroupDrain = vi.fn(async () => undefined);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "win32",
        deadlineAt: Date.now() + 2_000,
        recoverWindowsJob,
        waitForProcessGroupDrain,
      },
    )).resolves.toBe(true);

    expect(recoverWindowsJob).toHaveBeenCalledWith(
      containment,
      expect.any(Number),
    );
    expect(waitForProcessGroupDrain).toHaveBeenCalledWith(10);
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("settles a proved Windows Job when proof lands at the deadline", async () => {
    const directory = temporaryDirectory();
    const journal = portableClaim(directory, "win32");
    const containment = {
      kind: "windows-job-v1" as const,
      name: windowsRuntimeJobName(runtimeGenerationId),
    };
    expect(journal.armContainment(
      runtimeGenerationId,
      systemBootId,
      containment,
    )).toBe(true);
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const recoverWindowsJob = vi.fn(async () => {
      now = 10_010;
      return true;
    });

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "win32",
        deadlineAt: 10_010,
        recoverWindowsJob,
        waitForProcessGroupDrain: async () => undefined,
      },
    )).resolves.toBe(true);

    expect(recoverWindowsJob).toHaveBeenCalledWith(containment, 10_010);
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("settles a platform-general entry read before exact recovery", async () => {
    const directory = temporaryDirectory();
    const journal = portableClaim(directory, "darwin");
    const originalRecords = RuntimeOwnedProcessJournal.prototype.records;
    vi.spyOn(RuntimeOwnedProcessJournal.prototype, "records")
      .mockImplementationOnce(() => null)
      .mockImplementation(function (
        this: RuntimeOwnedProcessJournal,
        generation: string,
      ) {
        return originalRecords.call(this, generation);
      });
    const waitForProcessGroupDrain = vi.fn(async () => undefined);

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      "test:10000000-0000-4000-8000-000000000099",
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        waitForProcessGroupDrain,
      },
    )).resolves.toBe(true);

    expect(waitForProcessGroupDrain).toHaveBeenCalledWith(10);
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("accepts exact claim retirement won by a concurrent writer", async () => {
    const directory = temporaryDirectory();
    const journal = portableClaim(directory, "darwin");
    const originalRelease = RuntimeOwnedProcessJournal.prototype.release;
    vi.spyOn(RuntimeOwnedProcessJournal.prototype, "release")
      .mockImplementationOnce(function (
        this: RuntimeOwnedProcessJournal,
        ownershipId: string,
      ) {
        expect(originalRelease.call(this, ownershipId)).toBe(true);
        return false;
      })
      .mockImplementation(function (
        this: RuntimeOwnedProcessJournal,
        ownershipId: string,
      ) {
        return originalRelease.call(this, ownershipId);
      });

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      "test:10000000-0000-4000-8000-000000000099",
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        waitForProcessGroupDrain: async () => undefined,
      },
    )).resolves.toBe(true);

    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("releases an exactly proved claim when proof lands at the deadline", async () => {
    const directory = temporaryDirectory();
    const journal = portableClaim(directory, "darwin");

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      "test:10000000-0000-4000-8000-000000000099",
      {
        platform: "darwin",
        deadlineAt: Date.now(),
        waitForProcessGroupDrain: async () => undefined,
      },
    )).resolves.toBe(true);

    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("settles an exact claim transition before retrying release", async () => {
    const directory = temporaryDirectory();
    const journal = portableClaim(directory, "darwin");
    const originalRelease = RuntimeOwnedProcessJournal.prototype.release;
    const waitForProcessGroupDrain = vi.fn(async () => undefined);
    vi.spyOn(RuntimeOwnedProcessJournal.prototype, "release")
      .mockImplementationOnce(function (
        this: RuntimeOwnedProcessJournal,
        ownershipId: string,
      ) {
        expect(this.retire(ownershipId)).toBe(true);
        return false;
      })
      .mockImplementation(function (
        this: RuntimeOwnedProcessJournal,
        ownershipId: string,
      ) {
        return originalRelease.call(this, ownershipId);
      });

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      "test:10000000-0000-4000-8000-000000000099",
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        waitForProcessGroupDrain,
      },
    )).resolves.toBe(true);

    expect(waitForProcessGroupDrain).toHaveBeenCalledWith(10);
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("reserves the final non-Windows recovery slice for journal settlement", async () => {
    const directory = temporaryDirectory();
    const journal = portableClaim(directory, "win32");
    const identity = rewritePortableClaimAsLinux(directory, journal);
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const waitForProcessGroupDrain = vi.fn(async (durationMs: number) => {
      now += durationMs;
    });

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "linux",
        darwinGuardianPath: "/trusted/runtime-process-guardian",
        deadlineAt: 10_300,
        readIdentity: () => identity,
        linuxTerminalAuthority: () => true,
        signalLinuxGuardian: () => true,
        waitForProcessGroupDrain,
      },
    )).resolves.toBe(false);

    expect(now).toBe(10_200);
    expect(waitForProcessGroupDrain).toHaveBeenCalledTimes(10);
    expect(journal.records(runtimeGenerationId)).toMatchObject([{
      state: "retiring",
      process: identity,
    }]);
  });
});
