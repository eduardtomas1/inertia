import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { terminateProcessTree } from "../../src/server/process-lifecycle";

function fakeChild(pid = 4_242) {
  return {
    pid,
    kill: vi.fn(() => true),
  };
}

function fakeTaskkill() {
  const taskkill = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  taskkill.unref = vi.fn();
  return taskkill;
}

describe("provider process-tree termination", () => {
  it.each([
    { force: false, args: ["/pid", "4242", "/t"] },
    { force: true, args: ["/pid", "4242", "/t", "/f"] },
  ])("uses taskkill for the Windows process tree (force=$force)", ({ force, args }) => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const spawnProcess = vi.fn(() => taskkill);
    const killProcess = vi.fn();

    terminateProcessTree(child as never, force, { platform: "win32", spawnProcess: spawnProcess as never, killProcess });

    expect(spawnProcess).toHaveBeenCalledWith("taskkill.exe", args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    expect(taskkill.unref).toHaveBeenCalledOnce();
    expect(killProcess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to the direct Windows child when taskkill cannot start", () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const spawnProcess = vi.fn(() => taskkill);

    terminateProcessTree(child as never, false, { platform: "win32", spawnProcess: spawnProcess as never });
    taskkill.emit("error", new Error("taskkill unavailable"));
    taskkill.emit("close", -1);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("falls back when launching taskkill throws synchronously", () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => { throw new Error("invalid taskkill launch"); });

    terminateProcessTree(child as never, true, { platform: "win32", spawnProcess: spawnProcess as never });

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("falls back when taskkill exits unsuccessfully", () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();

    terminateProcessTree(child as never, true, { platform: "win32", spawnProcess: vi.fn(() => taskkill) as never });
    taskkill.emit("close", 1);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.each([
    { force: false, signal: "SIGTERM" },
    { force: true, signal: "SIGKILL" },
  ] as const)("signals the POSIX process group (force=$force)", ({ force, signal }) => {
    const child = fakeChild();
    const killProcess = vi.fn();

    terminateProcessTree(child as never, force, { platform: "linux", killProcess });

    expect(killProcess).toHaveBeenCalledWith(-4_242, signal);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to the direct POSIX child when its process group is gone", () => {
    const child = fakeChild();
    const killProcess = vi.fn(() => { throw new Error("missing group"); });

    terminateProcessTree(child as never, true, { platform: "darwin", killProcess });

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
