import type { ElectronApplication, Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

import { guardRenderedFrames } from "../e2e/support/rendered-frame";

const MAIN_PID = 4242;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

function fakeApp(evaluate: () => Promise<boolean>) {
  let handler: (() => Promise<unknown>) | undefined;
  const page = {
    evaluate: vi.fn(evaluate),
    locator: vi.fn(() => ({ selector: ":root" })),
    addLocatorHandler: vi.fn(async (_locator: unknown, registered: () => Promise<unknown>) => {
      handler = registered;
    }),
  };
  const electronApp = { process: () => ({ pid: MAIN_PID }) };
  return {
    page,
    guard: () => guardRenderedFrames(page as unknown as Page, electronApp as unknown as ElectronApplication),
    runHandler: () => handler!(),
  };
}

async function settlesWithinCallerDeadline(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(0);
  return settled;
}

describe("rendered-frame guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    execFile.mockReset();
    execFile.mockImplementation((_command: string, _args: string[], _options: unknown,
      callback: (error: Error | null, result: { stdout: string }) => void) => callback(null, { stdout: "" }));
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.useRealTimers();
  });

  it("returns control to the caller at once while the frame probe is still pending", async () => {
    const app = fakeApp(() => new Promise<boolean>(() => undefined));
    await app.guard();
    expect(await settlesWithinCallerDeadline(app.runHandler())).toBe(true);
    expect(app.page.evaluate).toHaveBeenCalledOnce();
  });

  it("keeps one frame probe in flight across repeated action checkpoints", async () => {
    const app = fakeApp(() => new Promise<boolean>(() => undefined));
    await app.guard();
    for (let index = 0; index < 3; index += 1) {
      expect(await settlesWithinCallerDeadline(app.runHandler())).toBe(true);
    }
    expect(app.page.evaluate).toHaveBeenCalledOnce();
  });

  it("inspects GPU helpers only after a probe reports missing frames", async () => {
    let reportFrames: (value: boolean) => void = () => undefined;
    const app = fakeApp(() => new Promise<boolean>((resolve) => { reportFrames = resolve; }));
    await app.guard();
    expect(await settlesWithinCallerDeadline(app.runHandler())).toBe(true);
    reportFrames(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(execFile).not.toHaveBeenCalled();
    expect(await settlesWithinCallerDeadline(app.runHandler())).toBe(true);
    reportFrames(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(execFile).toHaveBeenCalledWith("/bin/ps", ["-axww", "-o", "pid=,ppid=,stat=,command="],
      expect.anything(), expect.any(Function));
    expect(app.page.evaluate).toHaveBeenCalledTimes(2);
  });

  it("registers nothing outside macOS", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    const app = fakeApp(async () => true);
    await app.guard();
    expect(app.page.addLocatorHandler).not.toHaveBeenCalled();
  });
});
