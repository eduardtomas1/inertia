import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventEmitter } from "node:events";

import {
  awaitRuntimeOwnedProcessCleanupConfirmed,
  confirmRuntimeOwnedProcessStopped,
  RuntimeOwnedProcessJournal,
  runtimeOwnedProcessCleanupConfirmed,
  runtimeOwnedProcessOwnershipIsTainted,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import { retireFailedRuntimeOwnedSpawn } from "../../src/node/runtime-owned-process-spawn-failure";
import { createOwnedProcessTreeTermination } from "../../src/server/process-lifecycle";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const systemBootId = "test:61000000-0000-4000-8000-000000000061";
const runtimeGenerationId = "62000000-0000-4000-8000-000000000062:1";
const directories: string[] = [];
let deactivate: (() => void) | null = null;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  deactivate?.();
  deactivate = null;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each(["darwin", "linux", "win32"] as const)("%s runtime process ownership", (platform) => {
  it.skipIf(platform === "linux" && process.platform !== "linux")(
    "retires a failed spawn without tainting runtime process ownership",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "inertia-owned-spawn-failure-"));
      directories.push(directory);
      const onTainted = vi.fn();
      deactivate = activatePreparedRuntimeOwnedProcessRegistry(
        directory,
        runtimeGenerationId,
        systemBootId,
        {
          platform,
          ...(platform === "win32" ? {} : { darwinGuardianPath: process.execPath }),
          onTainted,
        },
      );
      const child: ChildProcess = spawnRuntimeOwnedProcess(() => spawn(
        process.execPath,
        ["-e", ""],
        {
          cwd: join(directory, "deleted-worktree"),
          detached: platform !== "win32",
          shell: false,
          stdio: "pipe",
        },
      ));
      expect(child.pid).toBeUndefined();
      const terminate = createOwnedProcessTreeTermination(child, "Owned process tree");
      const failed = new Promise<{ code: string | undefined; stopped: Promise<void> }>((resolve) => {
        child.once("error", (error: NodeJS.ErrnoException) => {
          resolve({ code: error.code, stopped: terminate(false) });
        });
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

      const { code, stopped } = await failed;
      expect(code).toBe("ENOENT");
      await expect(stopped).resolves.toBeUndefined();
      await closed;

      expect(confirmRuntimeOwnedProcessStopped(child)).toBe(true);
      await expect(awaitRuntimeOwnedProcessCleanupConfirmed()).resolves.toBe(true);
      expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
      expect(onTainted).not.toHaveBeenCalled();
    },
  );
});

describe.each(["darwin", "win32"] as const)("%s spawn-intent retirement retries", (platform) => {
  const activate = () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-owned-spawn-retry-"));
    directories.push(directory);
    deactivate = activatePreparedRuntimeOwnedProcessRegistry(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform,
        ...(platform === "win32" ? {} : { darwinGuardianPath: process.execPath }),
      },
    );
    return directory;
  };
  const failedSpawn = (directory: string): { child: ChildProcess; closed: Promise<void> } => {
    const child = spawnRuntimeOwnedProcess(() => spawn(
      process.execPath,
      ["-e", ""],
      { cwd: join(directory, "deleted-worktree"), detached: platform !== "win32", shell: false, stdio: "pipe" },
    ));
    child.once("error", () => undefined);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    return { child, closed };
  };
  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  it("retires the intent on a spaced retry after a transient release failure", async () => {
    const directory = activate();
    fakeClock();
    const release = vi.spyOn(RuntimeOwnedProcessJournal.prototype, "release")
      .mockImplementationOnce(() => { throw new Error("EBUSY: locked by another process"); });
    const { child, closed } = failedSpawn(directory);
    await closed;
    expect(confirmRuntimeOwnedProcessStopped(child)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(confirmRuntimeOwnedProcessStopped(child)).toBe(true);
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires the intent from the confirmation path after a release that returned false", async () => {
    const directory = activate();
    fakeClock();
    const release = vi.spyOn(RuntimeOwnedProcessJournal.prototype, "release")
      .mockImplementationOnce(() => false);
    const { child, closed } = failedSpawn(directory);
    await closed;
    await vi.advanceTimersByTimeAsync(60);
    expect(confirmRuntimeOwnedProcessStopped(child)).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays unconfirmed after a bounded number of attempts when the journal never becomes writable", async () => {
    const directory = activate();
    fakeClock();
    const release = vi.spyOn(RuntimeOwnedProcessJournal.prototype, "release")
      .mockImplementation(() => { throw new Error("EACCES: C:\\Users\\someone\\AppData"); });
    const { child, closed } = failedSpawn(directory);
    await closed;
    await vi.advanceTimersByTimeAsync(5_000);
    for (let call = 0; call < 10; call += 1) {
      expect(confirmRuntimeOwnedProcessStopped(child)).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(false);
    expect(release).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats an intent that a concurrent recovery pass already consumed as retired", async () => {
    const directory = activate();
    fakeClock();
    vi.spyOn(RuntimeOwnedProcessJournal.prototype, "release")
      .mockImplementationOnce(() => { throw new Error("EBUSY"); });
    const { child, closed } = failedSpawn(directory);
    await closed;
    const journal = new RuntimeOwnedProcessJournal(directory, { platform });
    const [pending] = journal.records(runtimeGenerationId) ?? [];
    expect(pending?.state).toBe("pending");
    expect(journal.release(pending!.ownershipId)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(confirmRuntimeOwnedProcessStopped(child)).toBe(true);
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(true);
  });

  it("retires an intent whose spawn threw synchronously after a transient release failure", async () => {
    activate();
    fakeClock();
    const release = vi.spyOn(RuntimeOwnedProcessJournal.prototype, "release")
      .mockImplementationOnce(() => { throw new Error("EBUSY"); });
    expect(() => spawnRuntimeOwnedProcess(() => {
      throw new Error("The command could not be spawned.");
    })).toThrow("The command could not be spawned.");
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });
});

it("never retires the intent of a child whose spawn produced a PID", () => {
  const release = vi.fn(() => true);
  const registry = {
    claims: new WeakMap(),
    journal: { release, claimPresent: () => true },
    pendingIntentRetirements: new Set(),
  };
  const claim = { ownershipId: "63000000-0000-4000-8000-000000000063", released: false };
  const child = Object.assign(new EventEmitter(), { pid: 4_242 });
  retireFailedRuntimeOwnedSpawn(registry as never, claim as never, child as never);
  child.emit("error", new Error("kill failed"));
  child.emit("close", 0);
  expect(release).not.toHaveBeenCalled();
  expect(claim.released).toBe(false);
  expect(registry.pendingIntentRetirements.size).toBe(0);
});
