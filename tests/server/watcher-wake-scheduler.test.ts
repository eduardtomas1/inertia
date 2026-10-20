import { describe, expect, it } from "vitest";

import type { AgentActivity, RuntimeMutationEvent } from "../../src/shared/contracts";
import type { WatcherWakeTrigger } from "../../src/shared/watcher";
import {
  WATCHER_QUIET_AFTER_MS,
  WATCHER_RECHECK_MS,
  WATCHER_RETRY_BASE_MS,
  WATCHER_SETTLE_DELAY_MS,
  WATCHER_STALL_TICK_MS,
  WatcherWakeScheduler,
  type WatcherWakeAttempt,
  type WatcherWakeContext,
} from "../../src/server/runtime/watcher/watcher-wake-scheduler";
import { FakeTurnScheduler } from "../support/fake-turn-provider";

const LINK = "link-1";
const WATCHED = "watched-1";
const COOLDOWN_MS = 45_000;

/** The shared fake scheduler, plus due times so tests can advance a clock. */
class ClockedScheduler extends FakeTurnScheduler {
  now = 1_000_000;
  readonly dueAt = new Map<number, number>();

  override setTimeout(callback: () => void, delayMs: number): number {
    const id = super.setTimeout(callback, delayMs);
    this.dueAt.set(id, this.now + delayMs);
    return id;
  }

  override clearTimeout(handle: unknown): void {
    super.clearTimeout(handle);
    this.dueAt.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.dueAt].filter(([, due]) => due <= target).sort(([, left], [, right]) => left - right)[0];
      if (!next) break;
      const [id, due] = next;
      this.now = Math.max(this.now, due);
      const callback = this.callbacks.get(id)!;
      this.callbacks.delete(id);
      this.delays.delete(id);
      this.dueAt.delete(id);
      callback();
    }
    this.now = target;
  }
}

interface Wake {
  linkId: string;
  trigger: WatcherWakeTrigger;
  context: WatcherWakeContext;
  at: number;
}

function harness(options: {
  attempt?: () => WatcherWakeAttempt | Promise<WatcherWakeAttempt>;
  allowance?: () => number;
} = {}) {
  const timers = new ClockedScheduler();
  const wakes: Wake[] = [];
  const quiet: number[] = [];
  const exhausted: number[] = [];
  const errors: unknown[] = [];
  const state = { busy: false };
  const scheduler = new WatcherWakeScheduler({
    scheduler: timers,
    clock: () => timers.now,
    onWake: (linkId, trigger, context) => {
      wakes.push({ linkId, trigger, context, at: timers.now });
      return options.attempt?.() ?? "started";
    },
    onQuiet: () => quiet.push(timers.now),
    isBusy: () => state.busy,
    allowance: options.allowance ?? (() => 12),
    onBudgetExhausted: () => exhausted.push(timers.now),
    cooldownMs: () => COOLDOWN_MS,
    onError: (_linkId, error) => errors.push(error),
  });
  return { timers, scheduler, wakes, quiet, exhausted, errors, state, start: timers.now };
}

let sequence = 0;
function settled(kind: AgentActivity["kind"] = "tool", status: AgentActivity["status"] = "completed"): RuntimeMutationEvent {
  sequence += 1;
  return {
    type: "agent.activity",
    activity: {
      id: `activity-${sequence}`, conversationId: WATCHED, runId: "run", turnId: "turn-1", kind,
      title: "Read", detail: null, status, createdAt: new Date().toISOString(),
    },
  };
}
const started = (turnId = "turn-1"): RuntimeMutationEvent => ({ type: "agent.started", conversationId: WATCHED, runId: "run", turnId });
const text: RuntimeMutationEvent = { type: "agent.text", conversationId: WATCHED, runId: "run", turnId: "turn-1", text: "hello" };
const reasoning: RuntimeMutationEvent = { type: "agent.reasoning", conversationId: WATCHED, runId: "run", turnId: "turn-1", text: "hmm" };
const plan: RuntimeMutationEvent = {
  type: "agent.plan.updated",
  plan: { conversationId: WATCHED, runId: "run", turnId: "turn-1", explanation: null, steps: [] },
};

