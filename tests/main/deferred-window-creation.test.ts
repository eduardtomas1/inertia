import { afterEach, describe, expect, it, vi } from "vitest";

import { DeferredWindowCreation } from "../../src/main/deferred-window-creation";

afterEach(() => {
  vi.useRealTimers();
});

describe("deferred main window creation", () => {
  it("creates the window once when startup releases it before the limit", async () => {
    vi.useFakeTimers();
    const createWindow = vi.fn(async () => undefined);
    const deferred = new DeferredWindowCreation(createWindow, 100);

    await vi.advanceTimersByTimeAsync(40);
    expect(createWindow).not.toHaveBeenCalled();
    await expect(deferred.start()).resolves.toBeUndefined();
    expect(createWindow).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(200);
    await deferred.start();
    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("creates the window at the limit when startup work is still pending", async () => {
    vi.useFakeTimers();
    let finishWindow!: () => void;
    const createWindow = vi.fn(() => new Promise<void>((resolve) => {
      finishWindow = resolve;
    }));
    const deferred = new DeferredWindowCreation(createWindow, 100);

    await vi.advanceTimersByTimeAsync(99);
    expect(createWindow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(createWindow).toHaveBeenCalledOnce();

    let started = false;
    const start = deferred.start().then(() => {
      started = true;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    finishWindow();
    await start;
    expect(started).toBe(true);
    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("reports a window failure from the limit to the later startup release only", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const failure = new Error("window failed");
      const deferred = new DeferredWindowCreation(async () => {
        throw failure;
      }, 100);

      await vi.advanceTimersByTimeAsync(100);
      vi.useRealTimers();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(deferred.start()).rejects.toBe(failure);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
