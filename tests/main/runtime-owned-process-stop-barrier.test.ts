import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateRuntimeOwnedProcessRegistry,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedPidProcess,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
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
): void {
  const deactivate = activateRuntimeOwnedProcessRegistry(
    directory,
    runtimeGenerationId,
    systemBootId,
    {
      platform: "darwin",
      darwinGuardianPath: guardianPath,
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
