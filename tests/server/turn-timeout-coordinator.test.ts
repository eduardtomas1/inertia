import { describe, expect, it } from "vitest";

import type { AgentTurnStatus } from "../../src/shared/contracts";
import type {
  ActiveTurn,
  TurnTimerScheduler,
} from "../../src/server/runtime/turns/turn-controller-types";
import { TurnTimeoutCoordinator } from "../../src/server/runtime/turns/turn-timeout-coordinator";

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
    settled: false,
    timeoutTimer: null,
    lifetimeTimer: null,
    conversation: { id: "conversation-1" },
    turn: { id: "turn-1" },
  } as ActiveTurn;
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
