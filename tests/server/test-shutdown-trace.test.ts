import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runtimeProcessEnvironment } from "../../src/main/runtime-process-environment";
import type { RunningRuntime } from "../../src/server/runtime-types";
import { runRuntimeShutdownPhases, RuntimeShutdownDeadlineError } from "../../src/server/runtime-shutdown";
import { completeRuntimeWorkerShutdown } from "../../src/server/runtime-worker-shutdown";
import { createTestShutdownTrace, TEST_SHUTDOWN_TRACE_BYTES, TEST_SHUTDOWN_TRACE_FILE } from "../../src/server/runtime/test-shutdown-trace";
import { captureBoundedFailureDiagnostic } from "../helpers/bounded-failure-diagnostic";

describe("runtime shutdown test diagnostics", () => {
  let directory: string;
  const file = () => join(directory, TEST_SHUTDOWN_TRACE_FILE);
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "inertia-shutdown-trace-"));
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INERTIA_RUNTIME_SHUTDOWN_TRACE", "1");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires the exact test-only enable flag through the sanitized worker environment", () => {
    for (const [nodeEnv, flag] of [["production", "1"], ["test", "0"], ["test", "true"]]) {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("INERTIA_RUNTIME_SHUTDOWN_TRACE", flag);
      const trace = createTestShutdownTrace(directory);
      expect(trace.observe("clients", () => 42)).toBe(42);
      trace.failure("server cleanup");
      expect(existsSync(file())).toBe(false);
      expect(runtimeProcessEnvironment(process.env).INERTIA_RUNTIME_SHUTDOWN_TRACE).toBeUndefined();
    }
    expect(runtimeProcessEnvironment({ NODE_ENV: "test", INERTIA_RUNTIME_SHUTDOWN_TRACE: "1" })
      .INERTIA_RUNTIME_SHUTDOWN_TRACE).toBe("1");
  });

  it("returns the original promise and preserves invocation order, values and error identity", async () => {
    const trace = createTestShutdownTrace(directory);
    const calls: string[] = [];
    const original = new Error("private path or command");
    const operation = Promise.resolve(42);
    expect(trace.observe("terminals", () => { calls.push("terminal"); return operation; })).toBe(operation);
    expect(trace.observe("clients", () => { calls.push("client"); return 7; })).toBe(7);
    expect(calls).toEqual(["terminal", "client"]);
    let caught: unknown;
    try { trace.observe("store", () => { throw original; }); }
    catch (error) { caught = error; }
    expect(caught).toBe(original);
    const rejected = Promise.reject(original);
    expect(trace.observe("maintenance", () => rejected)).toBe(rejected);
    await expect(rejected).rejects.toBe(original);
    await expect(operation).resolves.toBe(42);
    trace.failure("database cleanup");
    const payload = JSON.parse(readFileSync(file(), "utf8"));
    expect(payload.deadlinePhase).toBe("database cleanup");
    expect(payload.owners.map((entry: { state: string }) => entry.state))
      .toEqual(["settled", "settled", "rejected", "rejected"]);
    expect(JSON.stringify(payload)).not.toMatch(/private|command|path/u);
  });

  it("caps records and bytes, drops arbitrary labels and retains the first failure file", () => {
    const trace = createTestShutdownTrace(directory);
    trace.observe("private owner" as "store", () => undefined);
    for (let index = 0; index < 100; index += 1) trace.observe("store", () => undefined);
    trace.failure("private phase");
    const raw = readFileSync(file(), "utf8");
    expect(JSON.parse(raw).owners).toHaveLength(32);
    expect(JSON.parse(raw).deadlinePhase).toBeNull();
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(TEST_SHUTDOWN_TRACE_BYTES);
    expect(raw).not.toMatch(/private|directory|pid|wallTime|command/u);
    trace.failure("database cleanup");
    expect(readFileSync(file(), "utf8")).toBe(raw);
  });

  it("retains the hung owner and original deadline phase before the worker failure event", async () => {
    vi.useFakeTimers();
    const trace = createTestShutdownTrace(directory);
    const store = vi.fn();
    let original: unknown;
    const runtime = { close: async () => {
      try {
        await runRuntimeShutdownPhases({
          independentDrains: [() => trace.observe("terminals", () => new Promise<void>(() => undefined))],
          stopIsolatedRuns: () => trace.observe("isolated-runs", () => undefined),
          disposeTurnsAndProviders: () => trace.observe("turns-providers", () => undefined),
          settleArtifacts: () => undefined, terminateClients: () => undefined,
          closeServer: () => undefined, closeStore: store,
        }, 25);
      } catch (error) {
        original = error;
        trace.failure(error instanceof RuntimeShutdownDeadlineError ? error.phase : null);
        throw error;
      }
    } } as RunningRuntime;
    const post = vi.fn((event: unknown) => {
      // This synchronous read runs at the exact point the real supervisor can
      // receive shutdown-unconfirmed and force-terminate this worker.
      expect(event).toEqual({ type: "runtime.shutdown-unconfirmed", reason: "runtime-close-deadline" });
      const record = JSON.parse(readFileSync(file(), "utf8"));
      expect(record.deadlinePhase).toBe("owned-resource cleanup");
      expect(record.owners[0]).toMatchObject({ owner: "terminals", state: "started", endMs: null });
      expect(record.owners.slice(1).map((entry: { state: string }) => entry.state)).toEqual(["settled", "settled"]);
    });
    const exit = vi.fn();
    const shutdown = completeRuntimeWorkerShutdown({ runtime, cause: "runtime-shutdown", exitCode: 0,
      closeBrokers: () => undefined, post, awaitStoppedAcknowledgement: async () => undefined, exit });
    await vi.advanceTimersByTimeAsync(25);
    await shutdown;
    expect(original).toBeInstanceOf(RuntimeShutdownDeadlineError);
    expect(post).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cannot replace an original failure when the synchronous sink refuses the write", () => {
    writeFileSync(file(), "existing evidence");
    const original = new RuntimeShutdownDeadlineError("server cleanup");
    const trace = createTestShutdownTrace(directory);
    let caught: unknown;
    try {
      try { throw original; }
      catch (error) { trace.failure(original.phase); throw error; }
    } catch (error) { caught = error; }
    expect(caught).toBe(original);
    expect(readFileSync(file(), "utf8")).toBe("existing evidence");
  });

  it.each([true, false])("bounds the owned child and preserves its file (failure marker: %s)", async (emitMarker) => {
    const helperUrl = pathToFileURL(join(import.meta.dirname, "../../src/server/runtime/test-shutdown-trace.ts")).href;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { createTestShutdownTrace } from ${JSON.stringify(helperUrl)};
      const trace = createTestShutdownTrace(${JSON.stringify(directory)});
      trace.observe("http-server", () => new Promise(() => {}));
      trace.failure("server cleanup");
      if (${emitMarker}) process.send("shutdown-unconfirmed");
      setInterval(() => {}, 1000);
    `], { env: { ...process.env }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const closed = once(child, "close");
    const markerWait = new AbortController();
    try {
      const message = await captureBoundedFailureDiagnostic(async () =>
        await Promise.race([once(child, "message", { signal: markerWait.signal }), closed]),
      emitMarker ? 2_000 : 200);
      if (emitMarker) {
        expect(message.outcome).toBe("captured");
        if (message.outcome === "captured") expect(message.value[0]).toBe("shutdown-unconfirmed");
      } else {
        expect(message.outcome).toBe("timed-out");
      }
    } finally {
      markerWait.abort();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      const stopped = await captureBoundedFailureDiagnostic(() => closed, 2_000);
      expect(stopped.outcome).toBe("captured");
    }
    if (emitMarker) {
      const record = JSON.parse(readFileSync(file(), "utf8"));
      expect(record.deadlinePhase).toBe("server cleanup");
      expect(record.owners).toEqual([{ owner: "http-server", startMs: expect.any(Number), endMs: null, state: "started" }]);
    }
  });
});
