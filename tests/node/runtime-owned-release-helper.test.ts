// @inertia-test-suite portable
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as linux from "../../src/node/runtime-owned-process-linux";
import * as posix from "../../src/node/runtime-owned-process-posix";
import {
  activateRuntimeOwnedProcessRegistry,
  awaitRuntimeOwnedProcessCleanupConfirmed,
  awaitRuntimeOwnedProcessStopped,
  confirmRuntimeOwnedProcessStopped,
  runtimeOwnedProcessCleanupConfirmed,
  runtimeOwnedProcessStopConfirmation,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedProcess,
  type RuntimeOwnedProcessClaim,
} from "../../src/node/runtime-owned-processes";
import { GitScanCoordinator, validatedGitScanIdentity, withGitScanProcessSlot } from "../../src/server/git/scan-coordinator";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inertia-release-helper-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const records = new Map<string, RuntimeOwnedProcessClaim>();
  const monitors = new Map<number, () => void>();
  const helpers: Array<{ signal: AbortSignal; close: (success?: boolean) => void }> = [];
  let liveHelpers = 0;
  let peakHelpers = 0;
  let pid = 42_000;
  // Native admission and journal I/O are boundaries here. The real registry,
  // claim retirement, cleanup APIs and Git process slots retain their ordering.
  vi.spyOn(linux, "linuxGuardianExecutableMatches").mockReturnValue(true);
  vi.spyOn(posix, "exactProcessGroupTerminal").mockReturnValue(true);
  vi.spyOn(linux, "readLinuxGuardianReadyWithRetriesAsync").mockImplementation(async (pid) => ({
    pid, parentPid: process.pid, processGroupId: pid, startTimeTicks: "100",
    guardianExecutableDevice: "1", guardianExecutableInode: "2",
  }));
  vi.spyOn(linux, "signalLinuxGuardianExactAsync").mockImplementation(async (_identity, _path, action, signal) => {
    if (action !== "release") return true;
    liveHelpers += 1;
    peakHelpers = Math.max(peakHelpers, liveHelpers);
    return await new Promise<boolean>((resolve) => {
      let closed = false;
      helpers.push({ signal: signal!, close: (success = !signal!.aborted) => {
        if (closed) return;
        closed = true;
        liveHelpers -= 1;
        resolve(success);
      } });
    });
  });
  vi.spyOn(linux, "monitorLinuxGuardianTerminal").mockImplementation((identity, _path, onTerminal, _onFailure, dependencies) => {
    const controller = new AbortController();
    monitors.set(identity.pid, () => {
      expect(onTerminal(true)).toBe(true);
      void dependencies!.release!(controller.signal);
    });
    return () => controller.abort();
  });
  const journal = RuntimeOwnedProcessJournal.prototype;
  vi.spyOn(journal, "sessionCapability").mockReturnValue({} as never);
  vi.spyOn(journal, "begin").mockImplementation(() => randomUUID());
  vi.spyOn(journal, "claim").mockImplementation((ownershipId, runtimeGenerationId, systemBootId, _pid, _parentPid, options) => {
    const record: RuntimeOwnedProcessClaim = {
      version: 1, state: "preauth", ownershipId, runtimeGenerationId, systemBootId,
      process: options!.expectedLinuxIdentity!,
    };
    records.set(ownershipId, record);
    return record;
  });
  vi.spyOn(journal, "own").mockImplementation((id) => {
    const owned = { ...records.get(id)!, state: "owned" as const };
    records.set(id, owned);
    return owned;
  });
  vi.spyOn(journal, "retire").mockImplementation((id) => {
    records.set(id, { ...records.get(id)!, state: "retiring" });
    return true;
  });
  vi.spyOn(journal, "releaseRetiring").mockImplementation((id) => records.get(id)?.state === "retiring" && records.delete(id));
  vi.spyOn(journal, "records").mockImplementation(() => [...records.values()]);
  const deactivate = activateRuntimeOwnedProcessRegistry(root,
    "65000000-0000-4000-8000-000000000065:1", "test:64000000-0000-4000-8000-000000000064", {
      platform: "linux", darwinGuardianPath: process.execPath,
      linuxGuardianExecutable: { guardianExecutableDevice: "1", guardianExecutableInode: "2" },
    })!;
  cleanups.push(deactivate);
  const terminalGuardian = async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: ++pid, spawnfile: process.execPath, exitCode: null as number | null, signalCode: null,
    }) as ChildProcess;
    spawnRuntimeOwnedProcess(() => child);
    await tick();
    monitors.get(child.pid!)!();
    return child;
  };
  return {
    helpers, records, deactivate, terminalGuardian,
    liveHelpers: () => liveHelpers, peakHelpers: () => peakHelpers,
    closeGuardian: async () => {
      const child = await terminalGuardian();
      Reflect.set(child, "exitCode", 0);
      child.emit("close", 0, null);
      await tick();
      return child;
    },
  };
}

