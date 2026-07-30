import { describe, expect, it, vi } from "vitest";

import type { RunningRuntime } from "../../src/server";
import { completeRuntimeWorkerShutdown } from "../../src/server/runtime-worker-shutdown";

function runtimeWithClose(
  close: RunningRuntime["close"],
): RunningRuntime {
  return {
    websocketUrl: "ws://127.0.0.1:1/runtime/test",
    resolveProjectPath: vi.fn(),
    close,
  };
}

describe("runtime worker shutdown", () => {
  it("reports stopped and exits only after runtime cleanup succeeds", async () => {
    const post = vi.fn();
    const exit = vi.fn();
    const closeBrokers = vi.fn();

    await completeRuntimeWorkerShutdown({
      runtime: runtimeWithClose(vi.fn(async () => undefined)),
      cause: "runtime-shutdown",
      exitCode: 0,
      closeBrokers,
      post,
      exit,
    });

    expect(closeBrokers).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ type: "runtime.stopped" });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps the utility alive when a late-started runtime cannot confirm cleanup", async () => {
    const post = vi.fn();
    const exit = vi.fn();
    const closeBrokers = vi.fn();

    await completeRuntimeWorkerShutdown({
      runtime: runtimeWithClose(vi.fn(async () => {
        throw new Error("terminal tree still alive");
      })),
      cause: "runtime-shutdown",
      exitCode: 0,
      closeBrokers,
      post,
      exit,
    });

    expect(closeBrokers).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({
      type: "runtime.shutdown-unconfirmed",
    });
    expect(post).not.toHaveBeenCalledWith({ type: "runtime.stopped" });
    expect(exit).not.toHaveBeenCalled();
  });
});
