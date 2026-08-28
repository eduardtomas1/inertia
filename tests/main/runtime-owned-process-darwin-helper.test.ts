import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcess.spawn,
}));

import { darwinProcessGuardianReadyAsync } from "../../src/node/runtime-owned-process-darwin";

interface FakeHelper extends EventEmitter {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function fakeHelper(): FakeHelper {
  return Object.assign(new EventEmitter(), {
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

  it("accepts an in-deadline helper exit whose pipe close is observed after the timer", async () => {
    vi.useFakeTimers();
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

    vi.advanceTimersByTime(1_500);
    expect(helper.kill).not.toHaveBeenCalled();
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
    vi.advanceTimersByTime(1_500);
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
    vi.advanceTimersByTime(1_500);
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
});