it.each([false, true])("joins the release helper after durable retirement (registry replaced: %s)", async (replaceRegistry) => {
  const app = fixture();
  const child = await app.closeGuardian();
  let childSettled = false;
  let cleanupSettled = false;
  const childCleanup = awaitRuntimeOwnedProcessStopped(child).then((value) => { childSettled = true; return value; });
  const cleanup = awaitRuntimeOwnedProcessCleanupConfirmed().then((value) => { cleanupSettled = true; return value; });
  try {
    await tick();
    expect(app.records.size).toBe(0);
    expect(app.helpers[0]!.signal.aborted).toBe(true);
    expect(confirmRuntimeOwnedProcessStopped(child)).toBe(false);
    expect(runtimeOwnedProcessStopConfirmation(child)).toBe(false);
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(false);
    expect(childSettled).toBe(false);
    expect(cleanupSettled).toBe(false);
    if (replaceRegistry) {
      app.deactivate();
      fixture();
      expect(runtimeOwnedProcessCleanupConfirmed()).toBe(true);
    }
  } finally {
    app.helpers.forEach(({ close }) => close());
  }
  await expect(childCleanup).resolves.toBe(!replaceRegistry);
  await expect(cleanup).resolves.toBe(!replaceRegistry);
  expect(runtimeOwnedProcessCleanupConfirmed()).toBe(true);
});

it("lets a failed release helper retire its claim without awaiting itself", async () => {
  const app = fixture();
  const child = await app.terminalGuardian();
  expect(app.records.size).toBe(1);
  const cleanup = awaitRuntimeOwnedProcessStopped(child);
  app.helpers[0]!.close(false);
  await expect(cleanup).resolves.toBe(true);
  expect(app.records.size).toBe(0);
  expect(app.helpers[0]!.signal.aborted).toBe(true);
  expect(runtimeOwnedProcessCleanupConfirmed()).toBe(true);
});

it("keeps each Git scan slot until its release helper closes", async () => {
  const app = fixture();
  const coordinator = new GitScanCoordinator();
  let started = 0;
  let settled = false;
  const scan = coordinator.request({
    authorityGeneration: "helper-drain", identity: validatedGitScanIdentity("/proof/repo", "marker"),
    invalidation: 0, optionsKey: "helper-drain", scope: "workspace",
  }, async (execution) => await Promise.all(Array.from({ length: 4 }, () => withGitScanProcessSlot(execution, async () => {
    started += 1;
    const child = await app.closeGuardian();
    return await awaitRuntimeOwnedProcessStopped(child);
  })))).then((result) => { settled = true; return result; });
  try {
    for (let turn = 0; turn < 6; turn += 1) await tick();
    expect(started).toBe(3);
    expect(app.liveHelpers()).toBe(3);
    expect(settled).toBe(false);
  } finally {
    for (let turn = 0; turn < 8 && !settled; turn += 1) {
      app.helpers.forEach(({ close }) => close());
      await tick();
    }
  }
  await expect(scan).resolves.toEqual([true, true, true, true]);
  expect(app.peakHelpers()).toBe(3);
  expect(app.liveHelpers()).toBe(0);
});
