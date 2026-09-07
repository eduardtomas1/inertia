import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
  prepare: vi.fn<(environment: NodeJS.ProcessEnv, locate: () => Promise<string>) => Promise<void>>(),
  spawn: vi.fn(),
  terminate: vi.fn<(child: ChildProcess, force?: boolean) => Promise<boolean>>(),
}));
vi.mock("../../src/server/git/executable", () => ({
  GitExecutableSelection: class {
    prepare = controls.prepare;
    command() { return "git"; }
  },
}));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: controls.spawn,
}));
vi.mock("../../src/node/runtime-owned-processes", async original => {
  const actual = await original<typeof import("../../src/node/runtime-owned-processes")>();
  return { ...actual,
    runtimeOwnedProcessInvocation: vi.fn(actual.runtimeOwnedProcessInvocation),
    spawnRuntimeOwnedProcess: vi.fn(actual.spawnRuntimeOwnedProcess),
  };
});
vi.mock("../../src/server/process-lifecycle", async original => ({
  ...await original<typeof import("../../src/server/process-lifecycle")>(),
  terminateProcessTreeAndWait: controls.terminate,
}));
import { prepareGitExecutable, runGit } from "../../src/server/git/runner";
import { GitError, GIT_PROCESS_TREE_TERMINATION_FAILURE } from "../../src/server/git/types";
import { runtimeOwnedProcessInvocation, spawnRuntimeOwnedProcess } from "../../src/node/runtime-owned-processes";

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Git executable startup preparation", () => {
  it("does not make unavailable Git fatal to runtime startup", async () => {
    controls.prepare.mockRejectedValueOnce(new GitError("git-unavailable", "Git unavailable."));
    await expect(prepareGitExecutable()).resolves.toBeUndefined();
    expect(controls.spawn).not.toHaveBeenCalled();
  });

  it("propagates unconfirmed helper cleanup through startup", async () => {
    const error = new GitError("operation-failed", GIT_PROCESS_TREE_TERMINATION_FAILURE);
    controls.prepare.mockRejectedValueOnce(error);
    await expect(prepareGitExecutable()).rejects.toBe(error);
  });

  it("uses the owned shell-free runner and sanitized Git environment for xcrun", async () => {
    vi.stubEnv("DEVELOPER_DIR", "/private-untrusted-override");
    controls.prepare.mockImplementationOnce(async (_environment, locate) => { await locate(); });
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 424242, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough() });
    controls.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout!.emit("data", Buffer.from("/Applications/Selected Xcode.app/Contents/Developer/usr/bin/git\n"));
        child.emit("close", 0, null);
      });
      return child;
    });
    await prepareGitExecutable({ PATH: "/usr/bin:/bin", DEVELOPER_DIR: "/also-not-forwarded" });
    expect(runtimeOwnedProcessInvocation).toHaveBeenCalledWith("/usr/bin/xcrun", ["--find", "git"]);
    expect(spawnRuntimeOwnedProcess).toHaveBeenCalledOnce();
    expect(controls.spawn).toHaveBeenCalledWith("/usr/bin/xcrun", ["--find", "git"], expect.objectContaining({
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: expect.objectContaining({ PATH: "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0" }),
    }));
    expect(controls.spawn.mock.calls[0]![2].env).not.toHaveProperty("DEVELOPER_DIR");
  });
});


const coldLookupScenario = {
  deadlineMs: 10_000,
  outputAtMs: 6_000,
  closeAtMs: 6_500,
};
const ordinaryInspectionDeadlineMs = 3_000;
const closeDrainMs = 250;
const selectedAppleGit = "/Applications/Selected Xcode.app/Contents/Developer/usr/bin/git";

function ownedLookupFixture() {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 424242, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(),
  });
  controls.spawn.mockReturnValueOnce(child);
  let finishCleanup: ((confirmed: boolean) => void) | undefined;
  controls.terminate.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
    finishCleanup = resolve;
  }));
  return {
    child,
    close() { child.emit("close", 0, null); },
    finishCleanup(confirmed: boolean) { finishCleanup?.(confirmed); },
  };
}

function startLookup() {
  const fixture = ownedLookupFixture();
  let located: string | undefined;
  let settled = false;
  controls.prepare.mockImplementationOnce(async (_environment, locate) => {
    located = await locate();
  });
  const result = prepareGitExecutable({ PATH: "/usr/bin:/bin" })
    .catch((error: unknown) => error)
    .finally(() => { settled = true; });
  return {
    ...fixture, result,
    located: () => located,
    settled: () => settled,
    async dispose() {
      fixture.close();
      fixture.finishCleanup(true);
      await result;
    },
  };
}

describe("cold Apple Git lookup boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    controls.prepare.mockReset();
    controls.spawn.mockReset();
    controls.terminate.mockReset();
  });

  it("admits a healthy cold lookup crossing the inspection deadline only after close", async () => {
    const lookup = startLookup();
    try {
      await vi.advanceTimersByTimeAsync(coldLookupScenario.outputAtMs);
      lookup.child.stdout!.emit("data", Buffer.from(`${selectedAppleGit}\n`));
      const terminatedBeforeHealthyClose = controls.terminate.mock.calls.length;
      expect(lookup.settled()).toBe(false);
      expect(lookup.located()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(coldLookupScenario.closeAtMs - coldLookupScenario.outputAtMs);
      lookup.close();
      lookup.finishCleanup(true);
      await lookup.result;

      expect(terminatedBeforeHealthyClose).toBe(0);
      expect(controls.terminate).not.toHaveBeenCalled();
      expect(lookup.located()).toBe(`${selectedAppleGit}\n`);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await lookup.dispose();
    }
  });

  it.each([
    { deadlineMs: coldLookupScenario.deadlineMs, confirmed: true },
    { deadlineMs: coldLookupScenario.deadlineMs, confirmed: false },
  ])("bounds lookup at $deadlineMs ms and awaits exactly one cleanup (confirmed=$confirmed)", async ({
    deadlineMs, confirmed,
  }) => {
    const lookup = startLookup();
    try {
      await vi.advanceTimersByTimeAsync(deadlineMs - 1);
      const terminatedBeforeDeadline = controls.terminate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(closeDrainMs);
      const terminatedBeforeDrain = controls.terminate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1);
      expect(controls.terminate).toHaveBeenCalledExactlyOnceWith(lookup.child, true);
      lookup.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(lookup.settled()).toBe(false);
      lookup.finishCleanup(confirmed);
      const outcome = await lookup.result;

      if (confirmed) expect(outcome).toBeUndefined();
      else expect(outcome).toMatchObject({
        code: "operation-failed", message: GIT_PROCESS_TREE_TERMINATION_FAILURE,
      });
      expect(lookup.located()).toBeUndefined();
      expect(terminatedBeforeDeadline).toBe(0);
      expect(terminatedBeforeDrain).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await lookup.dispose();
    }
  });

  it("keeps ordinary Git inspection at its explicit 3-second deadline and 250-ms close drain", async () => {
    const fixture = ownedLookupFixture();
    let settled = false;
    const result = runGit("/synthetic", ["status"], {
      timeoutMs: ordinaryInspectionDeadlineMs,
      failureMessage: "Git status failed.",
    }).catch((error: unknown) => error).finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(ordinaryInspectionDeadlineMs - 1);
      expect(controls.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(closeDrainMs);
      expect(controls.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(controls.terminate).toHaveBeenCalledExactlyOnceWith(fixture.child, true);
      fixture.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      fixture.finishCleanup(true);
      await expect(result).resolves.toMatchObject({ code: "timeout" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.close();
      fixture.finishCleanup(true);
      await result;
    }
  });
});
