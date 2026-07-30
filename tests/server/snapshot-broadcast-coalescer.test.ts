import { describe, expect, it, vi } from "vitest";

import {
  SnapshotBroadcastCoalescer,
  type SnapshotBroadcastScheduler,
} from "../../src/server/runtime/snapshot-broadcast-coalescer";

function fixture() {
  const callbacks = new Map<number, () => void>();
  let sequence = 0;
  const scheduler: SnapshotBroadcastScheduler = {
    setTimer: vi.fn((callback) => {
      sequence += 1;
      callbacks.set(sequence, callback);
      return sequence as unknown as ReturnType<typeof setTimeout>;
    }),
    clearTimer: vi.fn((timer) => {
      callbacks.delete(timer as unknown as number);
    }),
  };
  const broadcast = vi.fn();
  const coalescer = new SnapshotBroadcastCoalescer(
    broadcast,
    scheduler,
    32,
  );
  return { broadcast, callbacks, coalescer, scheduler };
}

describe("SnapshotBroadcastCoalescer", () => {
  it("projects a synchronous mutation burst once at the trailing boundary", () => {
    const runtime = fixture();
    runtime.coalescer.request();
    runtime.coalescer.request();
    runtime.coalescer.request();

    expect(runtime.scheduler.setTimer).toHaveBeenCalledTimes(1);
    expect(runtime.broadcast).not.toHaveBeenCalled();
    runtime.callbacks.values().next().value?.();
    expect(runtime.broadcast).toHaveBeenCalledTimes(1);
  });

  it("flushes pending work explicitly and suppresses work after close", () => {
    const runtime = fixture();
    runtime.coalescer.request();
    runtime.coalescer.flush();
    expect(runtime.broadcast).toHaveBeenCalledTimes(1);
    expect(runtime.scheduler.clearTimer).toHaveBeenCalledTimes(1);

    runtime.coalescer.request();
    runtime.coalescer.close();
    for (const callback of runtime.callbacks.values()) callback();
    runtime.coalescer.request();
    runtime.coalescer.flush();
    expect(runtime.broadcast).toHaveBeenCalledTimes(1);
  });

  it("flushes the latest state again at an acknowledged mutation boundary", () => {
    const runtime = fixture();
    runtime.coalescer.request();
    runtime.coalescer.flush();
    runtime.coalescer.flush();

    expect(runtime.scheduler.clearTimer).toHaveBeenCalledTimes(1);
    expect(runtime.broadcast).toHaveBeenCalledTimes(2);
  });
});