describe("WatcherWakeScheduler", () => {
  it("never wakes on text, reasoning or running activity", () => {
    const { scheduler, timers, wakes } = harness();
    expect(scheduler.observe(LINK, text)).toBe(false);
    expect(scheduler.observe(LINK, reasoning)).toBe(false);
    expect(scheduler.observe(LINK, settled("tool", "running"))).toBe(false);
    expect(scheduler.observe(LINK, settled("status"))).toBe(false);
    expect(scheduler.observe(LINK, settled("reasoning"))).toBe(false);
    timers.advance(30 * 60_000);
    expect(wakes).toEqual([]);
    expect(scheduler.pendingEvents(LINK)).toBe(0);
  });

  it("waits for the settle delay and coalesces events into one wake", () => {
    const { scheduler, timers, wakes, start } = harness();
    expect(scheduler.observe(LINK, settled("tool"))).toBe(true);
    timers.advance(500);
    scheduler.observe(LINK, plan);
    timers.advance(500);
    scheduler.observe(LINK, settled("command"));
    expect(scheduler.pendingEvents(LINK)).toBe(3);
    timers.advance(WATCHER_SETTLE_DELAY_MS - 1_001);
    expect(wakes).toHaveLength(0);
    timers.advance(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ linkId: LINK, trigger: "activity", at: start + WATCHER_SETTLE_DELAY_MS });
    expect(wakes[0]!.context).toMatchObject({ final: false, events: 3 });
    expect(scheduler.pendingEvents(LINK)).toBe(0);
  });

  it("ranks an error above activity and plan when coalescing", () => {
    const { scheduler, timers, wakes } = harness();
    scheduler.observe(LINK, plan);
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes[0]!.trigger).toBe("plan");
    scheduler.wakeFinished(LINK);
    scheduler.observe(LINK, settled("tool", "failed"));
    scheduler.observe(LINK, plan);
    timers.advance(COOLDOWN_MS);
    expect(wakes[1]!.trigger).toBe("error");
  });

  it("holds the next wake until the cooldown after the previous wake ended", () => {
    const { scheduler, timers, wakes } = harness();
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    timers.advance(20_000);
    scheduler.wakeFinished(LINK);
    const endedAt = timers.now;
    timers.advance(1_000);
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes).toHaveLength(1);
    timers.advance(COOLDOWN_MS - 1_000 - WATCHER_SETTLE_DELAY_MS - 1);
    expect(wakes).toHaveLength(1);
    timers.advance(1);
    expect(wakes).toHaveLength(2);
    expect(wakes[1]!.at).toBe(endedAt + COOLDOWN_MS);
  });

  it("uses the settle delay when it ends after the cooldown", () => {
    const { scheduler, timers, wakes } = harness();
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    scheduler.wakeFinished(LINK);
    timers.advance(COOLDOWN_MS + 10_000);
    const observedAt = timers.now;
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes[1]!.at).toBe(observedAt + WATCHER_SETTLE_DELAY_MS);
  });

  it("accumulates events while a wake is in flight or the watcher is busy", () => {
    const { scheduler, timers, wakes, state } = harness();
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes).toHaveLength(1);
    for (let index = 0; index < 5; index += 1) scheduler.observe(LINK, settled());
    timers.advance(10 * 60_000);
    expect(wakes).toHaveLength(1);
    expect(scheduler.pendingEvents(LINK)).toBe(5);
    state.busy = true;
    scheduler.wakeFinished(LINK);
    timers.advance(COOLDOWN_MS + WATCHER_RECHECK_MS * 3);
    expect(wakes).toHaveLength(1);
    state.busy = false;
    timers.advance(WATCHER_RECHECK_MS);
    expect(wakes).toHaveLength(2);
    expect(wakes[1]!.context.events).toBe(5);
  });

  it("reserves the last allowance unit for the final pass and reports exhaustion once", () => {
    let allowance = 2;
    const { scheduler, timers, wakes, exhausted } = harness({ allowance: () => allowance });
    scheduler.observe(LINK, started());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes).toHaveLength(1);
    allowance = 1;
    scheduler.wakeFinished(LINK);
    scheduler.observe(LINK, settled());
    timers.advance(COOLDOWN_MS);
    scheduler.observe(LINK, settled());
    timers.advance(COOLDOWN_MS);
    expect(wakes).toHaveLength(1);
    expect(exhausted).toHaveLength(1);
    expect(scheduler.pendingEvents(LINK)).toBe(2);

    scheduler.onWatchedTurnSettled(LINK, "turn-1");
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes).toHaveLength(2);
    expect(wakes[1]).toMatchObject({ trigger: "turn-end", context: { final: true, watchedTurnId: "turn-1", events: 2 } });
  });

  it("runs the final pass while paused for the wake budget, but not while paused by the user", () => {
    const { scheduler, timers, wakes } = harness({ allowance: () => 1 });
    scheduler.observe(LINK, started());
    scheduler.pause(LINK, { finalPass: true });
    scheduler.onWatchedTurnSettled(LINK, "turn-1");
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes.map(({ trigger }) => trigger)).toEqual(["turn-end"]);

    scheduler.wakeFinished(LINK);
    scheduler.observe(LINK, started("turn-2"));
    scheduler.pause(LINK);
    scheduler.onWatchedTurnSettled(LINK, "turn-2");
    timers.advance(10 * 60_000);
    expect(wakes).toHaveLength(1);
    scheduler.resume(LINK);
    timers.advance(0);
    expect(wakes[1]).toMatchObject({ trigger: "turn-end", context: { watchedTurnId: "turn-2" } });
  });

  it("runs the final pass once per watched turn and lets resume re-grant mid-turn wakes", () => {
    let allowance = 1;
    const { scheduler, timers, wakes, exhausted } = harness({ allowance: () => allowance });
    scheduler.observe(LINK, started());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(exhausted).toHaveLength(1);
    allowance = 12;
    scheduler.resume(LINK);
    timers.advance(0);
    expect(wakes).toHaveLength(1);
    scheduler.wakeFinished(LINK);
    scheduler.onWatchedTurnSettled(LINK, "turn-1");
    scheduler.onWatchedTurnSettled(LINK, "turn-1");
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    scheduler.wakeFinished(LINK);
    scheduler.onWatchedTurnSettled(LINK, "turn-1");
    timers.advance(60_000);
    expect(wakes.filter(({ trigger }) => trigger === "turn-end")).toHaveLength(1);
  });

  it("defers due wakes while the user's own watcher turn is active", () => {
    const { scheduler, timers, wakes } = harness();
    let userTurnActive = true;
    scheduler.deferWhile(LINK, () => userTurnActive);
    scheduler.observe(LINK, settled());
    timers.advance(5 * 60_000);
    expect(wakes).toHaveLength(0);
    expect(scheduler.pendingEvents(LINK)).toBe(1);
    userTurnActive = false;
    scheduler.poke(LINK);
    timers.advance(0);
    expect(wakes).toHaveLength(1);

    scheduler.wakeFinished(LINK);
    userTurnActive = true;
    scheduler.onWatchedTurnSettled(LINK, "turn-1");
    timers.advance(60_000);
    expect(wakes).toHaveLength(1);
    userTurnActive = false;
    timers.advance(WATCHER_RECHECK_MS);
    expect(wakes[1]!.trigger).toBe("turn-end");
    scheduler.deferWhile(LINK, null);
  });

  it("marks the watched chat quiet after ten minutes without output, once", () => {
    const { scheduler, timers, quiet, start } = harness();
    scheduler.observe(LINK, started());
    timers.advance(5 * 60_000);
    scheduler.observe(LINK, text);
    const lastOutput = timers.now;
    timers.advance(WATCHER_QUIET_AFTER_MS - WATCHER_STALL_TICK_MS);
    expect(quiet).toEqual([]);
    timers.advance(2 * WATCHER_STALL_TICK_MS);
    expect(quiet).toHaveLength(1);
    expect(quiet[0]! - lastOutput).toBeGreaterThanOrEqual(WATCHER_QUIET_AFTER_MS);
    expect(quiet[0]! - lastOutput).toBeLessThan(WATCHER_QUIET_AFTER_MS + WATCHER_STALL_TICK_MS);
    timers.advance(60 * 60_000);
    expect(quiet).toHaveLength(1);

    scheduler.observe(LINK, reasoning);
    timers.advance(WATCHER_QUIET_AFTER_MS + WATCHER_STALL_TICK_MS);
    expect(quiet).toHaveLength(2);
    expect(start).toBeLessThan(quiet[0]!);
  });

  it("does not mark quiet when the watched turn is not running", () => {
    const { scheduler, timers, quiet } = harness();
    scheduler.observe(LINK, started());
    scheduler.onWatchedTurnSettled(LINK, "turn-1");
    timers.advance(60 * 60_000);
    expect(quiet).toEqual([]);
    scheduler.track("link-2", { watchedTurnId: "turn-9", watchedRunning: true });
    timers.advance(WATCHER_QUIET_AFTER_MS + WATCHER_STALL_TICK_MS);
    expect(quiet).toHaveLength(1);
  });

  it("retries transient failures with backoff and keeps the events", () => {
    const attempts: WatcherWakeAttempt[] = ["transient", "transient", "started"];
    const { scheduler, timers, wakes } = harness({ attempt: () => attempts.shift() ?? "started" });
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes).toHaveLength(1);
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_RETRY_BASE_MS - 1);
    expect(wakes).toHaveLength(1);
    timers.advance(1);
    expect(wakes).toHaveLength(2);
    expect(wakes[1]!.context.events).toBe(2);
    timers.advance(2 * WATCHER_RETRY_BASE_MS - 1);
    expect(wakes).toHaveLength(2);
    timers.advance(1);
    expect(wakes).toHaveLength(3);
    expect(wakes[2]!.context.events).toBe(2);
    expect(scheduler.pendingEvents(LINK)).toBe(0);
  });

  it("treats a thrown or rejected wake as transient and reports the error", async () => {
    let mode: "throw" | "reject" | "ok" = "throw";
    const { scheduler, timers, wakes, errors } = harness({
      attempt: () => {
        if (mode === "throw") throw new Error("held");
        if (mode === "reject") return Promise.reject(new Error("closing"));
        return Promise.resolve("started");
      },
    });
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(errors).toHaveLength(1);
    mode = "reject";
    timers.advance(WATCHER_RETRY_BASE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(2);
    mode = "ok";
    timers.advance(2 * WATCHER_RETRY_BASE_MS);
    await Promise.resolve();
    expect(wakes).toHaveLength(3);
    scheduler.observe(LINK, settled());
    timers.advance(60_000);
    expect(wakes).toHaveLength(3);
  });

  it("retries a transient final pass", () => {
    const attempts: WatcherWakeAttempt[] = ["transient", "started"];
    const { scheduler, timers, wakes } = harness({ attempt: () => attempts.shift() ?? "started" });
    scheduler.observe(LINK, started());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    scheduler.onWatchedTurnSettled(LINK, "turn-1");
    timers.advance(WATCHER_SETTLE_DELAY_MS + WATCHER_RETRY_BASE_MS);
    expect(wakes.map(({ trigger }) => trigger)).toEqual(["activity", "turn-end"]);
  });

  it("keeps an ended turn's final pass when the next turn starts and ends before it ran", () => {
    const { scheduler, timers, wakes } = harness();
    scheduler.observe(LINK, started("turn-1"));
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes).toHaveLength(1);
    scheduler.onWatchedTurnSettled(LINK, "turn-1");
    scheduler.observe(LINK, started("turn-2"));
    scheduler.onWatchedTurnSettled(LINK, "turn-2");
    scheduler.wakeFinished(LINK);
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    scheduler.wakeFinished(LINK);
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes.filter(({ trigger }) => trigger === "turn-end").map(({ context }) => context.watchedTurnId))
      .toEqual(["turn-1", "turn-2"]);
  });

  it("reports pending-count changes when a wake consumes events and when a retry puts them back", () => {
    const attempts: WatcherWakeAttempt[] = ["transient", "started"];
    const timers = new ClockedScheduler();
    const changes: number[] = [];
    const scheduler: WatcherWakeScheduler = new WatcherWakeScheduler({
      scheduler: timers,
      clock: () => timers.now,
      onWake: () => attempts.shift() ?? "started",
      onQuiet: () => undefined,
      isBusy: () => false,
      allowance: () => 12,
      onPendingChanged: (linkId) => changes.push(scheduler.pendingEvents(linkId)),
    });
    scheduler.observe(LINK, settled());
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    timers.advance(WATCHER_RETRY_BASE_MS);
    expect(changes).toEqual([0, 2, 0]);
  });

  it("drops events a skipped wake covered without cooling down", () => {
    const { scheduler, timers, wakes } = harness({ attempt: () => "skipped" });
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(scheduler.pendingEvents(LINK)).toBe(0);
    scheduler.observe(LINK, settled());
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(wakes).toHaveLength(2);
  });

  it("runs Check now without the settle delay, cooldown or budget gate", () => {
    const { scheduler, timers, wakes } = harness({ allowance: () => 1 });
    scheduler.requestWake(LINK, "manual");
    timers.advance(0);
    expect(wakes[0]).toMatchObject({ trigger: "manual", at: timers.now });
    scheduler.wakeFinished(LINK);
    scheduler.requestWake(LINK, "initial");
    timers.advance(0);
    expect(wakes[1]!.trigger).toBe("initial");
  });

  it("does not wake while paused but keeps counting, and wakes after resume", () => {
    const { scheduler, timers, wakes } = harness();
    scheduler.pause(LINK);
    scheduler.observe(LINK, settled());
    scheduler.requestWake(LINK, "manual");
    timers.advance(10 * 60_000);
    expect(wakes).toHaveLength(0);
    expect(scheduler.pendingEvents(LINK)).toBe(1);
    scheduler.resume(LINK);
    timers.advance(0);
    expect(wakes).toHaveLength(1);
  });

  it("a new watched turn re-arms the budget notice", () => {
    const { scheduler, timers, exhausted } = harness({ allowance: () => 1 });
    scheduler.observe(LINK, started("turn-1"));
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    scheduler.observe(LINK, started("turn-2"));
    timers.advance(WATCHER_SETTLE_DELAY_MS);
    expect(exhausted).toHaveLength(2);
  });

  it("forget and dispose clear every timer and ignore later calls", () => {
    const { scheduler, timers, wakes } = harness();
    scheduler.observe(LINK, started());
    scheduler.observe("link-2", started());
    expect(timers.callbacks.size).toBeGreaterThan(0);
    scheduler.forget(LINK);
    scheduler.dispose();
    expect(timers.callbacks.size).toBe(0);
    expect(scheduler.observe(LINK, settled())).toBe(false);
    scheduler.onWatchedTurnSettled(LINK, "turn-1");
    timers.advance(60 * 60_000);
    expect(wakes).toEqual([]);
  });
});
