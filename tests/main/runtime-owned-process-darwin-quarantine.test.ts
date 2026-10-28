import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeOwnedProcessJournal,
  runtimeOwnedProcessCleanupConfirmed,
  spawnRuntimeOwnedPidProcess,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import type { DarwinGuardianEscapeeCensus } from "../../src/node/runtime-owned-process-darwin-orphans";
import type {
  RuntimeOwnedProcessDiagnostic,
  RuntimeOwnedProcessFault,
} from "../../src/node/runtime-owned-process-diagnostic";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";

const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const guardianPath = "/trusted/runtime-process-guardian";
const identity = {
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

interface Evidence {
  readonly sessionEmpty: boolean | null;
  readonly escapees: DarwinGuardianEscapeeCensus;
}

const gone: Evidence = { sessionEmpty: true, escapees: { absent: true, remaining: [] } };

function activate(evidence: Evidence) {
  const directory = mkdtempSync(join(tmpdir(), "inertia-darwin-quarantine-"));
  directories.push(directory);
  const taints: RuntimeOwnedProcessDiagnostic[] = [];
  const faults: RuntimeOwnedProcessFault[] = [];
  const readDarwinSessionEmptyAsync = vi.fn(async () => evidence.sessionEmpty);
  const readDarwinEscapeesAsync = vi.fn(async () => evidence.escapees);
  const deactivate = activatePreparedRuntimeOwnedProcessRegistry(directory, runtimeGenerationId, systemBootId, {
    platform: "darwin",
    darwinGuardianPath: guardianPath,
    readDarwinIdentity: () => identity,
    readDarwinGuardianReadyAsync: async () => identity,
    readDarwinIdentityAsync: async () => identity,
    readDarwinSessionEmptyAsync,
    readDarwinEscapeesAsync,
    onTainted: (diagnostic) => { taints.push(diagnostic); },
    onProcessFault: (fault) => { faults.push(fault); },
  });
  if (deactivate) deactivators.push(deactivate);
  const records = () => new RuntimeOwnedProcessJournal(directory).records(runtimeGenerationId);
  return { taints, faults, records, readDarwinSessionEmptyAsync, readDarwinEscapeesAsync };
}

function fakeGuardian(closeSignal: NodeJS.Signals = "SIGUSR2") {
  const guardian = Object.assign(new EventEmitter(), {
    pid: identity.pid,
    spawnfile: guardianPath,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdio: [null, null, null, null, null],
    kill: vi.fn(() => {
      setTimeout(() => {
        guardian.signalCode = closeSignal;
        guardian.emit("close", null, closeSignal);
      }, 5);
      return true;
    }),
  });
  return guardian;
}

async function admittedGuardian() {
  const guardian = fakeGuardian();
  const child = guardian as unknown as ChildProcess;
  const authorized = new Promise<void>((resolve) => {
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGUSR1") resolve();
      return true;
    });
  });
  spawnRuntimeOwnedProcess(() => child);
  await authorized;
  return { guardian, child };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (deactivators.length > 0) deactivators.pop()?.();
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("macOS per-process quarantine", () => {
  it("quarantines one macOS guardian closed by SIGUSR2 without tainting the registry", async () => {
    const evidence = activate({ sessionEmpty: false, escapees: { absent: null, remaining: [] } });
    const { child } = await admittedGuardian();

    await expect(terminateProcessTreeAndWait(child, true, { platform: "darwin" })).resolves.toBe(false);
    await expect.poll(() => evidence.faults, { timeout: 5_000 }).toEqual([{
      kind: "quarantined",
      diagnostic: { stage: "darwin-guardian-close", signal: "SIGUSR2" },
    }]);
    expect(evidence.taints).toEqual([]);
    expect(evidence.records()).toMatchObject([{ state: "owned" }]);
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(false);

    const next = fakeGuardian();
    expect(() => spawnRuntimeOwnedProcess(() => next as unknown as ChildProcess)).not.toThrow();
  }, 10_000);

  it("retires a quarantined macOS claim once its session is empty and no marked escapee remains", async () => {
    const evidence = activate(gone);
    const { child } = await admittedGuardian();

    await expect(terminateProcessTreeAndWait(child, true, { platform: "darwin" })).resolves.toBe(true);
    expect(evidence.readDarwinSessionEmptyAsync).toHaveBeenCalledWith(identity.pid, expect.any(AbortSignal));
    expect(evidence.readDarwinEscapeesAsync).toHaveBeenCalledWith(identity, expect.objectContaining({ reap: true }));
    expect(evidence.records()).toEqual([]);
    expect(evidence.taints).toEqual([]);
    expect(evidence.faults).toEqual([]);
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(true);
  });

  it.each([
    ["the session stays occupied", { sessionEmpty: false, escapees: { absent: true, remaining: [] } }],
    ["a marked escapee survives", {
      sessionEmpty: true,
      escapees: { absent: false, remaining: [{ pid: 5_000, startTimeSeconds: "1756100001", startTimeMicroseconds: 1 }] },
    }],
    ["the escapee census is unknown", { sessionEmpty: true, escapees: { absent: null, remaining: [] } }],
  ] as const)("keeps a quarantined macOS claim when %s", async (_label, state) => {
    const evidence = activate(state);
    const { child } = await admittedGuardian();

    await terminateProcessTreeAndWait(child, true, { platform: "darwin" });
    await expect.poll(() => evidence.faults.length, { timeout: 5_000 }).toBe(1);
    expect(evidence.faults[0]?.kind).toBe("quarantined");
    expect(evidence.taints).toEqual([]);
    expect(evidence.records()).toMatchObject([{ state: "owned" }]);
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(false);
  }, 10_000);

  it.skipIf(process.platform === "win32").each([
    ["retires", gone, true],
    ["keeps", { sessionEmpty: false, escapees: { absent: true, remaining: [] } }, false],
  ] as const)("%s a macOS PTY guardian closed by a signal on its own proof", async (_label, state, retired) => {
    const evidence = activate(state);
    vi.spyOn(process, "kill").mockReturnValue(true);
    const owned = spawnRuntimeOwnedPidProcess(() => ({ pid: identity.pid }), { darwinGuardianCommand: guardianPath });
    expect(owned.requestGuardianStop()).toBe(true);
    await expect(owned.waitForGuardianStop()).resolves.toBe(true);

    owned.releaseIfGroupExited(constants.signals.SIGUSR2);
    if (retired) {
      await expect.poll(() => owned.confirmStopped()).toBe(true);
      expect(evidence.records()).toEqual([]);
      expect(evidence.faults).toEqual([]);
    } else {
      await expect.poll(() => evidence.faults, { timeout: 5_000 }).toEqual([{
        kind: "quarantined",
        diagnostic: { stage: "darwin-pid-close", signal: "SIGUSR2" },
      }]);
      expect(owned.confirmStopped()).toBe(false);
      expect(evidence.records()).toMatchObject([{ state: "owned" }]);
    }
    expect(evidence.taints).toEqual([]);
  }, 10_000);
});
