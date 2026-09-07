import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawning = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: spawning.spawn,
}));

import { startCodexAppServerRun } from "../../src/server/codex/app-server-run";

function fixture(respond = true) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk)) as { id?: number; method: string };
      if (respond && message.id !== undefined) {
        const result = message.method === "thread/start"
          ? { thread: { id: "thread-test" } }
          : message.method === "turn/start" ? { turn: { id: "turn-test" } } : {};
        stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
      callback();
    },
  });
  Object.assign(child, {
    pid: 424242, exitCode: null, signalCode: null,
    stdin, stdout, stderr, stdio: [stdin, stdout, stderr],
  });
  spawning.spawn.mockReturnValue(child);
  let finishCleanup!: (confirmed: boolean) => void;
  const terminateProcessTree = vi.fn(() => new Promise<boolean>((resolve) => {
    finishCleanup = resolve;
  }));
  const onStatus = vi.fn();
  const run = startCodexAppServerRun({
    executable: "/synthetic/codex", cwd: "/synthetic", environment: {},
    prompt: "Exercise exit ordering", access: "full", planMode: false,
    rpcTimeoutMs: 50, onStatus, terminateProcessTree,
  });
  child.emit("spawn");
  return {
    child, stdin, stdout, run, onStatus, terminateProcessTree,
    observeExit(code: number | null, signal: NodeJS.Signals | null = null) {
      Object.assign(child, { exitCode: code, signalCode: signal });
      child.emit("exit", code, signal);
    },
    finishCleanup() {
      child.emit("close", child.exitCode, child.signalCode);
      finishCleanup(true);
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

async function closeTransport(app: Fixture, source: "EOF" | "write failure") {
  if (source === "EOF") {
    app.stdout.emit("end");
    await vi.advanceTimersByTimeAsync(99);
    expect(app.terminateProcessTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
  } else {
    app.stdin.emit("error", new Error("EPIPE token=super-secret-value"));
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(app.terminateProcessTree).toHaveBeenCalledExactlyOnceWith(app.child, true);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("Codex App Server exit ordering", () => {
  it.each(["EOF", "write failure"] as const)(
    "classifies an exit observed before %s and retains cleanup uncertainty",
    async (source) => {
      const app = fixture();
      await vi.advanceTimersByTimeAsync(0);
      expect(app.onStatus).toHaveBeenCalledWith("running");
      app.observeExit(7);
      await closeTransport(app, source);
      let returned = false;
      void app.run.result.then(() => { returned = true; });
      await Promise.resolve();
      expect(returned).toBe(false);
      app.finishCleanup();

      const result = await app.run.result;
      expect(result).toMatchObject({
        status: "failed", exitCode: 7, cleanupConfirmed: false,
        failure: { reason: "process-exit", phase: "running" },
      });
      expect(result.failure?.technicalDetail).toContain("Reason: process-exit");
      expect(result.failure?.technicalDetail).not.toContain("super-secret-value");
      expect(app.terminateProcessTree).toHaveBeenCalledOnce();
    },
  );

  it.each(["EOF", "write failure"] as const)(
    "preserves %s as the cause when cleanup later kills a live process",
    async (source) => {
      const app = fixture();
      await vi.advanceTimersByTimeAsync(0);
      await closeTransport(app, source);
      app.observeExit(null, "SIGKILL");
      app.finishCleanup();

      await expect(app.run.result).resolves.toMatchObject({
        status: "failed", signal: "SIGKILL", cleanupConfirmed: true,
        failure: { reason: "transport-closed" },
      });
      expect(app.terminateProcessTree).toHaveBeenCalledOnce();
    },
  );

  it.each(["malformed-protocol", "rpc-timeout"] as const)(
    "preserves an earlier %s failure when the process exits during cleanup",
    async (reason) => {
      const app = fixture(reason !== "rpc-timeout");
      await vi.advanceTimersByTimeAsync(0);
      if (reason === "malformed-protocol") app.stdout.write("{invalid-json}\n");
      else await vi.advanceTimersByTimeAsync(50);
      expect(app.terminateProcessTree).toHaveBeenCalledOnce();
      app.observeExit(7);
      app.stdin.emit("error", new Error("EPIPE"));
      app.finishCleanup();

      await expect(app.run.result).resolves.toMatchObject({
        status: "failed", exitCode: 7, failure: { reason },
      });
      expect(app.terminateProcessTree).toHaveBeenCalledOnce();
    },
  );

  it("consumes a buffered terminal event before classifying EOF", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.stdout.write(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread-test", turn: { id: "turn-test", status: "completed", items: [], error: null } },
    }));
    app.observeExit(7);
    app.stdout.emit("end");
    app.finishCleanup();

    await expect(app.run.result).resolves.toMatchObject({ status: "completed" });
    expect(app.terminateProcessTree).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
