import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentTurnStatus } from "../../src/shared/contracts";
import type { ActiveTurn } from "../../src/server/runtime/turns/turn-controller-types";
import {
  DEFAULT_SILENT_RETRY_WATCHDOG_MS,
  SILENT_RETRY_WATCHDOG_FAILURE_MESSAGE,
  TurnTimeoutCoordinator,
} from "../../src/server/runtime/turns/turn-timeout-coordinator";
import { AuthoritativeRunStateEngine } from "../../src/server/runtime/run-state-engine";

function makeActiveTurn(): ActiveTurn {
  return {
    runState: new AuthoritativeRunStateEngine({
      conversationId: "conv-retry-1",
      runId: "run-retry-1",
      turnId: "turn-retry-1",
      providerId: "codex",
    }),
    timeoutTimer: null,
    lifetimeTimer: null,
    conversation: { id: "conv-retry-1" },
    turn: { id: "turn-retry-1" },
  } as unknown as ActiveTurn;
}

describe("TurnTimeoutCoordinator silent-retry watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to 15 minutes and fails a turn stuck in retrying across repeated activity ticks", () => {
    expect(DEFAULT_SILENT_RETRY_WATCHDOG_MS).toBe(15 * 60 * 1_000);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    let status: AgentTurnStatus = "running";
    const cancel = vi.fn();
    const fail = vi.fn();
    const coordinator = new TurnTimeoutCoordinator({
      scheduler: {
        setTimeout: (cb, delay) => setTimeout(cb, delay),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      inactivityMs: 60_000,
      maxLifetimeMs: 60 * 60 * 1_000,
      retryWatchdogMs: 10_000,
      status: () => status,
      cancel,
      fail,
      now: Date.now,
    });
    const active = makeActiveTurn();
    coordinator.start(active);

    // Enter retrying state; repeated activity calls while still retrying must NOT reset the watchdog.
    active.runState.setTransport("retrying");
    coordinator.activity(active);
    vi.advanceTimersByTime(4_000);
    coordinator.activity(active);
    vi.advanceTimersByTime(4_000);
    coordinator.activity(active);
    expect(cancel).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(active, SILENT_RETRY_WATCHDOG_FAILURE_MESSAGE);
    expect(active.diagnosticFailureCode).toBe("turn.inactivity-timeout");
  });

  it("clears the silent-retry watchdog when substantive progress returns the turn to running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const status: AgentTurnStatus = "running";
    const cancel = vi.fn();
    const fail = vi.fn();
    const coordinator = new TurnTimeoutCoordinator({
      scheduler: {
        setTimeout: (cb, delay) => setTimeout(cb, delay),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      inactivityMs: 60_000,
      maxLifetimeMs: 60 * 60 * 1_000,
      retryWatchdogMs: 10_000,
      status: () => status,
      cancel,
      fail,
      now: Date.now,
    });
    const active = makeActiveTurn();
    active.runState.setTransport("retrying");
    coordinator.start(active);

    vi.advanceTimersByTime(8_000);
    active.runState.setTransport("running");
    coordinator.activity(active);

    vi.advanceTimersByTime(10_000);
    expect(cancel).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();

    // Entering retrying again starts a fresh 10_000ms budget.
    active.runState.setTransport("retrying");
    coordinator.activity(active);
    vi.advanceTimersByTime(9_999);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(active, SILENT_RETRY_WATCHDOG_FAILURE_MESSAGE);
  });

  it("clears the silent-retry watchdog on stop and during human wait statuses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    let status: AgentTurnStatus = "running";
    const cancel = vi.fn();
    const fail = vi.fn();
    const coordinator = new TurnTimeoutCoordinator({
      scheduler: {
        setTimeout: (cb, delay) => setTimeout(cb, delay),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      inactivityMs: 60_000,
      maxLifetimeMs: 60 * 60 * 1_000,
      retryWatchdogMs: 5_000,
      status: () => status,
      cancel,
      fail,
      now: Date.now,
    });
    const active = makeActiveTurn();
    active.runState.setTransport("retrying");
    coordinator.start(active);
    vi.advanceTimersByTime(3_000);
    status = "waiting-for-approval";
    coordinator.activity(active);
    vi.advanceTimersByTime(10_000);
    expect(fail).not.toHaveBeenCalled();

    status = "running";
    active.runState.setTransport("retrying");
    coordinator.activity(active);
    coordinator.stop(active);
    vi.advanceTimersByTime(10_000);
    expect(fail).not.toHaveBeenCalled();
  });
});
