import { describe, expect, it, vi } from "vitest";

import { AsyncCleanupCoordinator } from
  "../helpers/async-cleanup-coordinator";
import { completeDesktopBenchmarkShutdown } from
  "../helpers/desktop-benchmark-app-shutdown";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("desktop benchmark cleanup ownership", () => {
  it("coalesces concurrent cleanup and closes a resource exactly once", async () => {
    const release = deferred<string>();
    const close = vi.fn(async () => await release.promise);
    const coordinator = new AsyncCleanupCoordinator(close);
    const acquisition = coordinator.beginAcquisition();
    const ownership = acquisition.adopt({ name: "cold" });

    const first = coordinator.cleanup();
    const second = coordinator.cleanup();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    release.resolve("closed");

    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(ownership.close()).resolves.toBe("closed");
    expect(close).toHaveBeenCalledOnce();
    expect(coordinator.ownedResources).toBe(0);
  });

  it("drains an acquisition that completes after cleanup starts", async () => {
    const close = vi.fn(async () => "closed");
    const coordinator = new AsyncCleanupCoordinator(close);
    const acquisition = coordinator.beginAcquisition();
    const cleanup = coordinator.cleanup();

    expect(() => acquisition.adopt({ name: "late" })).toThrow(
      "Resource acquisition completed after cleanup started.",
    );

    await expect(cleanup).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(coordinator.ownedResources).toBe(0);
    expect(() => coordinator.beginAcquisition()).toThrow(
      "Resource acquisition cannot begin after cleanup started.",
    );
  });

  it("keeps teardown pending until a launch adopts after the body timeout", async () => {
    const launch = deferred<{ name: string }>();
    const close = vi.fn(async () => "closed");
    const coordinator = new AsyncCleanupCoordinator(close);
    const acquisition = coordinator.beginAcquisition();
    const launchContinuation = launch.promise.then((resource) =>
      acquisition.adopt(resource));
    let cleanupSettled = false;
    const cleanup = coordinator.cleanup().finally(() => {
      cleanupSettled = true;
    });

    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    expect(close).not.toHaveBeenCalled();

    launch.resolve({ name: "late-electron" });
    await expect(launchContinuation).rejects.toThrow(
      "Resource acquisition completed after cleanup started.",
    );
    await expect(cleanup).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(coordinator.ownedResources).toBe(0);
  });

  it("retains failed close ownership and retries it", async () => {
    let allowClose = false;
    const close = vi.fn(async () => {
      if (!allowClose) throw new Error("exit not confirmed");
      return "closed";
    });
    const coordinator = new AsyncCleanupCoordinator(close, {
      closeAttempts: 1,
    });
    coordinator.beginAcquisition().adopt({ name: "runtime" });

    await expect(coordinator.cleanup()).rejects.toThrow(
      "Failed to close 1 owned cleanup resource(s).",
    );
    expect(coordinator.ownedResources).toBe(1);

    allowClose = true;
    await expect(coordinator.cleanup()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    expect(coordinator.ownedResources).toBe(0);
  });

  it("uses the current quit-time runtime PID instead of an older sample", async () => {
    const resource = { runtimePid: 41 };
    const waitForRuntimeExit = vi.fn(async () => undefined);
    const times = [100, 125];

    const result = await completeDesktopBenchmarkShutdown(resource, {
      quit: async () => ({
        outcome: "graceful" as const,
        requestResult: {
          status: "fulfilled" as const,
          value: { phase: "ready", pid: 73 },
        },
        transportSettled: true,
      }),
      waitForRuntimeExit,
      now: () => times.shift() ?? 125,
    });

    expect(waitForRuntimeExit).toHaveBeenCalledWith(73);
    expect(resource.runtimePid).toBe(73);
    expect(result).toEqual({
      durationMs: 25,
      outcome: "graceful",
      transportSettled: true,
      runtimePid: 73,
    });
  });

  it("falls back to the sampled PID when the bounded quit request rejects", async () => {
    const resource = { runtimePid: 41 };
    const waitForRuntimeExit = vi.fn(async () => undefined);

    await completeDesktopBenchmarkShutdown(resource, {
      quit: async () => ({
        outcome: "forced" as const,
        requestResult: {
          status: "rejected" as const,
          reason: new Error("main context unavailable"),
        },
        transportSettled: false,
      }),
      waitForRuntimeExit,
    });

    expect(waitForRuntimeExit).toHaveBeenCalledWith(41);
  });

  it("accepts a current no-runtime snapshot over an obsolete sampled PID", async () => {
    const resource = { runtimePid: 41 };
    const waitForRuntimeExit = vi.fn(async () => undefined);

    const result = await completeDesktopBenchmarkShutdown(resource, {
      quit: async () => ({
        outcome: "graceful" as const,
        requestResult: {
          status: "fulfilled" as const,
          value: {
            phase: "stopped",
            pid: null,
            lastError: null,
            restartScheduled: false,
          },
        },
        transportSettled: true,
      }),
      waitForRuntimeExit,
    });

    expect(resource.runtimePid).toBeNull();
    expect(result.runtimePid).toBeNull();
    expect(waitForRuntimeExit).not.toHaveBeenCalled();
  });

  it("does not accept an unavailable null PID over an exact sample", async () => {
    const resource = { runtimePid: 41 };
    const waitForRuntimeExit = vi.fn(async () => undefined);

    await completeDesktopBenchmarkShutdown(resource, {
      quit: async () => ({
        outcome: "forced" as const,
        requestResult: {
          status: "fulfilled" as const,
          value: { phase: "unavailable", pid: null },
        },
        transportSettled: false,
      }),
      waitForRuntimeExit,
    });

    expect(resource.runtimePid).toBe(41);
    expect(waitForRuntimeExit).toHaveBeenCalledWith(41);
  });

  it("does not accept a stopped but unconfirmed snapshot over an exact sample", async () => {
    const resource = { runtimePid: 41 };
    const waitForRuntimeExit = vi.fn(async () => undefined);

    await completeDesktopBenchmarkShutdown(resource, {
      quit: async () => ({
        outcome: "forced" as const,
        requestResult: {
          status: "fulfilled" as const,
          value: {
            phase: "stopped",
            pid: null,
            lastError: "A prior runtime generation remains quarantined.",
            restartScheduled: false,
          },
        },
        transportSettled: true,
      }),
      waitForRuntimeExit,
    });

    expect(resource.runtimePid).toBe(41);
    expect(waitForRuntimeExit).toHaveBeenCalledWith(41);
  });

  it("rejects shutdown ownership when neither current nor sampled PID is known", async () => {
    const waitForRuntimeExit = vi.fn(async () => undefined);

    await expect(completeDesktopBenchmarkShutdown(
      { runtimePid: null },
      {
        quit: async () => ({
          outcome: "forced" as const,
          requestResult: { status: "timed-out" as const },
          transportSettled: false,
        }),
        waitForRuntimeExit,
      },
    )).rejects.toThrow(
      "Desktop benchmark shutdown could not identify the current utility-runtime PID.",
    );
    expect(waitForRuntimeExit).not.toHaveBeenCalled();
  });

  it("propagates an unconfirmed runtime exit so the coordinator can retry", async () => {
    const waitForRuntimeExit = vi.fn()
      .mockRejectedValueOnce(new Error("runtime still alive"))
      .mockResolvedValueOnce(undefined);
    const resource = { runtimePid: null };
    const close = async () => await completeDesktopBenchmarkShutdown(resource, {
      quit: async () => ({
        outcome: "forced" as const,
        requestResult: {
          status: "fulfilled" as const,
          value: { phase: "stopping", pid: 91 },
        },
        transportSettled: true,
      }),
      waitForRuntimeExit,
    });
    const coordinator = new AsyncCleanupCoordinator(close);
    coordinator.beginAcquisition().adopt(resource);

    await expect(coordinator.cleanup()).resolves.toBeUndefined();

    expect(waitForRuntimeExit).toHaveBeenCalledTimes(2);
    expect(coordinator.ownedResources).toBe(0);
  });
});
