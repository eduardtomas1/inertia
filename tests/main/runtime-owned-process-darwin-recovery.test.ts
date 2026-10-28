import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recoverRuntimeOwnedProcesses } from "../../src/main/runtime-owned-process-recovery";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";

const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-darwin-recovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

function portableClaim(directory: string, platform: "darwin", pid = 4_242) {
  const journal = new RuntimeOwnedProcessJournal(directory, {
    platform,
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
  });
  expect(journal.startSession(runtimeGenerationId, systemBootId)).toBe(true);
  const ownershipId = journal.begin(
    runtimeGenerationId,
    systemBootId,
    journal.sessionCapability(runtimeGenerationId, systemBootId)!,
  );
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("macOS runtime owned process recovery proof", () => {
  it.each([
    ["retires", { absent: true, remaining: [] }, true],
    ["retains", { absent: null, remaining: [] }, false],
  ] as const)("%s the exact macOS guardian after it exits by its session and escapee proof", async (_label, census, recovered) => {
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
    const readDarwinEscapees = vi.fn(async () => census);

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
        readDarwinEscapees,
      },
    )).resolves.toBe(recovered);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(forceKill).not.toHaveBeenCalled();
    expect(readDarwinEscapees).toHaveBeenCalledWith(claim.process, expect.any(Number));
    expect(journal.records(runtimeGenerationId)).toEqual(recovered ? [] : [claim]);
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

  it("retires a missing macOS guardian claim when its birth session is empty and no marked escapee remains", async () => {
    const directory = temporaryDirectory();
    const { claim, journal } = portableClaim(directory, "darwin");
    const kill = vi.fn<(
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => true>(() => true);
    const readDarwinSessionEmpty = vi.fn(() => true);
    const readDarwinEscapees = vi.fn(async () => ({ absent: true, remaining: [] }));
    const onUnsignalledOrphans = vi.fn();

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
        readDarwinEscapees,
        onUnsignalledOrphans,
      },
    )).resolves.toBe(true);

    expect(kill).not.toHaveBeenCalled();
    expect(readDarwinSessionEmpty).toHaveBeenCalledWith(4_242);
    expect(readDarwinEscapees).toHaveBeenCalledWith(claim.process, expect.any(Number));
    expect(onUnsignalledOrphans).not.toHaveBeenCalled();
    expect(journal.records(runtimeGenerationId)).toEqual([]);
  });

  it("keeps a missing macOS guardian claim when its escapee census is unreadable", async () => {
    const directory = temporaryDirectory();
    const { claim, journal } = portableClaim(directory, "darwin");

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        readIdentity: () => null,
        readDarwinSessionEmpty: () => true,
        readDarwinEscapees: async () => ({ absent: null, remaining: [] }),
      },
    )).resolves.toBe(false);

    expect(journal.records(runtimeGenerationId)).toEqual([claim]);
  });

  it("reports marked macOS escapees it could not stop and keeps their claim", async () => {
    const directory = temporaryDirectory();
    const { claim, journal } = portableClaim(directory, "darwin");
    const remaining = [{ pid: 5_151, startTimeSeconds: "1756100001", startTimeMicroseconds: 7 }];
    const onUnsignalledOrphans = vi.fn();

    await expect(recoverRuntimeOwnedProcesses(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform: "darwin",
        deadlineAt: Date.now() + 2_000,
        readIdentity: () => null,
        readDarwinSessionEmpty: () => true,
        readDarwinEscapees: async () => ({ absent: false, remaining }),
        onUnsignalledOrphans,
      },
    )).resolves.toBe(false);

    expect(onUnsignalledOrphans).toHaveBeenCalledExactlyOnceWith(remaining);
    expect(journal.records(runtimeGenerationId)).toEqual([claim]);
  });

  it("waits for a missing macOS guardian's session to drain before retiring it", async () => {
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
        readDarwinEscapees: async () => ({ absent: true, remaining: [] }),
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

});
