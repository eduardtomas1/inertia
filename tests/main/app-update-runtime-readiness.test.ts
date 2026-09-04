// @inertia-test-suite portable

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppUpdateRuntimeReadiness } from
  "../../src/main/app-update-runtime-readiness";
import type { RuntimeSupervisorSnapshot } from
  "../../src/main/runtime-supervisor-types";

function snapshot(
  phase: RuntimeSupervisorSnapshot["phase"],
  options: Partial<RuntimeSupervisorSnapshot> = {},
): RuntimeSupervisorSnapshot {
  return {
    phase,
    generation: 1,
    pid: phase === "ready" ? 123 : null,
    websocketUrl: phase === "ready" ? "ws://127.0.0.1:1234" : null,
    restartAttempt: 0,
    restartScheduled: false,
    lastError: null,
    ...options,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("app update runtime readiness", () => {
  it("settles only from the typed runtime-ready identity", async () => {
    const readiness = new AppUpdateRuntimeReadiness();
    const result = readiness.wait();
    let settled = false;
    void result.finally(() => { settled = true; });

    readiness.observe(snapshot("starting"));
    await Promise.resolve();
    expect(settled).toBe(false);
    readiness.observe(snapshot("ready"));

    await expect(result).resolves.toBeUndefined();
  });

  it("rejects an explicit startup failure and incomplete readiness", async () => {
    const failed = new AppUpdateRuntimeReadiness();
    const failure = failed.wait();
    failed.observe(snapshot("starting", { lastError: "database failed" }));
    await expect(failure).rejects.toThrow("database failed");

    const incomplete = new AppUpdateRuntimeReadiness();
    const result = incomplete.wait();
    incomplete.observe(snapshot("ready", { websocketUrl: null }));
    await expect(result).rejects.toThrow("identity is incomplete");
  });

  it("fails closed when no typed readiness or failure arrives", async () => {
    vi.useFakeTimers();
    const readiness = new AppUpdateRuntimeReadiness(25);
    const result = readiness.wait();
    const rejected = expect(result).rejects.toThrow("deadline expired");

    await vi.advanceTimersByTimeAsync(25);

    await rejected;
  });
});
