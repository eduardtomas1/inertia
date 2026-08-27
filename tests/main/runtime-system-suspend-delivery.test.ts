import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSystemSuspendDelivery } from "../../src/main/runtime-system-suspend-delivery";
import { RuntimeSystemSuspendTracker } from "../../src/main/runtime-system-suspend-tracker";
import type { RuntimeSystemSuspendInterval } from "../../src/node/runtime-process-protocol";

const directories: string[] = [];

function statePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-suspend-delivery-"));
  directories.push(directory);
  return join(directory, "runtime-system-suspends.json");
}

function interval(
  tracker: RuntimeSystemSuspendTracker,
  suspendedAt: string,
  resumedAt: string,
): RuntimeSystemSuspendInterval {
  tracker.suspend(suspendedAt);
  return tracker.resume(resumedAt)!;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RuntimeSystemSuspendDelivery", () => {
  it("retries a rejected head with capped backoff and never lets its tail overtake", () => {
    const tracker = new RuntimeSystemSuspendTracker();
    const first = interval(
      tracker,
      "2026-08-26T10:00:00.000Z",
      "2026-08-26T10:10:00.000Z",
    );
    const second = interval(
      tracker,
      "2026-08-26T10:20:00.000Z",
      "2026-08-26T10:30:00.000Z",
    );
    const sent: RuntimeSystemSuspendInterval[] = [];
    const runtime = {
      state: { phase: "ready", generation: 1 },
      snapshot() { return this.state; },
      recordSystemSuspendInterval(candidate: RuntimeSystemSuspendInterval) {
        sent.push(candidate);
        return true;
      },
    };
    const delivery = new RuntimeSystemSuspendDelivery({
      tracker,
      runtime: () => runtime,
      initialRetryMs: 10,
      maxRetryMs: 40,
    });

    delivery.runtimeState("ready", 1);
    expect(sent).toEqual([first]);
    delivery.result(first.id, 1, false);
    delivery.runtimeState("ready", 1);
    delivery.sendIfReady();
    delivery.sendIfReady();
    vi.advanceTimersByTime(9);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([first, first]);
    delivery.result(first.id, 1, false);
    vi.advanceTimersByTime(20);
    expect(sent).toEqual([first, first, first]);
    delivery.result(first.id, 1, false);
    vi.advanceTimersByTime(40);
    expect(sent).toEqual([first, first, first, first]);
    delivery.result(first.id, 1, false);
    vi.advanceTimersByTime(40);
    expect(sent).toEqual([first, first, first, first, first]);

    delivery.result(first.id, 1, true);
    expect(sent.at(-1)).toEqual(second);
    delivery.result(second.id, 1, false);
    vi.advanceTimersByTime(9);
    expect(sent.at(-1)).toEqual(second);
    vi.advanceTimersByTime(1);
    expect(sent.slice(-2)).toEqual([second, second]);
  });

  it("cancels retries while unavailable and resets backoff for a replacement generation", () => {
    const tracker = new RuntimeSystemSuspendTracker();
    const pending = interval(
      tracker,
      "2026-08-26T10:00:00.000Z",
      "2026-08-26T10:10:00.000Z",
    );
    const sent: Array<{ generation: number; interval: RuntimeSystemSuspendInterval }> = [];
    const runtime = {
      state: { phase: "ready", generation: 1 },
      snapshot() { return this.state; },
      recordSystemSuspendInterval(candidate: RuntimeSystemSuspendInterval) {
        sent.push({ generation: this.state.generation, interval: candidate });
        return true;
      },
    };
    const delivery = new RuntimeSystemSuspendDelivery({
      tracker,
      runtime: () => runtime,
      initialRetryMs: 10,
      maxRetryMs: 40,
    });

    delivery.runtimeState("ready", 1);
    delivery.result(pending.id, 1, false);
    runtime.state = { phase: "restarting", generation: 1 };
    delivery.runtimeState("restarting", 1);
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);

    runtime.state = { phase: "ready", generation: 2 };
    delivery.runtimeState("ready", 2);
    expect(sent.at(-1)).toEqual({ generation: 2, interval: pending });
    delivery.result(pending.id, 1, false);
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(2);
    runtime.state = { phase: "restarting", generation: 2 };
    delivery.runtimeState("restarting", 2);
    runtime.state = { phase: "ready", generation: 3 };
    delivery.runtimeState("ready", 3);
    expect(sent.at(-1)).toEqual({ generation: 3, interval: pending });
    delivery.result(pending.id, 2, true);
    expect(sent).toHaveLength(3);
    delivery.result(pending.id, 3, false);
    vi.advanceTimersByTime(9);
    expect(sent).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(4);

    delivery.result(pending.id, 3, false);
    delivery.close();
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(4);
  });

  it("replays the durable rejected head after the app restarts", () => {
    const path = statePath();
    const firstTracker = new RuntimeSystemSuspendTracker({ statePath: path });
    const pending = interval(
      firstTracker,
      "2026-08-26T10:00:00.000Z",
      "2026-08-26T10:10:00.000Z",
    );
    const firstRuntime = {
      snapshot: () => ({ phase: "ready", generation: 1 }),
      recordSystemSuspendInterval: vi.fn(() => true),
    };
    const firstDelivery = new RuntimeSystemSuspendDelivery({
      tracker: firstTracker,
      runtime: () => firstRuntime,
      initialRetryMs: 10,
    });
    firstDelivery.runtimeState("ready", 1);
    firstDelivery.result(pending.id, 1, false);
    firstDelivery.close();

    const recoveredTracker = new RuntimeSystemSuspendTracker({ statePath: path });
    const recoveredRuntime = {
      snapshot: () => ({ phase: "ready", generation: 1 }),
      recordSystemSuspendInterval: vi.fn(() => true),
    };
    const recoveredDelivery = new RuntimeSystemSuspendDelivery({
      tracker: recoveredTracker,
      runtime: () => recoveredRuntime,
    });
    recoveredDelivery.runtimeState("ready", 1);
    expect(recoveredRuntime.recordSystemSuspendInterval)
      .toHaveBeenCalledWith(pending);
    recoveredDelivery.result(pending.id, 1, true);
    expect(new RuntimeSystemSuspendTracker({ statePath: path }).completed())
      .toEqual([]);
  });
});
