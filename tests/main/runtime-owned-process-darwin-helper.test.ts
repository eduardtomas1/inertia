import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcess.spawn,
}));

import {
  darwinProcessGuardianReady,
  darwinProcessGuardianReadyAsync,
  readDarwinProcessIdentityAsync,
} from "../../src/node/runtime-owned-process-darwin";
import { readDarwinGuardianEscapeesAsync } from "../../src/node/runtime-owned-process-darwin-orphans";

interface FakeHelper extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function fakeHelper(pid: number | null = 7_777): FakeHelper {
  return Object.assign(new EventEmitter(), {
    pid: pid ?? undefined,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
    exitCode: null,
    signalCode: null,
  });
}

describe("macOS runtime guardian helper", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("maps only a synchronous readiness timeout to not ready", () => {
    const timedOut = vi.fn(() => ({
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      status: null, stdout: "", stderr: "",
    }));
    expect(darwinProcessGuardianReady(4_242, "/trusted/guardian", {
      platform: "darwin", spawnProcessSync: timedOut as never,
    })).toBeNull();

    const unavailable = new Error("unavailable");
    const failed = vi.fn(() => ({
      error: unavailable, status: null, stdout: "", stderr: "",
    }));
    expect(() => darwinProcessGuardianReady(4_242, "/trusted/guardian", {
      platform: "darwin", spawnProcessSync: failed as never,
    })).toThrow(unavailable);
  });

  it("accepts a readiness helper delayed beyond the former deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const helper = fakeHelper();
    childProcess.spawn.mockReturnValue(helper);

    const result = darwinProcessGuardianReadyAsync(
      4_242,
      "/trusted/runtime-process-guardian",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(helper.kill).not.toHaveBeenCalled();
    helper.stdout.emit(
      "data",
      Buffer.from("4242|101|4242|4242|1756100000|123456\n"),
    );
    helper.exitCode = 0;
    helper.emit("close", 0, null);

    await expect(result).resolves.toMatchObject({
      pid: 4_242,
      processGroupId: 4_242,
      sessionId: 4_242,
    });
  });

  it("still terminates a helper that remains live past its deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const helper = fakeHelper();
    childProcess.spawn.mockReturnValue(helper);

    const result = darwinProcessGuardianReadyAsync(
      4_242,
      "/trusted/runtime-process-guardian",
    );
    await vi.advanceTimersByTimeAsync(5_500);
    expect(helper.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await expect(result).resolves.toBeNull();
  });

  it("accepts an identity helper delayed beyond the former deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const helper = fakeHelper();
    childProcess.spawn.mockReturnValue(helper);

    const result = readDarwinProcessIdentityAsync(
      4_242,
      "/trusted/runtime-process-guardian",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(helper.kill).not.toHaveBeenCalled();
    helper.stdout.emit(
      "data",
      Buffer.from("4242|101|4242|4242|1756100000|123456\n"),
    );
    helper.exitCode = 0;
    helper.emit("close", 0, null);

    await expect(result).resolves.toMatchObject({ pid: 4_242 });
  });

  it("terminates an identity helper that exceeds its new bounded deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const helper = fakeHelper();
    childProcess.spawn.mockReturnValue(helper);

    const result = readDarwinProcessIdentityAsync(
      4_242,
      "/trusted/runtime-process-guardian",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(helper.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await expect(result).resolves.toBeNull();
  });

  it("fails after one event-loop turn when a terminal helper never publishes close", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const helper = fakeHelper();
    childProcess.spawn.mockReturnValue(helper);

    const result = darwinProcessGuardianReadyAsync(
      4_242,
      "/trusted/runtime-process-guardian",
    );
    helper.exitCode = 0;
    await vi.advanceTimersByTimeAsync(5_500);
    expect(helper.kill).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBeNull();
  });

  it("fails an aborted helper immediately even when it exited before close", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const helper = fakeHelper();
    childProcess.spawn.mockReturnValue(helper);
    const controller = new AbortController();

    const result = darwinProcessGuardianReadyAsync(
      4_242,
      "/trusted/runtime-process-guardian",
      controller.signal,
    );
    helper.exitCode = 0;
    controller.abort();

    await expect(result).resolves.toBeNull();
    expect(helper.kill).not.toHaveBeenCalled();
  });

  it("rejects oversized output after a valid helper has exited but before close", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const helper = fakeHelper();
    childProcess.spawn.mockReturnValue(helper);

    const result = darwinProcessGuardianReadyAsync(
      4_242,
      "/trusted/runtime-process-guardian",
    );
    helper.stdout.emit(
      "data",
      Buffer.from("4242|101|4242|4242|1756100000|123456\n"),
    );
    helper.exitCode = 0;
    helper.stdout.emit("data", Buffer.alloc(4 * 1024));

    await expect(result).resolves.toBeNull();
    expect(helper.kill).not.toHaveBeenCalled();
  });

  it("never signals a helper that failed to start before it has a process id", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const helper = fakeHelper(null);
    childProcess.spawn.mockReturnValue(helper);
    const controller = new AbortController();
    controller.abort();

    await expect(readDarwinProcessIdentityAsync(
      4_242,
      "/missing/runtime-process-guardian",
      controller.signal,
    )).resolves.toBeNull();
    expect(helper.kill).not.toHaveBeenCalled();
  });

  it.each([
    ["no marked process remains", 0, "", { absent: true, remaining: [] }],
    ["a marked process remains", 4, "5151|1756100001|7\n", {
      absent: false,
      remaining: [{ pid: 5_151, startTimeSeconds: "1756100001", startTimeMicroseconds: 7 }],
    }],
    ["the census failed", 2, "", { absent: null, remaining: [] }],
    ["remaining output is malformed", 4, "5151|seconds|7\n", { absent: null, remaining: [] }],
    ["an empty census reports processes", 0, "5151|1756100001|7\n", { absent: null, remaining: [] }],
  ] as const)("maps the escapee census when %s", async (_label, status, stdout, census) => {
    const helper = fakeHelper();
    childProcess.spawn.mockReturnValue(helper);
    const result = readDarwinGuardianEscapeesAsync(
      { pid: 4_242, startTimeSeconds: "1756100000", startTimeMicroseconds: 123_456 },
      "/trusted/runtime-process-guardian",
      { reap: true, timeoutMs: 1_000, platform: "darwin" },
    );
    if (stdout) helper.stdout.emit("data", Buffer.from(stdout));
    helper.exitCode = status;
    helper.emit("close", status, null);

    await expect(result).resolves.toEqual(census);
    expect(childProcess.spawn).toHaveBeenLastCalledWith(
      resolve("/trusted/runtime-process-guardian"),
      ["escapees", "4242", "1756100000", "123456", "--reap"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("treats an invalid escapee request or a signalled census as unknown", async () => {
    const guardian = { pid: 4_242, startTimeSeconds: "1756100000", startTimeMicroseconds: 123_456 };
    await expect(readDarwinGuardianEscapeesAsync({ ...guardian, pid: 1 }, "/trusted/guardian", {
      reap: false, timeoutMs: 1_000, platform: "darwin",
    })).resolves.toEqual({ absent: null, remaining: [] });
    await expect(readDarwinGuardianEscapeesAsync(guardian, "relative/guardian", {
      reap: false, timeoutMs: 1_000, platform: "darwin",
    })).resolves.toEqual({ absent: null, remaining: [] });
    const helper = fakeHelper();
    childProcess.spawn.mockReturnValue(helper);
    const result = readDarwinGuardianEscapeesAsync(guardian, "/trusted/guardian", {
      reap: false, timeoutMs: 1_000, platform: "darwin",
    });
    helper.signalCode = "SIGKILL";
    helper.emit("close", null, "SIGKILL");
    await expect(result).resolves.toEqual({ absent: null, remaining: [] });
  });
});
