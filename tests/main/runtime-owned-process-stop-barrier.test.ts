import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateRuntimeOwnedProcessRegistry,
  RuntimeOwnedProcessJournal,
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
): void {
  const deactivate = activateRuntimeOwnedProcessRegistry(
    directory,
    runtimeGenerationId,
    systemBootId,
    {
      platform: "darwin",
      darwinGuardianPath: guardianPath,
      readDarwinGuardianReadyAsync: async () => await ready,
      readDarwinIdentityAsync: async () => expectedIdentity,
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
    activate(directory, ready);
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
    expect(new RuntimeOwnedProcessJournal(directory)
      .records(runtimeGenerationId)).toEqual([]);
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
