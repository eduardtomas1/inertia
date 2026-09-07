import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
  prepare: vi.fn<(environment: NodeJS.ProcessEnv, locate: () => Promise<string>) => Promise<void>>(),
  spawn: vi.fn(),
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
import { prepareGitExecutable } from "../../src/server/git/runner";
import { GitError, GIT_PROCESS_TREE_TERMINATION_FAILURE } from "../../src/server/git/types";
import { runtimeOwnedProcessInvocation, spawnRuntimeOwnedProcess } from "../../src/node/runtime-owned-processes";

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

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
