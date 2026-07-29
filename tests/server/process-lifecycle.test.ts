import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  ProcessTreeTerminationError,
  requireProcessTreeTermination,
  terminateProcessTree,
  terminateProcessTreeAndWait,
} from "../../src/server/process-lifecycle";

function fakeChild(pid = 4_242) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

function fakeTaskkill() {
  const taskkill = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  taskkill.unref = vi.fn();
  return taskkill;
}

describe("provider process-tree termination", () => {
  it("rejects an unconfirmed process-tree termination", async () => {
    const child = fakeChild();
    const terminate = vi.fn(async () => false);

    await expect(requireProcessTreeTermination(
      terminate,
      child as never,
      true,
      "Provider process tree",
    )).rejects.toMatchObject({
      code: "process-tree-termination-unconfirmed",
      message: "Provider process tree could not be confirmed stopped.",
    } satisfies Partial<ProcessTreeTerminationError>);
  });

  it("normalizes a failed termination check to the same typed failure", async () => {
    const child = fakeChild();

    await expect(requireProcessTreeTermination(
      async () => {
        throw new Error("taskkill failed");
      },
      child as never,
      true,
      "Provider process tree",
    )).rejects.toBeInstanceOf(ProcessTreeTerminationError);
  });

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

  it("awaits successful Windows tree termination", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const spawnProcess = vi.fn(() => taskkill);
    queueMicrotask(() => {
      taskkill.emit("close", 0);
      child.exitCode = 1;
      child.emit("close", 1);
    });

    await expect(terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "win32",
        spawnProcess: spawnProcess as never,
        waitMs: 100,
      },
    )).resolves.toBe(true);

    expect(spawnProcess).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/pid", "4242", "/t", "/f"],
      expect.objectContaining({ shell: false }),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not confirm Windows tree termination before the direct child closes", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    let settled = false;

    const termination = terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "win32",
        spawnProcess: vi.fn(() => taskkill) as never,
        waitMs: 100,
      },
    ).then((result) => {
      settled = true;
      return result;
    });

    child.exitCode = 1;
    taskkill.emit("close", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    child.emit("close", 1);
    await expect(termination).resolves.toBe(true);
  });

  it("awaits POSIX process-group disappearance", async () => {
    const child = fakeChild();
    let running = true;
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && _pid < 0) {
        if (!running) throw new Error("group gone");
        return true as const;
      }
      if (signal === "SIGKILL") running = false;
      return true as const;
    });

    await expect(terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "linux",
        killProcess,
        spawnProcessSync: vi.fn(() => ({
          status: 0,
          stdout: "",
        })) as never,
        waitMs: 100,
      },
    )).resolves.toBe(true);

    expect(killProcess).toHaveBeenCalledWith(-4_242, "SIGSTOP");
    expect(killProcess).toHaveBeenCalledWith(-4_242, "SIGKILL");
    expect(killProcess).toHaveBeenCalledWith(-4_242, 0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("keeps POSIX confirmation bounded when a target does not disappear", async () => {
    const child = fakeChild();
    const killProcess = vi.fn(() => true as const);
    const startedAt = Date.now();

    await expect(terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "linux",
        killProcess,
        spawnProcessSync: vi.fn(() => ({
          status: 0,
          stdout: "4243 4242\n",
        })) as never,
        waitMs: 25,
      },
    )).resolves.toBe(false);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(killProcess).toHaveBeenCalledWith(4_243, "SIGKILL");
  });
});
