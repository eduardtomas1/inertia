// @inertia-test-suite portable
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), confirmed: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: fixture.spawn,
}));
vi.mock("../../src/server/environment", async (original) => ({
  ...await original<typeof import("../../src/server/environment")>(),
  providerEnvironment: async () => ({ env: {}, pathEntries: [] }),
}));
vi.mock("../../src/node/runtime-owned-processes", async (original) => ({
  ...await original<typeof import("../../src/node/runtime-owned-processes")>(),
  awaitRuntimeOwnedProcessStopped: fixture.confirmed,
}));

import { detectProvider } from "../../src/server/provider/discovery";
import type { ProcessTreeTerminator } from "../../src/server/process-lifecycle";

beforeEach(() => { vi.useFakeTimers(); fixture.confirmed.mockResolvedValue(true); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

function childFixture(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  return Object.assign(child, {
    pid: 424242, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
}

async function startProbe(terminateProcessTree: ProcessTreeTerminator) {
  const auth = childFixture();
  let authStarted!: () => void;
  const started = new Promise<void>((resolve) => { authStarted = resolve; });
  fixture.spawn.mockImplementation((_command: string, args: readonly string[]) => {
    const child = args[0] === "--version" ? childFixture() : auth;
    queueMicrotask(() => {
      child.emit("spawn");
      if (child === auth) authStarted();
      else {
        child.stdout.emit("data", Buffer.from("Claude Code 1.0.0\n"));
        child.emit("close", 0, null);
      }
    });
    return child;
  });
  const controller = new AbortController();
  const result = detectProvider("claude", {
    cwd: "/synthetic", timeoutMs: 1_000, signal: controller.signal,
  }, {
    executableCandidates: async () => ["/synthetic/claude"], terminateProcessTree,
  }).catch((error: unknown) => error);
  await started;
  return { auth, controller, result };
}

const authOutput = Buffer.from('{"loggedIn":true}\n');

describe("provider discovery completion during cancellation", () => {
  it("accepts normally completed authentication without a termination request", async () => {
    const terminate = vi.fn(async () => true);
    const { auth, result } = await startProbe(terminate);
    auth.stdout.emit("data", authOutput);
    auth.emit("close", 0, null);
    await expect(result).resolves.toMatchObject({ canRun: true, cleanupConfirmed: true, authState: "authenticated" });
    expect(terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("awaits ownership proof after close without sending a late stop", async () => {
    const terminate = vi.fn(async () => true);
    const { auth, controller, result } = await startProbe(terminate);
    let confirm!: (value: boolean) => void;
    fixture.confirmed.mockImplementation(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
    let settled = false;
    void result.then(() => { settled = true; });
    controller.abort();
    auth.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
    confirm(false);
    await expect(result).resolves.toMatchObject({ code: "process-tree-termination-unconfirmed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout"])("keeps %s final while a completed auth payload drains normally", async (cause) => {
    const terminate = vi.fn(async () => false);
    const { auth, controller, result } = await startProbe(terminate);
    auth.stdout.emit("data", authOutput);
    if (cause === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(1_000);
    expect(terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    auth.emit("close", 0, null);
    if (cause === "abort") {
      await expect(result).resolves.toMatchObject({ message: "Provider discovery was cancelled." });
    } else {
      await expect(result).resolves.toMatchObject({ canRun: false, cleanupConfirmed: true, authState: "unknown" });
    }
    expect(terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps uncertain natural-close ownership fatal during the drain", async () => {
    const terminate = vi.fn(async () => true);
    const { auth, controller, result } = await startProbe(terminate);
    fixture.confirmed.mockResolvedValue(false);
    controller.abort();
    auth.emit("close", null, "SIGUSR2");
    await expect(result).resolves.toMatchObject({ code: "process-tree-termination-unconfirmed" });
    expect(terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a nonclosing probe at the bound and waits for failed tree cleanup", async () => {
    let settleCleanup!: (confirmed: boolean) => void;
    const terminate = vi.fn(() => new Promise<boolean>((resolve) => { settleCleanup = resolve; }));
    const { auth, controller, result } = await startProbe(terminate);
    let settled = false;
    void result.then(() => { settled = true; });
    controller.abort();
    await vi.advanceTimersByTimeAsync(249);
    expect(terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(auth, true);
    auth.emit("close", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    settleCleanup(false);
    await expect(result).resolves.toMatchObject({ code: "process-tree-termination-unconfirmed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart the drain when abort follows a timeout", async () => {
    const terminate = vi.fn(async () => true);
    const { auth, controller, result } = await startProbe(terminate);
    await vi.advanceTimersByTimeAsync(1_100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(149);
    expect(terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ message: "Provider discovery was cancelled." });
    expect(terminate).toHaveBeenCalledExactlyOnceWith(auth, true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
