import { afterEach, describe, expect, it, vi } from "vitest";

import { openCodeEventSubscriptionAcknowledged } from "../../src/server/provider/opencode-event-stream";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("OpenCode event subscription acknowledgement", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a late acknowledgement inside the bound", async () => {
    vi.useFakeTimers();
    const acknowledgement = deferred();
    const stop = deferred();
    let settled: boolean | undefined;
    void openCodeEventSubscriptionAcknowledged(acknowledgement.promise, 1_000, stop.promise)
      .then((value) => { settled = value; });

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBeUndefined();
    acknowledgement.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up exactly at the bound and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const acknowledgement = deferred();
    const stop = deferred();
    let settled: boolean | undefined;
    void openCodeEventSubscriptionAcknowledged(acknowledgement.promise, 1_000, stop.promise)
      .then((value) => { settled = value; });

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    acknowledgement.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
  });

  it("rejects when the event stream fails before acknowledging", async () => {
    vi.useFakeTimers();
    const acknowledgement = deferred();
    const stop = deferred();
    const waiting = openCodeEventSubscriptionAcknowledged(acknowledgement.promise, 1_000, stop.promise);
    const outcome = waiting.then(() => null, (error: unknown) => error);

    stop.reject(new Error("OpenCode closed its event stream before the session completed."));

    expect(await outcome).toEqual(new Error("OpenCode closed its event stream before the session completed."));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at once when the run is interrupted during the wait", async () => {
    vi.useFakeTimers();
    const acknowledgement = deferred();
    const pump = deferred();
    const interrupted = deferred();
    const outcome = openCodeEventSubscriptionAcknowledged(
      acknowledgement.promise,
      1_000,
      pump.promise,
      interrupted.promise,
    ).then(() => null, (error: unknown) => error);

    interrupted.reject(new Error("OpenCode acknowledged session cancellation."));

    expect(await outcome).toEqual(new Error("OpenCode acknowledged session cancellation."));
    expect(vi.getTimerCount()).toBe(0);
  });
});
