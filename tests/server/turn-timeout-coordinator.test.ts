import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentTurnStatus } from "../../src/shared/contracts";
import type {
  ActiveTurn,
  TurnTimerScheduler,
} from "../../src/server/runtime/turns/turn-controller-types";
import { TurnTimeoutCoordinator } from "../../src/server/runtime/turns/turn-timeout-coordinator";
import { AuthoritativeRunStateEngine } from "../../src/server/runtime/run-state-engine";

class FakeScheduler implements TurnTimerScheduler {
  readonly callbacks = new Map<object, () => void>();
  readonly delays = new Map<object, number>();

  setTimeout(callback: () => void, delayMs: number): object {
    const handle = {};
    this.callbacks.set(handle, callback);
    this.delays.set(handle, delayMs);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as object);
    this.delays.delete(handle as object);
  }
}

function activeTurn(): ActiveTurn {
  return {
    runState: new AuthoritativeRunStateEngine({
      conversationId: "conversation-1",
      runId: "run-1",
      turnId: "turn-1",
      providerId: "codex",
    }),
    timeoutTimer: null,
    lifetimeTimer: null,
    conversation: { id: "conversation-1" },
    turn: { id: "turn-1" },
  } as unknown as ActiveTurn;
}

function timeoutRuntime(initialStatus: AgentTurnStatus = "running") {
  const scheduler = new FakeScheduler();
  const failures: string[] = [];
  let status = initialStatus;
  let cancellations = 0;
  const coordinator = new TurnTimeoutCoordinator({
    scheduler,
    inactivityMs: 1_000,
    maxLifetimeMs: 10_000,
    status: () => status,
    cancel: () => { cancellations += 1; },
    fail: (_active, message) => { failures.push(message); },
  });
  return {
    coordinator,
    failures,
    scheduler,
    cancellations: () => cancellations,
    status: (next: AgentTurnStatus) => { status = next; },
  };
}

describe("TurnTimeoutCoordinator", () => {
  afterEach(() => { vi.useRealTimers(); });

  function observedRuntime() {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let status: AgentTurnStatus = "running";
    const reportIncident = vi.fn();
    const cancel = vi.fn(); const fail = vi.fn();
    const coordinator = new TurnTimeoutCoordinator({
      scheduler: { setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) },
      inactivityMs: 1_000, maxLifetimeMs: 10_000, observationMs: 200,
      status: () => status, cancel, fail, reportIncident, now: Date.now,
    });
    const active = activeTurn();
    coordinator.start(active);
    return { coordinator, active, cancel, fail, reportIncident, setStatus: (value: AgentTurnStatus) => { status = value; } };
  }

  it("observes one silence episode, recovers on activity, and leaves both safety deadlines intact", () => {
    const h = observedRuntime();
    const lifetime = h.active.lifetimeTimer;
    vi.advanceTimersByTime(200);
    expect(h.reportIncident).toHaveBeenCalledOnce();
    const warning = h.reportIncident.mock.calls[0]![0];
    expect(warning).toMatchObject({ code: "turn.inactivity", outcome: "observing", metadata: { silenceMs: 200 } });
    vi.advanceTimersByTime(200);
    expect(h.reportIncident).toHaveBeenCalledOnce();
    expect(h.cancel).not.toHaveBeenCalled();
    h.coordinator.activity(h.active);
    expect(h.reportIncident.mock.calls[1]![0]).toMatchObject({ id: warning.id, outcome: "recovered", metadata: { silenceMs: 400 } });
    expect(h.active.lifetimeTimer).toBe(lifetime);
    vi.advanceTimersByTime(1_000);
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.fail).toHaveBeenCalledOnce();
    expect(h.active.diagnosticFailureCode).toBe("turn.inactivity-timeout");
    h.coordinator.stop(h.active);
    expect(h.reportIncident.mock.calls.at(-1)![0].outcome).toBe("ended");
  });

  it.each(["waiting-for-approval", "waiting-for-input"] as const)("exempts %s without calling it recovery or counting its elapsed time", (status) => {
    const h = observedRuntime();
    vi.advanceTimersByTime(200);
    h.setStatus(status); h.coordinator.activity(h.active);
    expect(h.reportIncident.mock.calls.at(-1)![0].outcome).toBe("ended");
    vi.advanceTimersByTime(5_000);
    expect(h.reportIncident).toHaveBeenCalledTimes(2);
    expect(h.fail).not.toHaveBeenCalled();
    h.setStatus("running"); h.coordinator.activity(h.active);
    vi.advanceTimersByTime(199);
    expect(h.reportIncident).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(h.reportIncident.mock.calls.at(-1)![0].metadata.silenceMs).toBe(200);
  });

  it("does not warn after terminal cleanup and cannot break deadlines when observation throws", () => {
    const h = observedRuntime();
    h.reportIncident.mockImplementation(() => { throw new Error("disk unavailable"); });
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(() => vi.advanceTimersByTime(800)).not.toThrow();
    expect(h.fail).toHaveBeenCalledOnce();
    h.coordinator.stop(h.active);
    h.active.runState.settle("cancelled");
    h.coordinator.activity(h.active);
    h.reportIncident.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(h.reportIncident).not.toHaveBeenCalled();
  });
  it("refreshes provider inactivity without replacing the lifetime fail-safe", () => {
    const runtime = timeoutRuntime();
    const active = activeTurn();
    runtime.coordinator.start(active);
    const firstInactivity = active.timeoutTimer as object;
    const lifetime = active.lifetimeTimer;

    runtime.coordinator.activity(active);

    expect(active.timeoutTimer).not.toBe(firstInactivity);
    expect(active.lifetimeTimer).toBe(lifetime);
    expect(runtime.scheduler.callbacks.has(firstInactivity)).toBe(false);
    runtime.scheduler.callbacks.get(active.timeoutTimer as object)?.();
    expect(runtime.failures).toEqual([
      "The agent stopped after a prolonged period without provider activity.",
    ]);
    expect(runtime.cancellations()).toBe(1);
  });

  it("pauses inactivity while human approval or input is pending", () => {
    const runtime = timeoutRuntime("waiting-for-approval");
    const active = activeTurn();
    runtime.coordinator.start(active);

    expect(active.timeoutTimer).toBeNull();
    expect([...runtime.scheduler.delays.values()]).toEqual([10_000]);

    runtime.status("running");
    runtime.coordinator.activity(active);
    expect([...runtime.scheduler.delays.values()].sort((left, right) => left - right))
      .toEqual([1_000, 10_000]);
  });

  it("retains a bounded maximum lifetime for continuously active work", () => {
    const runtime = timeoutRuntime();
    const active = activeTurn();
    runtime.coordinator.start(active);
    runtime.coordinator.activity(active);
    const lifetime = active.lifetimeTimer as object;

    runtime.scheduler.callbacks.get(lifetime)?.();

    expect(runtime.failures).toEqual([
      "The agent reached the maximum safe runtime for one turn.",
    ]);
    expect(runtime.cancellations()).toBe(1);
  });
});
