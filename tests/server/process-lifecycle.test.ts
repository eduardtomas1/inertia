import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createOwnedPidProcessTreeTermination,
  createOwnedProcessTreeTermination,
  forceTerminateProcessTreeByPidAndWait,
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
    stdio: Array<{ closed: boolean } | null>;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdio = [null, null, null];
  child.kill = vi.fn(() => true);
  return child;
}

function fakeTaskkill() {
  const taskkill = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  taskkill.kill = vi.fn(() => true);
  taskkill.unref = vi.fn();
  return taskkill;
}

describe("provider process-tree termination", () => {
  it("shares one graceful-to-force termination sequence without overlapping attempts", async () => {
    const child = fakeChild();
    let finishGraceful!: (confirmed: boolean) => void;
    const graceful = new Promise<boolean>((resolve) => {
      finishGraceful = resolve;
    });
    let activeAttempts = 0;
    let maximumActiveAttempts = 0;
    const terminate = vi.fn(async (_child, force: boolean) => {
      activeAttempts += 1;
      maximumActiveAttempts = Math.max(maximumActiveAttempts, activeAttempts);
      try {
        return force ? true : await graceful;
      } finally {
        activeAttempts -= 1;
      }
    });
    const terminateOwnedProcessTree = createOwnedProcessTreeTermination(
      child as never,
      "Provider process tree",
      terminate,
    );

    const gracefulRequest = terminateOwnedProcessTree(false);
    const forcedRequest = terminateOwnedProcessTree(true);

    expect(gracefulRequest).toBe(forcedRequest);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenNthCalledWith(1, child, false);

    finishGraceful(false);
    await expect(gracefulRequest).resolves.toBeUndefined();

    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenNthCalledWith(2, child, true);
    expect(maximumActiveAttempts).toBe(1);
  });

  it("shares one typed failure when forced termination cannot be confirmed", async () => {
    const child = fakeChild();
    const terminate = vi.fn(async () => false);
    const terminateOwnedProcessTree = createOwnedProcessTreeTermination(
      child as never,
      "Provider process tree",
      terminate,
    );

    const first = terminateOwnedProcessTree(true);
    const second = terminateOwnedProcessTree(true);

    expect(first).toBe(second);
    await expect(first).rejects.toMatchObject({
      code: "process-tree-termination-unconfirmed",
      message: "Provider process tree could not be confirmed stopped.",
    } satisfies Partial<ProcessTreeTerminationError>);
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith(child, true);
  });

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

    terminateProcessTree(child as never, force, {
      platform: "win32",
      spawnProcess: spawnProcess as never,
      killProcess,
      windowsSystemRoot: null,
    });

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

    terminateProcessTree(child as never, false, {
      platform: "win32",
      spawnProcess: spawnProcess as never,
      windowsSystemRoot: null,
    });
    taskkill.emit("error", new Error("taskkill unavailable"));
    taskkill.emit("close", -1);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("falls back when launching taskkill throws synchronously", () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => { throw new Error("invalid taskkill launch"); });

    terminateProcessTree(child as never, true, {
      platform: "win32",
      spawnProcess: spawnProcess as never,
      windowsSystemRoot: null,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("falls back when taskkill exits unsuccessfully", () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();

    terminateProcessTree(child as never, true, {
      platform: "win32",
      spawnProcess: vi.fn(() => taskkill) as never,
      windowsSystemRoot: null,
    });
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
    let settled = false;
    queueMicrotask(() => {
      taskkill.emit("close", 0);
      child.exitCode = 1;
      child.emit("close", 1);
    });

    const termination = terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "win32",
        spawnProcess: spawnProcess as never,
        windowsSystemRoot: null,
        waitMs: 100,
      },
    ).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    await expect(termination).resolves.toBe(true);

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
        windowsSystemRoot: null,
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

  it("waits when a Windows child exited before entry but its stdio remains open", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const stdout = { closed: false };
    child.exitCode = 1;
    child.stdio[1] = stdout;
    let settled = false;

    const termination = terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "win32",
        spawnProcess: vi.fn(() => taskkill) as never,
        windowsSystemRoot: null,
        waitMs: 100,
      },
    ).then((result) => {
      settled = true;
      return result;
    });

    taskkill.emit("close", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    stdout.closed = true;
    child.emit("close", 1);
    await expect(termination).resolves.toBe(true);
  });

  it("accepts a Windows child whose process and stdio closed before entry without targeting a reused PID", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const spawnProcess = vi.fn(() => taskkill);
    child.exitCode = 0;
    child.stdio[1] = { closed: true };

    await expect(terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "win32",
        spawnProcess: spawnProcess as never,
        windowsSystemRoot: null,
        waitMs: 25,
      },
    )).resolves.toBe(true);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("uses the trusted System32 taskkill when PATH cannot resolve system tools", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const spawnProcess = vi.fn(() => taskkill);
    const termination = terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "win32",
        spawnProcess: spawnProcess as never,
        windowsSystemRoot: "C:\\Windows",
        waitMs: 100,
      },
    );

    taskkill.emit("close", 0);
    child.exitCode = 1;
    child.emit("close", 1);

    await expect(termination).resolves.toBe(true);
    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "4242", "/t", "/f"],
      expect.objectContaining({ shell: false }),
    );
  });

  it.each([
    {
      label: "reports an error",
      settleTaskkill: (taskkill: ReturnType<typeof fakeTaskkill>) => {
        taskkill.emit("error", new Error("taskkill unavailable"));
      },
    },
    {
      label: "exits unsuccessfully",
      settleTaskkill: (taskkill: ReturnType<typeof fakeTaskkill>) => {
        taskkill.emit("close", 1);
      },
    },
  ])("keeps the Windows tree unconfirmed when taskkill $label", async ({
    settleTaskkill,
  }) => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const termination = terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "win32",
        spawnProcess: vi.fn(() => taskkill) as never,
        windowsSystemRoot: null,
        waitMs: 25,
      },
    );

    settleTaskkill(taskkill);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.exitCode = 1;
    child.emit("close", 1);
    await expect(termination).resolves.toBe(false);
  });

  it("keeps the Windows tree unconfirmed when taskkill times out", async () => {
    const child = fakeChild();
    const taskkill = fakeTaskkill();
    const termination = terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "win32",
        spawnProcess: vi.fn(() => taskkill) as never,
        windowsSystemRoot: null,
        waitMs: 10,
      },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(taskkill.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.exitCode = 1;
    child.emit("close", 1);
    await expect(termination).resolves.toBe(false);
  });

  it("keeps the Windows tree unconfirmed when taskkill throws during launch", async () => {
    const child = fakeChild();
    const termination = terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "win32",
        spawnProcess: vi.fn(() => {
          throw new Error("invalid taskkill launch");
        }) as never,
        windowsSystemRoot: null,
        waitMs: 25,
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.exitCode = 1;
    child.emit("close", 1);
    await expect(termination).resolves.toBe(false);
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

  it("confirms a PID-owned POSIX tree only after descendants and the root exit", async () => {
    const running = new Set([4_242, 4_243]);
    const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      const target = Math.abs(pid);
      if (signal === 0) {
        if (!running.has(target)) throw new Error("process gone");
        return true as const;
      }
      if (signal === "SIGKILL") running.delete(target);
      return true as const;
    });
    const waitForRootExit = vi.fn(async (_waitMs: number) =>
      !running.has(4_242));

    await expect(forceTerminateProcessTreeByPidAndWait(
      4_242,
      waitForRootExit,
      {
        platform: "linux",
        killProcess,
        spawnProcessSync: vi.fn(() => ({
          status: 0,
          stdout: "4243 4242\n",
        })) as never,
        waitMs: 25,
      },
    )).resolves.toBe(true);

    expect(killProcess).toHaveBeenCalledWith(4_243, "SIGKILL");
    expect(killProcess).toHaveBeenCalledWith(-4_242, "SIGKILL");
    const rootExitBudget = waitForRootExit.mock.calls[0]?.[0];
    expect(rootExitBudget).toBeGreaterThan(0);
    expect(rootExitBudget).toBeLessThanOrEqual(25);
  });

  it("retries confirmation without re-signalling the original POSIX identities", async () => {
    vi.useFakeTimers();
    try {
      const running = new Set([4_242, 4_243]);
      const killProcess = vi.fn((
        pid: number,
        signal?: NodeJS.Signals | number,
      ) => {
        if (signal === 0) {
          if (!running.has(Math.abs(pid))) throw new Error("process gone");
        }
        return true as const;
      });
      const spawnProcessSync = vi.fn(() => ({
        status: 0,
        stdout: "4243 4242\n",
      }));
      const waitForRootExit = vi.fn(async () => !running.has(4_242));
      const terminate = createOwnedPidProcessTreeTermination(
        4_242,
        waitForRootExit,
        {
          platform: "linux",
          killProcess,
          spawnProcessSync: spawnProcessSync as never,
          waitMs: 25,
        },
      );

      const first = terminate();
      await vi.advanceTimersByTimeAsync(25);
      await expect(first).resolves.toBe(false);
      const signalsAfterFirstAttempt = killProcess.mock.calls.filter(
        ([, signal]) => signal !== 0,
      );
      running.clear();

      await expect(terminate()).resolves.toBe(true);
      expect(spawnProcessSync).toHaveBeenCalledTimes(2);
      expect(killProcess.mock.calls.filter(
        ([, signal]) => signal !== 0,
      )).toEqual(signalsAfterFirstAttempt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not signal a recycled descendant PID during confirmation retry", async () => {
    vi.useFakeTimers();
    try {
      const running = new Set([4_242, 4_243]);
      const killProcess = vi.fn((
        pid: number,
        signal?: NodeJS.Signals | number,
      ) => {
        if (signal === 0) {
          if (!running.has(Math.abs(pid))) throw new Error("process gone");
        }
        return true as const;
      });
      const spawnProcessSync = vi.fn(() => ({
        status: 0,
        stdout: "4243 4242\n",
      }));
      const rootExited = vi.fn(async () => !running.has(4_242));
      const terminate = createOwnedPidProcessTreeTermination(
        4_242,
        rootExited,
        {
          platform: "linux",
          killProcess,
          spawnProcessSync: spawnProcessSync as never,
          waitMs: 25,
        },
      );

      const first = terminate();
      await vi.advanceTimersByTimeAsync(25);
      await expect(first).resolves.toBe(false);
      const signalsAfterFirstAttempt = killProcess.mock.calls.filter(
        ([, signal]) => signal !== 0,
      );
      running.delete(4_242);
      running.delete(4_243);
      // The original child exited, but another process now owns its numeric
      // PID. Confirmation must fail closed without signalling that process.
      running.add(4_243);

      const retry = terminate();
      await vi.advanceTimersByTimeAsync(25);
      await expect(retry).resolves.toBe(false);
      expect(spawnProcessSync).toHaveBeenCalledTimes(2);
      expect(killProcess.mock.calls.filter(
        ([, signal]) => signal !== 0,
      )).toEqual(signalsAfterFirstAttempt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not confirm a PID-owned Windows tree when trusted taskkill fails", async () => {
    const taskkill = fakeTaskkill();
    const waitForRootExit = vi.fn(async () => true);
    const termination = forceTerminateProcessTreeByPidAndWait(
      4_242,
      waitForRootExit,
      {
        platform: "win32",
        spawnProcess: vi.fn(() => taskkill) as never,
        windowsSystemRoot: "C:\\Windows",
        waitMs: 25,
      },
    );

    taskkill.emit("close", 1);

    await expect(termination).resolves.toBe(false);
    expect(waitForRootExit).not.toHaveBeenCalled();
  });

  it("does not retarget a recycled Windows root after taskkill fails", async () => {
    const taskkill = fakeTaskkill();
    const spawnProcess = vi.fn(() => taskkill);
    const waitForRootExit = vi.fn(async () => true);
    const terminate = createOwnedPidProcessTreeTermination(
      4_242,
      waitForRootExit,
      {
        platform: "win32",
        spawnProcess: spawnProcess as never,
        windowsSystemRoot: "C:\\Windows",
        waitMs: 25,
      },
    );
    const first = terminate();
    taskkill.emit("close", 1);

    await expect(first).resolves.toBe(false);
    await expect(terminate()).resolves.toBe(false);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(waitForRootExit).not.toHaveBeenCalled();
  });

  it("shares one bounded Windows deadline across taskkill, root exit, and resource settling", async () => {
    vi.useFakeTimers();
    try {
      const taskkill = fakeTaskkill();
      const waitForRootExit = vi.fn((waitMs: number) =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(true), waitMs);
        }));
      let settled = false;
      const termination = forceTerminateProcessTreeByPidAndWait(
        4_242,
        waitForRootExit,
        {
          platform: "win32",
          spawnProcess: vi.fn(() => taskkill) as never,
          windowsSystemRoot: "C:\\Windows",
          waitMs: 1_000,
        },
      ).then((confirmed) => {
        settled = true;
        return confirmed;
      });
      setTimeout(() => taskkill.emit("close", 0), 600);

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      expect(waitForRootExit).toHaveBeenCalledWith(300);

      await vi.advanceTimersByTimeAsync(1);
      await expect(termination).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows the bounded node-pty Windows exit-flush delay before confirmation", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const taskkill = fakeTaskkill();
      const waitForRootExit = vi.fn((_waitMs: number) =>
        new Promise<boolean>((resolve) => {
          // node-pty's ConPTY backend delays onExit by this output-flush window
          // after its root process has already exited.
          setTimeout(() => resolve(true), 1_000);
        }));
      let settled = false;
      const termination = forceTerminateProcessTreeByPidAndWait(
        4_242,
        waitForRootExit,
        {
          platform: "win32",
          spawnProcess: vi.fn(() => taskkill) as never,
          windowsSystemRoot: "C:\\Windows",
          waitMs: 1_500,
        },
      ).then((confirmed) => {
        settled = true;
        return confirmed;
      });
      taskkill.emit("close", 0);

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      expect(waitForRootExit).toHaveBeenCalledWith(1_400);

      await vi.advanceTimersByTimeAsync(101);
      await expect(termination).resolves.toBe(true);
      expect(Date.now()).toBe(1_100);
    } finally {
      vi.useRealTimers();
    }
  });
});
