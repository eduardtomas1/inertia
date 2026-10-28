import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawning = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: spawning.spawn,
}));

const ownership = vi.hoisted(() => ({
  platform: "darwin" as "darwin" | "linux" | "win32" | null,
}));
vi.mock("../../src/node/runtime-owned-processes", async (original) => ({
  ...await original<typeof import("../../src/node/runtime-owned-processes")>(),
  activeRuntimeOwnedProcessPlatform: () => ownership.platform,
}));

import { startCodexAppServerRun } from "../../src/server/codex/app-server-run";

function fixture(exitsOnEof: boolean) {
  const events: string[] = [];
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const close = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    events.push("close");
    child.emit("close", 0, null);
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk)) as { id?: number; method: string };
      if (message.id !== undefined) {
        const result = message.method === "thread/start"
          ? { thread: { id: "thread-test" } }
          : message.method === "turn/start" ? { turn: { id: "turn-test" } } : {};
        stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
      callback();
    },
    final(callback) {
      events.push("eof");
      if (exitsOnEof) setTimeout(close, 10);
      callback();
    },
  });
  Object.assign(child, {
    pid: 424242, exitCode: null, signalCode: null,
    stdin, stdout, stderr, stdio: [stdin, stdout, stderr],
  });
  spawning.spawn.mockReturnValue(child);
  const terminateProcessTree = vi.fn(async () => {
    events.push("terminate");
    close();
    return true;
  });
  const run = startCodexAppServerRun({
    executable: "/synthetic/codex", cwd: "/synthetic", environment: {},
    prompt: "Exercise natural close", access: "full", planMode: false,
    rpcTimeoutMs: 50, terminateProcessTree,
  });
  child.emit("spawn");
  return {
    events, run, terminateProcessTree,
    complete(status: "completed" | "failed" = "completed") {
      stdout.write(`${JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-test",
          turn: {
            id: "turn-test", status, items: [],
            error: status === "failed" ? { message: "The model stopped." } : null,
          },
        },
      })}\n`);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  ownership.platform = "darwin";
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("Codex App Server natural close", () => {
  it.each(["completed", "failed"] as const)("ends a %s macOS turn through EOF before stopping its guardian", async (status) => {
    const app = fixture(true);
    await vi.advanceTimersByTimeAsync(0);
    app.complete(status);
    await vi.advanceTimersByTimeAsync(20);

    await expect(app.run.result).resolves.toMatchObject({ status, cleanupConfirmed: true });
    expect(app.events).toEqual(["eof", "close", "terminate"]);
  });

  it("stops a macOS app server that ignores EOF after the bounded window", async () => {
    const app = fixture(false);
    await vi.advanceTimersByTimeAsync(0);
    app.complete();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(app.terminateProcessTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(app.run.result).resolves.toMatchObject({ status: "completed", cleanupConfirmed: true });
    expect(app.events).toEqual(["eof", "terminate", "close"]);
  });

  it("keeps the immediate strict stop where no macOS guardian owns the app server", async () => {
    ownership.platform = "linux";
    const app = fixture(true);
    await vi.advanceTimersByTimeAsync(0);
    app.complete();
    await vi.advanceTimersByTimeAsync(0);

    expect(app.terminateProcessTree).toHaveBeenCalledOnce();
    expect(app.events[0]).toBe("terminate");
    await expect(app.run.result).resolves.toMatchObject({ status: "completed" });
  });
});
