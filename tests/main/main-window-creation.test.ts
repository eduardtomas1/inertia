import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredWindowCreation } from "../../src/main/deferred-window-creation";
import { MainWindowCreation } from "../../src/main/main-window-creation";

afterEach(() => {
  vi.useRealTimers();
});

it("coalesces pending setup and checks admission again after its asynchronous boundary", async () => {
  const windows = new MainWindowCreation();
  windows.admit();
  let ready!: () => void;
  const setup = new Promise<void>((resolve) => { ready = resolve; });
  const construct = vi.fn();
  const create = vi.fn(async () => {
    await setup;
    if (windows.allowsCreation()) construct();
  });
  const first = windows.run(create);
  expect(windows.current()).toBe(first);
  expect(windows.run(create)).toBe(first);
  expect(create).toHaveBeenCalledOnce();
  windows.beginShutdown();
  ready();
  await first;
  expect(windows.current()).toBeNull();
  expect(construct).not.toHaveBeenCalled();
  await windows.run(create);
  expect(create).toHaveBeenCalledOnce();
});

it("permits a later open before shutdown, including recovery from failed setup", async () => {
  const windows = new MainWindowCreation();
  windows.admit();
  const create = vi.fn(async () => undefined);
  await windows.run(create);
  await windows.run(create);
  expect(create).toHaveBeenCalledTimes(2);
  await expect(windows.run(async () => { throw new Error("setup failed"); })).rejects.toThrow("setup failed");
  await windows.run(create);
  expect(create).toHaveBeenCalledTimes(3);
});

it("does not reopen admission when an old failed setup settles after shutdown", async () => {
  const windows = new MainWindowCreation();
  windows.admit();
  let reject!: (error: Error) => void;
  const pending = windows.run(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const failure = expect(pending).rejects.toThrow("setup failed");
  windows.beginShutdown();
  reject(new Error("setup failed"));
  await failure;
  const create = vi.fn(async () => undefined);
  await windows.run(create);
  expect(create).not.toHaveBeenCalled();
  expect(windows.allowsCreation()).toBe(false);
});

it("opens no window for an early activation before startup admits window creation", async () => {
  const windows = new MainWindowCreation();
  const create = vi.fn(async () => undefined);

  await windows.run(create);
  expect(create).not.toHaveBeenCalled();
  expect(windows.allowsCreation()).toBe(false);

  windows.admit();
  expect(windows.allowsCreation()).toBe(true);
  await windows.run(create);
  expect(create).toHaveBeenCalledOnce();
});

it("keeps window creation closed when shutdown began before startup admitted it", async () => {
  const windows = new MainWindowCreation();
  const create = vi.fn(async () => undefined);
  windows.beginShutdown();
  windows.admit();

  await windows.run(create);
  expect(create).not.toHaveBeenCalled();
  expect(windows.allowsCreation()).toBe(false);
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
