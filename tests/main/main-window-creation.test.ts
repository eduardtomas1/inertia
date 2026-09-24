import { expect, it, vi } from "vitest";
import { MainWindowCreation } from "../../src/main/main-window-creation";

it("coalesces pending setup and checks admission again after its asynchronous boundary", async () => {
  const windows = new MainWindowCreation();
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
