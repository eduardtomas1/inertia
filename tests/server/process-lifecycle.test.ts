// @inertia-test-suite portable
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

const WINDOWS_SEQUENCE_MS = 2 * 100 + 100;

function noSuchProcess(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "ESRCH";
  return error;
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

  it("escalates a refused graceful Windows taskkill to a forced tree kill before touching the root", async () => {
    const child = fakeChild();
    const graceful = fakeTaskkill();
    const forced = fakeTaskkill();
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(graceful)
      .mockReturnValueOnce(forced);
    const termination = terminateProcessTreeAndWait(
      child as never,
      false,
      {
        platform: "win32",
        spawnProcess: spawnProcess as never,
        windowsSystemRoot: null,
        waitMs: 100,
      },
    );

    graceful.emit("close", 128);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      "taskkill.exe",
      ["/pid", "4242", "/t", "/f"],
      expect.objectContaining({ shell: false }),
    );
    expect(child.kill).not.toHaveBeenCalled();

    forced.emit("close", 0);
    child.exitCode = 1;
    child.emit("close", 1);
    await expect(termination).resolves.toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("shares one Windows termination budget across graceful and forced taskkill and the root close", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      child.kill = vi.fn(() => true);
      const graceful = fakeTaskkill();
      const forced = fakeTaskkill();
      const spawnProcess = vi.fn()
        .mockReturnValueOnce(graceful)
        .mockReturnValueOnce(forced);
      let result: boolean | undefined;
      const startedAt = Date.now();
      void terminateProcessTreeAndWait(
        child as never,
        false,
        {
          platform: "win32",
          spawnProcess: spawnProcess as never,
          windowsSystemRoot: null,
          waitMs: 100,
        },
      ).then((value) => { result = value; });

      await vi.advanceTimersByTimeAsync(40);
      graceful.emit("close", 128);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnProcess).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60);
      expect(forced.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(40);
      expect(forced.kill).toHaveBeenCalledWith("SIGKILL");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(59);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBe(false);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(WINDOWS_SEQUENCE_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("Windows tree evidence", () => {
    const owned = (child: ReturnType<typeof fakeChild>, spawnProcess: ReturnType<typeof vi.fn>) => {
      let outcome: "confirmed" | "unconfirmed" | undefined;
      const terminate = createOwnedProcessTreeTermination(
        child as never,
        "Provider process tree",
        (ownedChild, force) => terminateProcessTreeAndWait(ownedChild, force, {
          platform: "win32",
          spawnProcess: spawnProcess as never,
          windowsSystemRoot: null,
          waitMs: 100,
        }),
      );
      void terminate(false).then(() => { outcome = "confirmed"; }, () => { outcome = "unconfirmed"; });
      return () => outcome;
    };
    const taskkillExiting = (codeFor: (args: string[]) => number, after = 5) => vi.fn((_command: string, args: string[]) => {
      const taskkill = fakeTaskkill();
      setTimeout(() => taskkill.emit("close", codeFor(args)), after);
      return taskkill;
    });
    const argsOf = (spawnProcess: ReturnType<typeof vi.fn>) => spawnProcess.mock.calls.map(([, args]) => args);

    it("never confirms a retry after taskkill failed against a root that had already exited", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        child.exitCode = 3;
        child.stdio[1] = { closed: false };
        child.kill = vi.fn(() => false);
        const spawnProcess = taskkillExiting(() => 128);
        const outcome = owned(child, spawnProcess);
        await vi.advanceTimersByTimeAsync(10);
        child.stdio[1] = { closed: true };
        child.emit("close", 3);
        await vi.advanceTimersByTimeAsync(400);
        expect(outcome()).toBe("unconfirmed");
        expect(argsOf(spawnProcess)).toEqual([["/pid", "4242", "/t"]]);
        expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never confirms a retry after both taskkills failed and the direct kill stopped the root", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        child.kill = vi.fn(() => {
          child.exitCode = 1;
          setTimeout(() => child.emit("close", 1), 1);
          return true;
        });
        const spawnProcess = taskkillExiting(() => 1);
        const outcome = owned(child, spawnProcess);
        await vi.advanceTimersByTimeAsync(400);
        expect(outcome()).toBe("unconfirmed");
        expect(argsOf(spawnProcess)).toEqual([["/pid", "4242", "/t"], ["/pid", "4242", "/t", "/f"]]);
        expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("confirms a tree after a forced taskkill succeeded while the root handle was held", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        const spawnProcess = vi.fn((_command: string, args: string[]) => {
          const taskkill = fakeTaskkill();
          const forced = args.includes("/f");
          setTimeout(() => {
            taskkill.emit("close", forced ? 0 : 128);
            if (forced) {
              child.exitCode = 1;
              child.emit("close", 1);
            }
          }, 5);
          return taskkill;
        });
        const outcome = owned(child, spawnProcess);
        await vi.advanceTimersByTimeAsync(400);
        expect(outcome()).toBe("confirmed");
        expect(argsOf(spawnProcess)).toEqual([["/pid", "4242", "/t"], ["/pid", "4242", "/t", "/f"]]);
        expect(child.kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports a forced taskkill that finds an exiting root gone unconfirmed even after an accepted graceful request", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        child.kill = vi.fn(() => false);
        const spawnProcess = taskkillExiting((args) => args.includes("/f") ? 128 : 0);
        const outcome = owned(child, spawnProcess);
        await vi.advanceTimersByTimeAsync(150);
        child.exitCode = 0;
        child.emit("close", 0);
        await vi.advanceTimersByTimeAsync(250);
        expect(outcome()).toBe("unconfirmed");
        expect(argsOf(spawnProcess)).toEqual([["/pid", "4242", "/t"], ["/pid", "4242", "/t", "/f"]]);
        expect(child.kill.mock.calls).toEqual([["SIGKILL"]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives the forced escalation the remaining sequence budget after a graceful taskkill consumed its window", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        const events: Array<[number, string]> = [];
        const spawnProcess = vi.fn((_command: string, args: string[]) => {
          const taskkill = fakeTaskkill();
          const forced = args.includes("/f");
          events.push([Date.now() - startedAt, args.join(" ")]);
          if (forced) {
            setTimeout(() => {
              taskkill.emit("close", 0);
              child.exitCode = 1;
              child.emit("close", 1);
            }, 30);
          }
          return taskkill;
        });
        const outcome = owned(child, spawnProcess);
        await vi.advanceTimersByTimeAsync(400);
        expect(events).toEqual([[0, "/pid 4242 /t"], [100, "/pid 4242 /t /f"]]);
        expect(outcome()).toBe("confirmed");
        expect(child.kill).not.toHaveBeenCalled();
        expect(Date.now() - startedAt).toBeLessThanOrEqual(400);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves a starved escalation to the forced call instead of marking the tree unconfirmed from the graceful call", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        child.kill = vi.fn(() => true);
        const graceful = fakeTaskkill();
        const forced = fakeTaskkill();
        const spawnProcess = vi.fn()
          .mockImplementationOnce(() => {
            setTimeout(() => {
              vi.setSystemTime(startedAt + 250);
              graceful.emit("close", 1);
            }, 40);
            return graceful;
          })
          .mockImplementationOnce(() => forced);
        let first: boolean | undefined;
        void terminateProcessTreeAndWait(child as never, false, {
          platform: "win32",
          spawnProcess: spawnProcess as never,
          windowsSystemRoot: null,
          waitMs: 100,
        }).then((value) => { first = value; });
        await vi.advanceTimersByTimeAsync(40);
        expect(first).toBe(false);
        expect(child.kill).not.toHaveBeenCalled();
        expect(spawnProcess).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("confirms a root that fully closed before any termination attempt without running taskkill", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        child.exitCode = 0;
        const spawnProcess = taskkillExiting(() => 0);
        const outcome = owned(child, spawnProcess);
        await vi.advanceTimersByTimeAsync(100);
        expect(outcome()).toBe("confirmed");
        expect(spawnProcess).not.toHaveBeenCalled();
        expect(child.kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Windows resource settle state", () => {
    const terminate = (child: ReturnType<typeof fakeChild>, spawnProcess: ReturnType<typeof vi.fn>, force = true) => {
      const outcome: { value?: boolean } = {};
      void terminateProcessTreeAndWait(child as never, force, {
        platform: "win32",
        spawnProcess: spawnProcess as never,
        windowsSystemRoot: null,
        waitMs: 100,
      }).then((value) => { outcome.value = value; });
      return outcome;
    };

    it("does not confirm a retry after close was observed with 99 ms left until a full settle completes", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        const taskkill = fakeTaskkill();
        const spawnProcess = vi.fn(() => taskkill);
        const first = terminate(child, spawnProcess);
        await vi.advanceTimersByTimeAsync(10);
        taskkill.emit("close", 0);
        await vi.advanceTimersByTimeAsync(189);
        child.exitCode = 1;
        child.emit("close", 1);
        vi.setSystemTime(startedAt + 201);
        await vi.advanceTimersByTimeAsync(0);
        expect(first.value).toBe(false);

        const retry = terminate(child, spawnProcess);
        await vi.advanceTimersByTimeAsync(99);
        expect(retry.value).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(retry.value).toBe(true);
        expect(spawnProcess).toHaveBeenCalledOnce();
        expect(Date.now() - startedAt).toBeLessThanOrEqual(2 * 100 + 2 * 100);

        const again = terminate(child, spawnProcess);
        await vi.advanceTimersByTimeAsync(0);
        expect(again.value).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives an owned termination whose forced call ran out of budget one bounded settle on its retry", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        const taskkill = fakeTaskkill();
        const spawnProcess = vi.fn(() => taskkill);
        let settled: "confirmed" | "unconfirmed" | undefined;
        void createOwnedProcessTreeTermination(
          child as never,
          "Provider update process tree",
          (ownedChild, force) => terminateProcessTreeAndWait(ownedChild, force, {
            platform: "win32",
            spawnProcess: spawnProcess as never,
            windowsSystemRoot: null,
            waitMs: 100,
          }),
        )(false).then(() => { settled = "confirmed"; }, () => { settled = "unconfirmed"; });
        await vi.advanceTimersByTimeAsync(10);
        taskkill.emit("close", 0);
        await vi.advanceTimersByTimeAsync(89);
        child.exitCode = 1;
        child.emit("close", 1);
        vi.setSystemTime(startedAt + 201);
        await vi.advanceTimersByTimeAsync(99);
        expect(settled).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe("confirmed");
        expect(Date.now() - startedAt).toBeLessThanOrEqual(2 * 100 + 2 * 100 + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("settles an already-closed child on the first call before confirming it", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        child.exitCode = 0;
        const spawnProcess = vi.fn(() => fakeTaskkill());
        const outcome = terminate(child, spawnProcess);
        await vi.advanceTimersByTimeAsync(99);
        expect(outcome.value).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome.value).toBe(true);
        expect(spawnProcess).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("never confirms a closed child whose tree fell back to a direct kill", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        child.kill = vi.fn(() => {
          child.exitCode = 1;
          queueMicrotask(() => child.emit("close", 1));
          return true;
        });
        const taskkill = fakeTaskkill();
        const first = terminate(child, vi.fn(() => taskkill));
        await vi.advanceTimersByTimeAsync(10);
        taskkill.emit("close", 1);
        await vi.advanceTimersByTimeAsync(300);
        expect(first.value).toBe(false);
        const retry = terminate(child, vi.fn(() => fakeTaskkill()));
        await vi.advanceTimersByTimeAsync(0);
        expect(retry.value).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Windows termination sequence deadline", () => {
    const run = (
      child: ReturnType<typeof fakeChild>,
      spawnProcess: ReturnType<typeof vi.fn>,
      force = true,
    ) => {
      const outcome: { value?: boolean } = {};
      void terminateProcessTreeAndWait(child as never, force, {
        platform: "win32",
        spawnProcess: spawnProcess as never,
        windowsSystemRoot: null,
        waitMs: 100,
      }).then((value) => { outcome.value = value; });
      return outcome;
    };
    const closeChild = (child: ReturnType<typeof fakeChild>): void => {
      child.exitCode = 1;
      child.emit("close", 1);
    };

    it.each([
      { label: "1 ms before its close deadline", closeAt: 199, confirmed: true, settledAt: 299 },
      { label: "at its close deadline", closeAt: 200, confirmed: false, settledAt: 200 },
      { label: "1 ms before the sequence deadline", closeAt: 299, confirmed: false, settledAt: 200 },
      { label: "after the sequence deadline", closeAt: 350, confirmed: false, settledAt: 200 },
    ])("bounds a root that closes $label", async ({ closeAt, confirmed, settledAt }) => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        const taskkill = fakeTaskkill();
        const outcome = run(child, vi.fn(() => taskkill));
        await vi.advanceTimersByTimeAsync(10);
        taskkill.emit("close", 0);
        let settledElapsedMs: number | undefined;
        for (let elapsed = 10; elapsed < 400; elapsed += 1) {
          if (elapsed === closeAt) closeChild(child);
          await vi.advanceTimersByTimeAsync(1);
          if (outcome.value !== undefined && settledElapsedMs === undefined) {
            settledElapsedMs = Date.now() - startedAt;
          }
        }
        expect(outcome.value).toBe(confirmed);
        expect(settledElapsedMs).toBe(settledAt);
        expect(settledElapsedMs).toBeLessThanOrEqual(WINDOWS_SEQUENCE_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports unconfirmed instead of shortening the resource settle when the close is observed late", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        const taskkill = fakeTaskkill();
        const outcome = run(child, vi.fn(() => taskkill));
        await vi.advanceTimersByTimeAsync(10);
        taskkill.emit("close", 0);
        await vi.advanceTimersByTimeAsync(189);
        closeChild(child);
        vi.setSystemTime(startedAt + 260);
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome.value).toBe(false);
        expect(Date.now() - startedAt).toBeLessThanOrEqual(WINDOWS_SEQUENCE_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports unconfirmed without settling when the close is observed after the deadline", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        const taskkill = fakeTaskkill();
        const outcome = run(child, vi.fn(() => taskkill));
        await vi.advanceTimersByTimeAsync(10);
        taskkill.emit("close", 0);
        await vi.advanceTimersByTimeAsync(189);
        closeChild(child);
        vi.setSystemTime(startedAt + WINDOWS_SEQUENCE_MS);
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome.value).toBe(false);
        expect(Date.now() - startedAt).toBe(WINDOWS_SEQUENCE_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    it("escalates within the remaining sequence budget after a graceful taskkill consumed its window, then falls back at the close deadline", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        const graceful = fakeTaskkill();
        const forced = fakeTaskkill();
        const spawnProcess = vi.fn()
          .mockReturnValueOnce(graceful)
          .mockReturnValueOnce(forced);
        const outcome = run(child, spawnProcess, false);
        await vi.advanceTimersByTimeAsync(100);
        expect(graceful.kill).toHaveBeenCalledWith("SIGKILL");
        expect(spawnProcess.mock.calls.map(([, args]) => args)).toEqual([
          ["/pid", "4242", "/t"],
          ["/pid", "4242", "/t", "/f"],
        ]);
        expect(child.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(99);
        expect(outcome.value).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(forced.kill).toHaveBeenCalledWith("SIGKILL");
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(outcome.value).toBe(false);
        expect(Date.now() - startedAt).toBeLessThanOrEqual(WINDOWS_SEQUENCE_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives an ignored graceful request its grace period and the forced taskkill the rest of the sequence", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        const spawnProcess = vi.fn((_command: string, args: string[]) => {
          const taskkill = fakeTaskkill();
          const forced = args.includes("/f");
          setTimeout(() => {
            taskkill.emit("close", 0);
            if (forced) closeChild(child);
          }, 10);
          return taskkill;
        });
        const terminate = createOwnedProcessTreeTermination(
          child as never,
          "Provider update process tree",
          (ownedChild, force) => terminateProcessTreeAndWait(ownedChild, force, {
            platform: "win32",
            spawnProcess: spawnProcess as never,
            windowsSystemRoot: null,
            waitMs: 100,
          }),
        );
        let resolvedAt: number | undefined;
        void terminate(false).then(() => { resolvedAt = Date.now() - startedAt; });
        await vi.advanceTimersByTimeAsync(WINDOWS_SEQUENCE_MS + 100);
        expect(spawnProcess.mock.calls.map(([, args]) => args)).toEqual([
          ["/pid", "4242", "/t"],
          ["/pid", "4242", "/t", "/f"],
        ]);
        expect(resolvedAt).toBe(210);
        expect(resolvedAt).toBeLessThanOrEqual(WINDOWS_SEQUENCE_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives the final forced call of an owned termination only the time left in the sequence", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        const graceful = fakeTaskkill();
        const spawnProcess = vi.fn((_command: string, _args: string[]) => graceful);
        const terminate = createOwnedProcessTreeTermination(
          child as never,
          "Provider update process tree",
          (ownedChild, force) => terminateProcessTreeAndWait(ownedChild, force, {
            platform: "win32",
            spawnProcess: spawnProcess as never,
            windowsSystemRoot: null,
            waitMs: 100,
          }),
        );
        let rejectedAt: number | undefined;
        void terminate(false).catch(() => { rejectedAt = Date.now() - startedAt; });
        await vi.advanceTimersByTimeAsync(WINDOWS_SEQUENCE_MS + 100);
        expect(rejectedAt).toBe(200);
        expect(rejectedAt).toBeLessThanOrEqual(WINDOWS_SEQUENCE_MS);
        expect(spawnProcess.mock.calls.map(([, args]) => args)).toEqual([
          ["/pid", "4242", "/t"],
          ["/pid", "4242", "/t", "/f"],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not escalate a refused graceful Windows taskkill after the root has exited", async () => {
    const child = fakeChild();
    const graceful = fakeTaskkill();
    const spawnProcess = vi.fn(() => graceful);
    child.stdio[1] = { closed: false };
    const termination = terminateProcessTreeAndWait(
      child as never,
      false,
      {
        platform: "win32",
        spawnProcess: spawnProcess as never,
        windowsSystemRoot: null,
        waitMs: 25,
      },
    );

    child.exitCode = 0;
    graceful.emit("close", 128);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spawnProcess).toHaveBeenCalledOnce();

    child.stdio[1] = { closed: true };
    child.emit("close", 0);
    await expect(termination).resolves.toBe(false);
  });

  it.each([
    { label: "confirms", forcedExitCode: 0, confirmed: true },
    { label: "rejects", forcedExitCode: 1, confirmed: false },
  ])("$label a graceful-then-forced Windows owned termination by its forced tree kill", async ({
    forcedExitCode,
    confirmed,
  }) => {
    const child = fakeChild();
    child.kill = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("close", 1);
      });
      return true;
    });
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const taskkill = fakeTaskkill();
      const forced = args.includes("/f");
      queueMicrotask(() => {
        taskkill.emit("close", forced ? forcedExitCode : 128);
        if (forced && forcedExitCode === 0) {
          child.exitCode = 1;
          child.emit("close", 1);
        }
      });
      return taskkill;
    });
    const terminate = createOwnedProcessTreeTermination(
      child as never,
      "Provider update process tree",
      (ownedChild, force) => terminateProcessTreeAndWait(ownedChild, force, {
        platform: "win32",
        spawnProcess: spawnProcess as never,
        windowsSystemRoot: null,
        waitMs: 25,
      }),
    );

    const termination = terminate(false);
    if (confirmed) await expect(termination).resolves.toBeUndefined();
    else {
      await expect(termination).rejects.toMatchObject({
        code: "process-tree-termination-unconfirmed",
      });
    }
    expect(spawnProcess.mock.calls.map(([, args]) => args)).toEqual([
      ["/pid", "4242", "/t"],
      ["/pid", "4242", "/t", "/f"],
    ]);
    expect(child.kill).toHaveBeenCalledTimes(confirmed ? 0 : 1);
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

    await vi.waitFor(() => {
      expect(taskkill.kill).toHaveBeenCalledWith("SIGKILL");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

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

  it("counts the POSIX tree snapshot against the same termination deadline as the exit waits", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const child = fakeChild();
      const killProcess = vi.fn(() => true as const);
      let result: boolean | undefined;
      void terminateProcessTreeAndWait(
        child as never,
        true,
        {
          platform: "linux",
          killProcess: killProcess as never,
          spawnProcessSync: vi.fn(() => {
            vi.setSystemTime(Date.now() + 80);
            return { status: 0, stdout: "4242 1 T\n" };
          }) as never,
          processCanExecute: () => true,
          processGroupCanExecute: () => true,
          waitMs: 100,
        },
      ).then((value) => { result = value; });

      await vi.advanceTimersByTimeAsync(19);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBe(false);
      expect(Date.now() - startedAt).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("POSIX group signals stay tied to an unreaped leader", () => {
    const signals = (killProcess: ReturnType<typeof vi.fn>) =>
      killProcess.mock.calls.filter(([, signal]) => signal !== 0);
    const tree = (options: {
      child: ReturnType<typeof fakeChild>;
      groupKillsNeeded: number;
      leaderReapedAfterMs: number;
      closeWithReap: boolean;
    }) => {
      let groupKills = 0;
      const killProcess = vi.fn((target: number, signal?: NodeJS.Signals | number) => {
        if (target === -4_242 && signal === 0) {
          if (groupKills >= options.groupKillsNeeded) throw noSuchProcess("group gone");
          return true as const;
        }
        if (target === -4_242 && signal === "SIGKILL") groupKills += 1;
        if (target === 4_242 && signal === "SIGKILL") {
          setTimeout(() => {
            options.child.exitCode = 1;
            options.child.emit("exit", 1, null);
            if (options.closeWithReap) options.child.emit("close", 1);
          }, options.leaderReapedAfterMs);
        }
        return true as const;
      });
      return killProcess;
    };
    const dependencies = (killProcess: ReturnType<typeof vi.fn>) => ({
      platform: "linux" as const,
      killProcess: killProcess as never,
      spawnProcessSync: vi.fn(() => ({ status: 0, stdout: "4242 1 T\n" })) as never,
      processCanExecute: () => null,
      processGroupCanExecute: () => null,
      waitMs: 100,
    });

    it("re-signals the group while Node has not reaped its leader and confirms once a forked member is gone", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        const killProcess = tree({ child, groupKillsNeeded: 2, leaderReapedAfterMs: 15, closeWithReap: true });
        let result: boolean | undefined;
        void terminateProcessTreeAndWait(child as never, true, dependencies(killProcess))
          .then((value) => { result = value; });
        await vi.advanceTimersByTimeAsync(20);
        expect(signals(killProcess)).toEqual([
          [-4_242, "SIGSTOP"], [4_242, "SIGSTOP"],
          [-4_242, "SIGKILL"], [4_242, "SIGKILL"],
          [-4_242, "SIGKILL"],
        ]);
        expect(result).toBe(true);
        expect(Date.now() - startedAt).toBeLessThanOrEqual(100);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never signals the group again once Node has reaped its leader, even while that group number is live", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const child = fakeChild();
        child.stdio[1] = { closed: false };
        const killProcess = tree({ child, groupKillsNeeded: Number.POSITIVE_INFINITY, leaderReapedAfterMs: 5, closeWithReap: false });
        let result: boolean | undefined;
        void terminateProcessTreeAndWait(child as never, true, dependencies(killProcess))
          .then((value) => { result = value; });
        await vi.advanceTimersByTimeAsync(100);
        expect(signals(killProcess)).toEqual([
          [-4_242, "SIGSTOP"], [4_242, "SIGSTOP"],
          [-4_242, "SIGKILL"], [4_242, "SIGKILL"],
          [-4_242, "SIGKILL"],
        ]);
        expect(result).toBe(false);
        expect(Date.now() - startedAt).toBeLessThanOrEqual(100);
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends no signal when Node observed the leader's exit before cleanup and reports a surviving group unconfirmed", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        child.exitCode = 0;
        child.stdio[1] = { closed: false };
        const killProcess = tree({ child, groupKillsNeeded: Number.POSITIVE_INFINITY, leaderReapedAfterMs: 0, closeWithReap: false });
        let result: boolean | undefined;
        void terminateProcessTreeAndWait(child as never, true, dependencies(killProcess))
          .then((value) => { result = value; });
        await vi.advanceTimersByTimeAsync(100);
        expect(signals(killProcess)).toEqual([]);
        expect(result).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends no graceful group signal when Node observed the leader's exit before cleanup", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        child.exitCode = 0;
        child.stdio[1] = { closed: false };
        const killProcess = tree({ child, groupKillsNeeded: 0, leaderReapedAfterMs: 0, closeWithReap: false });
        void terminateProcessTreeAndWait(child as never, false, dependencies(killProcess));
        await vi.advanceTimersByTimeAsync(100);
        expect(signals(killProcess)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not re-signal the group of a PID-owned tree whose leader another thread reaps", async () => {
      vi.useFakeTimers();
      try {
        const child = fakeChild();
        const killProcess = tree({ child, groupKillsNeeded: 2, leaderReapedAfterMs: 15, closeWithReap: false });
        let result: boolean | undefined;
        void createOwnedPidProcessTreeTermination(4_242, async () => true, dependencies(killProcess))()
          .then((value) => { result = value; });
        await vi.advanceTimersByTimeAsync(100);
        expect(signals(killProcess)).toEqual([
          [-4_242, "SIGSTOP"], [4_242, "SIGSTOP"],
          [-4_242, "SIGKILL"], [4_242, "SIGKILL"],
        ]);
        expect(result).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("POSIX descendant snapshot confirmation", () => {
    const posixTermination = (
      spawnProcessSync: ReturnType<typeof vi.fn>,
      closeOnKill: "sync" | "async" = "async",
    ) => {
      const child = fakeChild();
      const exited = new Set<number>();
      const killProcess = vi.fn((target: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0) {
          if (exited.has(Math.abs(target))) throw noSuchProcess("gone");
          return true as const;
        }
        if (signal === "SIGKILL") {
          exited.add(Math.abs(target));
          if (Math.abs(target) === 4_242 && child.exitCode === null) {
            child.exitCode = 1;
            if (closeOnKill === "sync") child.emit("close", 1);
            else queueMicrotask(() => child.emit("close", 1));
          }
        }
        return true as const;
      });
      const terminate = createOwnedProcessTreeTermination(
        child as never,
        "Provider process tree",
        (ownedChild, force) => terminateProcessTreeAndWait(ownedChild, force, {
          platform: "linux",
          killProcess: killProcess as never,
          spawnProcessSync: spawnProcessSync as never,
          waitMs: 1_000,
        }),
      );
      return { child, exited, terminate };
    };

    it.each([
      {
        label: "a process listing that keeps timing out",
        closeOnKill: "async" as const,
        listing: () => {
          vi.setSystemTime(Date.now() + 20);
          return { status: null, stdout: "" };
        },
      },
      {
        label: "descendants that keep appearing until the scan stops",
        closeOnKill: "async" as const,
        listing: (() => {
          let next = 5_000;
          return () => {
            vi.setSystemTime(Date.now() + 10);
            const rows = ["4242 1 S"];
            for (let pid = 5_000; pid <= next; pid += 1) rows.push(`${pid} 4242 S`);
            next += 1;
            return { status: 0, stdout: `${rows.join("\n")}\n` };
          };
        })(),
      },
      {
        label: "a scan cut short by the deadline after the known tree already exited",
        closeOnKill: "sync" as const,
        listing: () => {
          vi.setSystemTime(Date.now() + 1_001);
          return { status: 0, stdout: "4242 1 S\n5000 4242 S\n" };
        },
      },
    ])("keeps ownership unconfirmed for $label", async ({ listing, closeOnKill }) => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const { child, exited, terminate } = posixTermination(vi.fn(listing), closeOnKill);
        const outcome = terminate(true).then(() => "confirmed", (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(outcome).resolves.toMatchObject({
          code: "process-tree-termination-unconfirmed",
        });
        expect(exited.has(4_242)).toBe(true);
        expect(child.exitCode).toBe(1);
        expect(Date.now() - startedAt).toBeLessThanOrEqual(2_001);
      } finally {
        vi.useRealTimers();
      }
    });

    it("confirms a tree whose descendant snapshot stabilises just before the deadline", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        let listings = 0;
        const spawnProcessSync = vi.fn(() => {
          listings += 1;
          vi.setSystemTime(Date.now() + 499);
          return {
            status: 0,
            stdout: listings === 1 ? "4242 1 S\n5000 4242 S\n" : "4242 1 T\n5000 4242 T\n",
          };
        });
        const { terminate } = posixTermination(spawnProcessSync);
        let confirmed = false;
        void terminate(true).then(() => { confirmed = true; });
        await vi.advanceTimersByTimeAsync(2);
        expect(listings).toBe(2);
        expect(confirmed).toBe(true);
        expect(Date.now() - startedAt).toBeLessThanOrEqual(1_000);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("awaits POSIX process-group disappearance", async () => {
    const child = fakeChild();
    let running = true;
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && _pid < 0) {
        if (!running) {
          throw noSuchProcess("group gone");
        }
        return true as const;
      }
      if (signal === "SIGKILL") {
        running = false;
        child.exitCode = 1;
        queueMicrotask(() => child.emit("close", 1));
      }
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
          stdout: "4242 1 T\n",
        })) as never,
        waitMs: 100,
      },
    )).resolves.toBe(true);

    expect(killProcess).toHaveBeenCalledWith(-4_242, "SIGSTOP");
    expect(killProcess).toHaveBeenCalledWith(-4_242, "SIGKILL");
    expect(killProcess).toHaveBeenCalledWith(-4_242, 0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("confirms a killed POSIX tree whose remaining members are zombies", async () => {
    const child = fakeChild();
    const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -4_242 && signal === "SIGKILL") {
        child.exitCode = 1;
        queueMicrotask(() => child.emit("close", 1));
      }
      // A zombie remains addressable by kill(2) until an external subreaper
      // collects it, so the no-signal probe alone cannot prove cleanup.
      return true as const;
    });
    const processCanExecute = vi.fn(() => false);
    const processGroupCanExecute = vi.fn(() => false);

    await expect(terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "linux",
        killProcess,
        processCanExecute,
        processGroupCanExecute,
        spawnProcessSync: vi.fn(() => ({
          status: 0,
          stdout: "4242 1 T\n4243 4242 T\n",
        })) as never,
        waitMs: 100,
      },
    )).resolves.toBe(true);

    expect(killProcess).toHaveBeenCalledWith(-4_242, 0);
    expect(processCanExecute).toHaveBeenCalledWith(4_243);
    expect(processGroupCanExecute).toHaveBeenCalledWith(4_242);
  });

  it.each([
    { label: "reports unseen executable work", observation: true },
    { label: "is indeterminate", observation: null },
  ] as const)(
    "does not let a dead known-member snapshot override a group observer that $label",
    async ({ observation }) => {
      const child = fakeChild();
      const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -4_242 && signal === "SIGKILL") {
          child.exitCode = 1;
          queueMicrotask(() => child.emit("close", 1));
        }
        // The PGID remains signal-visible because an unseen descendant either
        // still executes or cannot be classified exactly.
        return true as const;
      });
      const processCanExecute = vi.fn(() => false);
      const processGroupCanExecute = vi.fn(() => observation);

      await expect(terminateProcessTreeAndWait(
        child as never,
        true,
        {
          platform: "linux",
          killProcess,
          processCanExecute,
          processGroupCanExecute,
          spawnProcessSync: vi.fn(() => ({
            status: 0,
            stdout: "4242 1 T\n4243 4242 T\n",
          })) as never,
          waitMs: 10,
        },
      )).resolves.toBe(false);

      expect(processCanExecute).toHaveBeenCalledWith(4_243);
      expect(processGroupCanExecute).toHaveBeenCalledWith(4_242);
    },
  );

  it.each([
    { label: "is denied", code: "EPERM", observation: true },
    { label: "fails unexpectedly", code: "EIO", observation: null },
  ] as const)(
    "does not mistake a process-group probe that $label for group absence",
    async ({ code, observation }) => {
      const child = fakeChild();
      const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -4_242 && signal === "SIGKILL") {
          child.exitCode = 1;
          queueMicrotask(() => child.emit("close", 1));
          return true as const;
        }
        if (pid === -4_242 && signal === 0) {
          const error = new Error("group probe failed") as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        return true as const;
      });

      await expect(terminateProcessTreeAndWait(
        child as never,
        true,
        {
          platform: "linux",
          killProcess,
          processCanExecute: vi.fn(() => false),
          processGroupCanExecute: vi.fn(() => observation),
          spawnProcessSync: vi.fn(() => ({
            status: 0,
            stdout: "4242 1 T\n4243 4242 T\n",
          })) as never,
          waitMs: 10,
        },
      )).resolves.toBe(false);
    },
  );

  it("does not mistake a denied detached-descendant probe for process absence", async () => {
    const child = fakeChild();
    const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -4_242 && signal === "SIGKILL") {
        child.exitCode = 1;
        queueMicrotask(() => child.emit("close", 1));
      }
      if (pid === 4_243 && signal === 0) {
        const error = new Error("process probe denied") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return true as const;
    });

    await expect(terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "linux",
        killProcess,
        processCanExecute: vi.fn(() => null),
        processGroupCanExecute: vi.fn(() => false),
        spawnProcessSync: vi.fn(() => ({
          status: 0,
          stdout: "4242 1 T\n4243 4242 T\n",
        })) as never,
        waitMs: 10,
      },
    )).resolves.toBe(false);
  });

  it("preserves the native macOS guardian termination window by default", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      let running = true;
      const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0 && pid < 0) {
          if (!running) throw noSuchProcess("group gone");
          return true as const;
        }
        return true as const;
      });
      let settled = false;
      const termination = terminateProcessTreeAndWait(
        child as never,
        false,
        { platform: "darwin", killProcess },
      ).then((confirmed) => {
        settled = true;
        return confirmed;
      });
      setTimeout(() => {
        running = false;
        child.exitCode = 0;
        child.emit("close", 0);
      }, 2_100);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      await expect(termination).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the default non-macOS termination wait bounded", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const termination = terminateProcessTreeAndWait(
        child as never,
        false,
        {
          platform: "linux",
          killProcess: vi.fn(() => true as const),
        },
      );

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(termination).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not confirm POSIX termination before the direct child closes", async () => {
    const child = fakeChild();
    let running = true;
    const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && _pid < 0) {
        if (!running) throw noSuchProcess("group gone");
        return true as const;
      }
      if (signal === "SIGKILL") running = false;
      return true as const;
    });
    let settled = false;
    const termination = terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "linux",
        killProcess,
        spawnProcessSync: vi.fn(() => ({ status: 0, stdout: "4242 1 T\n" })) as never,
        waitMs: 100,
      },
    ).then((confirmed) => {
      settled = true;
      return confirmed;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    child.exitCode = 1;
    child.emit("close", 1);
    await expect(termination).resolves.toBe(true);
  });

  it.each([
    { label: "is denied", code: "EPERM", observation: true },
    { label: "fails unexpectedly", code: "EIO", observation: null },
  ] as const)(
    "does not mistake graceful group signaling that $label for tree termination",
    async ({ code, observation }) => {
      const child = fakeChild();
      const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -4_242 && signal === "SIGTERM") {
          const error = new Error("group signal failed") as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        return true as const;
      });
      const termination = terminateProcessTreeAndWait(
        child as never,
        false,
        {
          platform: "linux",
          killProcess,
          processGroupCanExecute: vi.fn(() => observation),
          waitMs: 25,
        },
      );

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.exitCode = 1;
      child.emit("close", 1);

      await expect(termination).resolves.toBe(false);
    },
  );

  it.each([
    { label: "is absent", code: "ESRCH", observation: null },
    { label: "is non-executable", code: "EPERM", observation: false },
  ] as const)(
    "accepts direct-child closure after the graceful process group $label exactly",
    async ({ code, observation }) => {
      const child = fakeChild();
      const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -4_242 && signal === "SIGTERM") {
          const error = new Error("group signal failed") as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        return true as const;
      });
      const termination = terminateProcessTreeAndWait(
        child as never,
        false,
        {
          platform: "linux",
          killProcess,
          processGroupCanExecute: vi.fn(() => observation),
          waitMs: 25,
        },
      );

      await new Promise<void>((resolve) => setImmediate(resolve));
      child.exitCode = 1;
      child.emit("close", 1);

      await expect(termination).resolves.toBe(true);
    },
  );

  it("only probes a POSIX PGID after the owned root and stdio fully closed", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    child.stdio[1] = { closed: true };
    const killProcess = vi.fn();
    const spawnProcessSync = vi.fn();

    await expect(terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "linux",
        killProcess,
        spawnProcessSync: spawnProcessSync as never,
        waitMs: 25,
      },
    )).resolves.toBe(false);

    expect(killProcess).toHaveBeenCalledOnce();
    expect(killProcess).toHaveBeenCalledWith(-4_242, 0);
    expect(spawnProcessSync).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("accepts a closed Linux child when its extant group is zombie-only", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    child.stdio[1] = { closed: true };
    const killProcess = vi.fn(() => true as const);
    const processGroupCanExecute = vi.fn(() => false);

    await expect(terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "linux",
        killProcess,
        processGroupCanExecute,
        waitMs: 25,
      },
    )).resolves.toBe(true);

    expect(killProcess).toHaveBeenCalledOnce();
    expect(killProcess).toHaveBeenCalledWith(-4_242, 0);
    expect(processGroupCanExecute).toHaveBeenCalledWith(4_242);
  });

  it("confirms a naturally exited POSIX process group is already gone", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    child.stdio[1] = { closed: true };
    const killProcess = vi.fn(() => {
      const error = new Error("group gone") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    const spawnProcessSync = vi.fn();

    await expect(terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "linux",
        killProcess,
        spawnProcessSync: spawnProcessSync as never,
        waitMs: 25,
      },
    )).resolves.toBe(true);

    expect(killProcess).toHaveBeenCalledWith(-4_242, 0);
    expect(spawnProcessSync).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not mistake a denied POSIX process-group probe for an absent group", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    child.stdio[1] = { closed: true };
    const killProcess = vi.fn(() => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    await expect(terminateProcessTreeAndWait(
      child as never,
      true,
      {
        platform: "linux",
        killProcess,
        spawnProcessSync: vi.fn() as never,
        waitMs: 25,
      },
    )).resolves.toBe(false);

    expect(killProcess).toHaveBeenCalledWith(-4_242, 0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("reuses a live-owned POSIX termination that kills detached descendants", async () => {
    const child = fakeChild();
    child.stdio[1] = { closed: false };
    const running = new Set([4_242, 4_243]);
    const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      const target = Math.abs(pid);
      if (signal === 0) {
        if (!running.has(target)) throw noSuchProcess("process gone");
        return true as const;
      }
      if (signal === "SIGKILL") running.delete(target);
      return true as const;
    });
    const terminate = vi.fn(async (ownedChild, force: boolean) =>
      await terminateProcessTreeAndWait(ownedChild, force, {
        platform: "linux",
        killProcess,
        spawnProcessSync: vi.fn(() => ({
          status: 0,
          stdout: "4242 1 T\n4243 4242 T\n",
        })) as never,
        waitMs: 100,
      }));
    const terminateOwnedProcessTree = createOwnedProcessTreeTermination(
      child as never,
      "Provider process tree",
      terminate,
    );

    const startedWhileOwned = terminateOwnedProcessTree(true);
    child.exitCode = 0;
    child.stdio[1] = { closed: true };
    child.emit("close", 0);
    const lateAwait = terminateOwnedProcessTree(true);

    expect(lateAwait).toBe(startedWhileOwned);
    await expect(lateAwait).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledOnce();
    expect(killProcess).toHaveBeenCalledWith(4_243, "SIGKILL");
    expect(killProcess).toHaveBeenCalledWith(-4_242, "SIGKILL");
  });

  it("confirms a PID-owned POSIX tree only after descendants and the root exit", async () => {
    const running = new Set([4_242, 4_243]);
    const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      const target = Math.abs(pid);
      if (signal === 0) {
        if (!running.has(target)) throw noSuchProcess("process gone");
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
          stdout: "4242 1 T\n4243 4242 T\n",
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
          if (!running.has(Math.abs(pid))) {
            throw noSuchProcess("process gone");
          }
        }
        return true as const;
      });
      const spawnProcessSync = vi.fn(() => ({
        status: 0,
        stdout: "4242 1 T\n4243 4242 T\n",
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
          if (!running.has(Math.abs(pid))) {
            throw noSuchProcess("process gone");
          }
        }
        return true as const;
      });
      const spawnProcessSync = vi.fn(() => ({
        status: 0,
        stdout: "4242 1 T\n4243 4242 T\n",
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
