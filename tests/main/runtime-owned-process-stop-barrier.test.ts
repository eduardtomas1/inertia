import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestRuntimeOwnedGuardianStop,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedPidProcess,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry as activateRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";

const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const guardianPath = "/trusted/runtime-process-guardian";
const expectedIdentity = {
  platform: "darwin" as const,
  pid: 4_242,
  parentPid: process.pid,
  processGroupId: 4_242,
  sessionId: 4_242,
  startTimeSeconds: "1756100000",
  startTimeMicroseconds: 123_456,
};
const directories: string[] = [];
const deactivators: Array<() => void> = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-stop-barrier-"));
  directories.push(directory);
  return directory;
}

function fakeGuardian(closeSignal: NodeJS.Signals | null, stopResult: boolean) {
  const guardian = Object.assign(new EventEmitter(), {
    pid: 4_242,
    spawnfile: guardianPath,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdio: [null, null, null, null, null],
    kill: vi.fn(() => {
      setTimeout(() => {
        guardian.exitCode = closeSignal ? null : 0;
        guardian.signalCode = closeSignal;
        guardian.emit("close", guardian.exitCode, closeSignal);
      }, 5);
      return stopResult;
    }),
  });
  return guardian;
}

function activate(
  directory: string,
  ready: Promise<typeof expectedIdentity>,
  readDarwinIdentityAsync: () => Promise<typeof expectedIdentity> =
    async () => expectedIdentity,
  readDarwinIdentity: () => typeof expectedIdentity | null =
    () => expectedIdentity,
): void {
  const deactivate = activateRuntimeOwnedProcessRegistry(
    directory,
    runtimeGenerationId,
    systemBootId,
    {
      platform: "darwin",
      darwinGuardianPath: guardianPath,
      readDarwinIdentity,
      readDarwinGuardianReadyAsync: async () => await ready,
      readDarwinIdentityAsync,
    },
  );
  if (deactivate) deactivators.push(deactivate);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (deactivators.length > 0) deactivators.pop()?.();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("runtime-owned guardian stop barrier", () => {
  it("starts the child-close budget only after pending admission settles", async () => {
    const directory = temporaryDirectory();
    let resolveReady!: (identity: typeof expectedIdentity) => void;
    const ready = new Promise<typeof expectedIdentity>((resolve) => { resolveReady = resolve; });
    const readDarwinIdentityAsync = vi.fn(
      () => new Promise<typeof expectedIdentity>(() => undefined),
    );
    activate(directory, ready, readDarwinIdentityAsync);
    const guardian = fakeGuardian(null, true);
    const child = guardian as unknown as ChildProcess;
    spawnRuntimeOwnedProcess(() => child);

    const termination = terminateProcessTreeAndWait(child, true, {
      platform: "darwin",
      waitMs: 10,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(guardian.kill).not.toHaveBeenCalled();
    resolveReady(expectedIdentity);

    await expect(termination).resolves.toBe(true);
    expect(guardian.kill).toHaveBeenCalledWith("SIGTERM");
    expect(readDarwinIdentityAsync).not.toHaveBeenCalled();
    expect(new RuntimeOwnedProcessJournal(directory)
      .records(runtimeGenerationId)).toEqual([]);
  });

  it("does not signal a recycled guardian when stopped before readiness settles", async () => {
    const directory = temporaryDirectory();
    let resolveReady!: (identity: typeof expectedIdentity) => void;
    const ready = new Promise<typeof expectedIdentity>((resolve) => {
      resolveReady = resolve;
    });
    const changedIdentity = {
      ...expectedIdentity,
      startTimeMicroseconds: expectedIdentity.startTimeMicroseconds + 1,
    };
    activate(
      directory,
      ready,
      async () => changedIdentity,
      () => changedIdentity,
    );
    const guardian = fakeGuardian(null, true);
    const child = guardian as unknown as ChildProcess;
    spawnRuntimeOwnedProcess(() => child);

    const stop = requestRuntimeOwnedGuardianStop(child);
    expect(stop).not.toBeNull();
    resolveReady(expectedIdentity);

    await expect(stop).resolves.toBe(false);
    expect(guardian.kill).not.toHaveBeenCalled();
  });

  it("cancels a pending authorization census when an admitted PTY guardian is stopped", async () => {
    const directory = temporaryDirectory();
    const readDarwinIdentityAsync = vi.fn(
      () => new Promise<typeof expectedIdentity>(() => undefined),
    );
    activate(directory, Promise.resolve(expectedIdentity), readDarwinIdentityAsync);
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const owned = spawnRuntimeOwnedPidProcess(
      () => ({ pid: expectedIdentity.pid }),
      { darwinGuardianCommand: guardianPath },
    );
    await vi.waitFor(() => expect(readDarwinIdentityAsync).toHaveBeenCalledOnce());

    expect(owned.requestGuardianStop()).toBe(true);
    await expect(owned.waitForGuardianStop()).resolves.toBe(true);
    expect(processKill).toHaveBeenCalledWith(expectedIdentity.pid, "SIGTERM");
    expect(processKill).not.toHaveBeenCalledWith(expectedIdentity.pid, "SIGUSR1");

    owned.releaseIfGroupExited(0);
    await expect.poll(() => owned.confirmStopped()).toBe(true);
    expect(new RuntimeOwnedProcessJournal(directory)
      .records(runtimeGenerationId)).toEqual([]);
  });

  it("does not signal a recycled guardian while cancelling authorization", async () => {
    const directory = temporaryDirectory();
    const changedIdentity = {
      ...expectedIdentity,
      startTimeMicroseconds: expectedIdentity.startTimeMicroseconds + 1,
    };
    const readDarwinIdentityAsync = vi.fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue(changedIdentity);
    let currentIdentity: typeof expectedIdentity | null = expectedIdentity;
    activate(
      directory,
      Promise.resolve(expectedIdentity),
      readDarwinIdentityAsync,
      () => currentIdentity,
    );
    const guardian = fakeGuardian(null, true);
    const child = guardian as unknown as ChildProcess;
    spawnRuntimeOwnedProcess(() => child);
    await vi.waitFor(() => expect(readDarwinIdentityAsync).toHaveBeenCalledOnce());

    currentIdentity = changedIdentity;
    const stop = requestRuntimeOwnedGuardianStop(child);

    await expect(stop).resolves.toBe(false);
    expect(guardian.kill).not.toHaveBeenCalled();
  });

  it("rechecks cancellation at the final guardian authorization boundary", async () => {
    const directory = temporaryDirectory();
    let resolveAuthorization!: (identity: typeof expectedIdentity) => void;
    const authorization = new Promise<typeof expectedIdentity>((resolve) => {
      resolveAuthorization = resolve;
    });
    activate(directory, Promise.resolve(expectedIdentity), async () => await authorization);
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const identityMatches = RuntimeOwnedProcessJournal.identityMatches;
    let owned!: ReturnType<typeof spawnRuntimeOwnedPidProcess>;
    vi.spyOn(RuntimeOwnedProcessJournal, "identityMatches").mockImplementation((...args) => {
      const matches = identityMatches(...args);
      owned.requestGuardianStop();
      return matches;
    });
    owned = spawnRuntimeOwnedPidProcess(
      () => ({ pid: expectedIdentity.pid }),
      { darwinGuardianCommand: guardianPath },
    );

    resolveAuthorization(expectedIdentity);
    await expect(owned.waitForGuardianStop()).resolves.toBe(true);
    expect(processKill).toHaveBeenCalledWith(expectedIdentity.pid, "SIGTERM");
    expect(processKill).not.toHaveBeenCalledWith(expectedIdentity.pid, "SIGUSR1");

    owned.releaseIfGroupExited(0);
    await expect.poll(() => owned.confirmStopped()).toBe(true);
  });

  it("does not signal a recycled guardian at the final authorization boundary", async () => {
    const directory = temporaryDirectory();
    const changedIdentity = {
      ...expectedIdentity,
      startTimeMicroseconds: expectedIdentity.startTimeMicroseconds + 1,
    };
    let currentIdentity: typeof expectedIdentity | null = expectedIdentity;
    const readDarwinIdentityAsync = vi.fn()
      .mockResolvedValueOnce(expectedIdentity)
      .mockResolvedValue(changedIdentity);
    activate(
      directory,
      Promise.resolve(expectedIdentity),
      readDarwinIdentityAsync,
      () => currentIdentity,
    );
    const guardian = fakeGuardian(null, true);
    const child = guardian as unknown as ChildProcess;
    const identityMatches = RuntimeOwnedProcessJournal.identityMatches;
    let stop: Promise<boolean> | null = null;
    vi.spyOn(RuntimeOwnedProcessJournal, "identityMatches").mockImplementation((...args) => {
      const matches = identityMatches(...args);
      currentIdentity = changedIdentity;
      stop = requestRuntimeOwnedGuardianStop(child);
      return matches;
    });
    spawnRuntimeOwnedProcess(() => child);

    await vi.waitFor(() => expect(stop).not.toBeNull());
    await expect(stop).resolves.toBe(false);
    expect(guardian.kill).not.toHaveBeenCalled();
  });

  it("does not authorize or hard-stop a recycled guardian after async census", async () => {
    const directory = temporaryDirectory();
    const changedIdentity = {
      ...expectedIdentity,
      startTimeMicroseconds: expectedIdentity.startTimeMicroseconds + 1,
    };
    const readDarwinIdentity = vi.fn(() => changedIdentity);
    activate(
      directory,
      Promise.resolve(expectedIdentity),
      async () => expectedIdentity,
      readDarwinIdentity,
    );
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const guardian = fakeGuardian(null, true);
    const child = guardian as unknown as ChildProcess;

    spawnRuntimeOwnedProcess(() => child);

    await vi.waitFor(() => expect(readDarwinIdentity).toHaveBeenCalledTimes(2));
    expect(processKill).not.toHaveBeenCalledWith(4_242, "SIGUSR1");
    expect(guardian.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(new RuntimeOwnedProcessJournal(directory)
      .records(runtimeGenerationId)).toMatchObject([{ state: "owned" }]);
  });

  it("consumes a stop requested during the post-authorization admission window", async () => {
    const directory = temporaryDirectory();
    activate(directory, Promise.resolve(expectedIdentity));
    let owned!: ReturnType<typeof spawnRuntimeOwnedPidProcess>;
    const processKill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGUSR1") {
        owned.requestGuardianStop();
        owned.requestGuardianStop();
      }
      return true;
    });
    owned = spawnRuntimeOwnedPidProcess(
      () => ({ pid: expectedIdentity.pid }),
      { darwinGuardianCommand: guardianPath },
    );

    await expect(owned.waitForGuardianStop()).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(processKill).toHaveBeenCalledWith(expectedIdentity.pid, "SIGUSR1");
      expect(processKill).toHaveBeenCalledWith(expectedIdentity.pid, "SIGTERM");
      expect(processKill.mock.calls.filter(([, signal]) => signal === "SIGTERM"))
        .toHaveLength(1);
    });

    owned.releaseIfGroupExited(0);
    await expect.poll(() => owned.confirmStopped()).toBe(true);
    expect(new RuntimeOwnedProcessJournal(directory)
      .records(runtimeGenerationId)).toEqual([]);
  });

  it("consumes the generic child stop requested during post-authorization admission", async () => {
    const directory = temporaryDirectory();
    activate(directory, Promise.resolve(expectedIdentity));
    const guardian = fakeGuardian(null, true);
    const child = guardian as unknown as ChildProcess;
    let stopBarrier: Promise<boolean> | null = null;
    let repeatedStopBarrier: Promise<boolean> | null = null;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGUSR1") {
        stopBarrier = requestRuntimeOwnedGuardianStop(child);
        repeatedStopBarrier = requestRuntimeOwnedGuardianStop(child);
      }
      return true;
    });
    spawnRuntimeOwnedProcess(() => child);

    await vi.waitFor(() => expect(stopBarrier).not.toBeNull());
    await expect(stopBarrier).resolves.toBe(true);
    expect(repeatedStopBarrier).toBe(stopBarrier);
    expect(guardian.kill).toHaveBeenCalledWith("SIGTERM");
    expect(guardian.kill).toHaveBeenCalledTimes(1);
    await expect.poll(() => new RuntimeOwnedProcessJournal(directory)
      .records(runtimeGenerationId)).toEqual([]);
  });

  it("refuses a post-admission stop after the guardian birth identity changes", async () => {
    const directory = temporaryDirectory();
    let currentIdentity: typeof expectedIdentity | null = expectedIdentity;
    activate(
      directory,
      Promise.resolve(expectedIdentity),
      async () => expectedIdentity,
      () => currentIdentity,
    );
    const guardian = fakeGuardian(null, true);
    const child = guardian as unknown as ChildProcess;
    let stopBarrier: Promise<boolean> | null = null;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGUSR1") {
        currentIdentity = {
          ...expectedIdentity,
          startTimeMicroseconds: expectedIdentity.startTimeMicroseconds + 1,
        };
        stopBarrier = requestRuntimeOwnedGuardianStop(child);
      }
      return true;
    });
    spawnRuntimeOwnedProcess(() => child);

    await vi.waitFor(() => expect(stopBarrier).not.toBeNull());
    await expect(stopBarrier).resolves.toBe(false);
    expect(guardian.kill).not.toHaveBeenCalled();
  });

  it("retries one transient exact-identity helper failure before stopping", async () => {
    const directory = temporaryDirectory();
    const transient = Object.assign(new Error("identity helper timed out"), {
      code: "ETIMEDOUT",
    });
    let stopping = false;
    let stopAttempt = 0;
    const readDarwinIdentity = vi.fn(() => {
      if (!stopping) return expectedIdentity;
      if (stopAttempt++ === 0) throw transient;
      return expectedIdentity;
    });
    activate(
      directory,
      Promise.resolve(expectedIdentity),
      async () => expectedIdentity,
      readDarwinIdentity,
    );
    const guardian = fakeGuardian(null, true);
    const child = guardian as unknown as ChildProcess;
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    spawnRuntimeOwnedProcess(() => child);
    await vi.waitFor(() => {
      expect(processKill).toHaveBeenCalledWith(4_242, "SIGUSR1");
    });
    stopping = true;
    readDarwinIdentity.mockClear();

    const stop = requestRuntimeOwnedGuardianStop(child);

    await expect(stop).resolves.toBe(true);
    expect(readDarwinIdentity).toHaveBeenCalledTimes(2);
    expect(guardian.kill).toHaveBeenCalledOnce();
    expect(guardian.kill).toHaveBeenCalledWith("SIGTERM");
    await expect.poll(() => new RuntimeOwnedProcessJournal(directory)
      .records(runtimeGenerationId)).toEqual([]);
  });

  it("retains ownership when the exact-identity retry is exhausted", async () => {
    const directory = temporaryDirectory();
    let stopping = false;
    const readDarwinIdentity = vi.fn(() => {
      if (!stopping) return expectedIdentity;
      throw new Error("identity helper unavailable");
    });
    activate(
      directory,
      Promise.resolve(expectedIdentity),
      async () => expectedIdentity,
      readDarwinIdentity,
    );
    const guardian = fakeGuardian(null, true);
    const child = guardian as unknown as ChildProcess;
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    spawnRuntimeOwnedProcess(() => child);
    await vi.waitFor(() => {
      expect(processKill).toHaveBeenCalledWith(4_242, "SIGUSR1");
    });
    stopping = true;
    readDarwinIdentity.mockClear();

    const stop = requestRuntimeOwnedGuardianStop(child);

    await expect(stop).resolves.toBe(false);
    expect(readDarwinIdentity).toHaveBeenCalledTimes(2);
    expect(guardian.kill).not.toHaveBeenCalled();
    expect(new RuntimeOwnedProcessJournal(directory)
      .records(runtimeGenerationId)).toMatchObject([{ state: "owned" }]);
  });

  it("does not retry or signal a readable recycled guardian identity", async () => {
    const directory = temporaryDirectory();
    const changedIdentity = {
      ...expectedIdentity,
      startTimeMicroseconds: expectedIdentity.startTimeMicroseconds + 1,
    };
    let stopping = false;
    const readDarwinIdentity = vi.fn(() =>
      stopping ? changedIdentity : expectedIdentity);
    activate(
      directory,
      Promise.resolve(expectedIdentity),
      async () => expectedIdentity,
      readDarwinIdentity,
    );
    const guardian = fakeGuardian(null, true);
    const child = guardian as unknown as ChildProcess;
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    spawnRuntimeOwnedProcess(() => child);
    await vi.waitFor(() => {
      expect(processKill).toHaveBeenCalledWith(4_242, "SIGUSR1");
    });
    stopping = true;
    readDarwinIdentity.mockClear();

    const stop = requestRuntimeOwnedGuardianStop(child);

    await expect(stop).resolves.toBe(false);
    expect(readDarwinIdentity).toHaveBeenCalledOnce();
    expect(guardian.kill).not.toHaveBeenCalled();
  });

  it.each([
    { closeSignal: null, expected: true },
    { closeSignal: "SIGUSR2" as NodeJS.Signals, expected: false },
  ])("requires durable retirement after a false stop barrier ($closeSignal)", async ({
    closeSignal,
    expected,
  }) => {
    const directory = temporaryDirectory();
    activate(directory, Promise.resolve(expectedIdentity));
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const guardian = fakeGuardian(closeSignal, false);
    const child = guardian as unknown as ChildProcess;
    spawnRuntimeOwnedProcess(() => child);
    await vi.waitFor(() => {
      expect(processKill).toHaveBeenCalledWith(4_242, "SIGUSR1");
      expect(new RuntimeOwnedProcessJournal(directory)
        .records(runtimeGenerationId)).toMatchObject([{ state: "owned" }]);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(terminateProcessTreeAndWait(child, true, {
      platform: "darwin",
      waitMs: 10,
    })).resolves.toBe(expected);
    expect(guardian.kill).toHaveBeenCalledWith("SIGTERM");
    const records = new RuntimeOwnedProcessJournal(directory)
      .records(runtimeGenerationId);
    if (expected) expect(records).toEqual([]);
    else expect(records).toHaveLength(1);
  });
});
