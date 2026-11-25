import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeDatabaseCompactionBlocker } from "../../src/server/persistence/database-compaction";
import {
  MESSAGE_SEARCH_INDEX_DELAYS_MS,
  MESSAGE_SEARCH_INDEX_SLICE_MS,
  MESSAGE_SEARCH_MERGE_SLICE_MS,
  messageSearchIndexIdle,
  startMessageSearchIndexing,
  type MessageSearchIndexIdleState,
} from "../../src/server/runtime/message-search-indexing";
import { DatabaseWriteGate } from "../../src/server/runtime/database-write-gate";

afterEach(() => { vi.useRealTimers(); });

const openGate = () => new DatabaseWriteGate({ isDatabaseVacuuming: () => false, whenDatabaseWritable: async () => undefined });

const idleState: MessageSearchIndexIdleState = {
  closed: false, safetyLocked: false, updatePreparing: false, recoveryActive: false, activeRuntimeCommands: 0,
  activeTurns: false, activeRuns: false, providerMaintenanceActive: false, backingUp: false, compacting: false,
};

describe("idle-only message search indexing", () => {
  it("indexes only while nothing else uses the database", () => {
    expect(messageSearchIndexIdle(idleState)).toBe(true);
    const busy: Array<Partial<MessageSearchIndexIdleState>> = [
      { closed: true }, { safetyLocked: true }, { updatePreparing: true }, { recoveryActive: true },
      { activeRuntimeCommands: 1 }, { activeTurns: true }, { activeRuns: true }, { providerMaintenanceActive: true },
      { backingUp: true }, { compacting: true },
    ];
    for (const change of busy) expect(messageSearchIndexIdle({ ...idleState, ...change })).toBe(false);
  });

  it("waits for startup, alternates bounded slices with event-loop yields and stops the moment the runtime is busy", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let idle = false;
    let indexRemaining = 3;
    let mergeRemaining = 2;
    const calls: string[] = [];
    const index = vi.fn((budgetMs: number) => {
      calls.push(`index:${budgetMs}`);
      indexRemaining -= 1;
      return { remaining: indexRemaining > 0, backfillComplete: indexRemaining <= 0 };
    });
    const merge = vi.fn((budgetMs: number) => {
      calls.push(`merge:${budgetMs}`);
      if (indexRemaining > 0) return false;
      mergeRemaining -= 1;
      return mergeRemaining > 0;
    });
    startMessageSearchIndexing({ signal: controller.signal, writes: openGate(), index, merge, idle: () => idle });
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.start + MESSAGE_SEARCH_INDEX_DELAYS_MS.busy * 3);
    expect(calls).toEqual([]);
    idle = true;
    index.mockImplementationOnce((budgetMs: number) => {
      calls.push(`index:${budgetMs}`);
      indexRemaining -= 1;
      idle = false;
      return { remaining: true, backfillComplete: false };
    });
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.busy);
    expect(calls).toEqual([`index:${MESSAGE_SEARCH_INDEX_SLICE_MS}`]);
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.busy * 3);
    expect(calls).toHaveLength(1);
    idle = true;
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.busy);
    expect(calls).toEqual([
      `index:${MESSAGE_SEARCH_INDEX_SLICE_MS}`,
      `index:${MESSAGE_SEARCH_INDEX_SLICE_MS}`, `merge:${MESSAGE_SEARCH_MERGE_SLICE_MS}`,
      `index:${MESSAGE_SEARCH_INDEX_SLICE_MS}`, `merge:${MESSAGE_SEARCH_MERGE_SLICE_MS}`,
      `merge:${MESSAGE_SEARCH_MERGE_SLICE_MS}`,
    ]);
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.settled);
    expect(calls.slice(6)).toEqual([`index:${MESSAGE_SEARCH_INDEX_SLICE_MS}`, `merge:${MESSAGE_SEARCH_MERGE_SLICE_MS}`]);
    controller.abort();
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.settled * 3);
    expect(calls).toHaveLength(8);
  });

  it("yields the event loop between slices so other work runs in between", async () => {
    const controller = new AbortController();
    let slices = 0;
    let interleaved = 0;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => { done = resolve; });
    const timer = setInterval(() => { interleaved += 1; }, 0);
    startMessageSearchIndexing({
      signal: controller.signal, writes: openGate(), idle: () => true, delays: { start: 0, settled: 60_000 },
      index: () => { slices += 1; const busyUntil = performance.now() + 2; while (performance.now() < busyUntil); return { remaining: slices < 20, backfillComplete: slices >= 20 }; },
      merge: () => { if (slices >= 20) done(); return false; },
    });
    await finished;
    clearInterval(timer);
    controller.abort();
    expect(slices).toBe(20);
    expect(interleaved).toBeGreaterThan(5);
  });

  it("waits for a full VACUUM, then writes through the gate without counting as work that blocks compaction", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let vacuuming = true;
    let finishVacuum: () => void = () => undefined;
    const gate = new DatabaseWriteGate({
      isDatabaseVacuuming: () => vacuuming,
      whenDatabaseWritable: () => new Promise<void>((resolve) => { finishVacuum = () => { vacuuming = false; resolve(); }; }),
    });
    const blockersDuringSlice: Array<string | null> = [];
    const index = vi.fn(() => {
      const state = {
        closed: false, updatePreparing: false, recoveryActive: false, activeTurns: false, activeRuns: false,
        providerMaintenanceActive: false, activeRuntimeCommands: 0, activeNonStorageCommands: 0, activeProviderRefreshes: 0,
        activeBackgroundWrites: gate.activeWrites(),
      };
      blockersDuringSlice.push(runtimeDatabaseCompactionBlocker("manual", state), runtimeDatabaseCompactionBlocker("idle", state));
      return { remaining: false, backfillComplete: true };
    });
    startMessageSearchIndexing({ signal: controller.signal, writes: gate, index, merge: () => false, idle: () => true, delays: { start: 0 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(index).not.toHaveBeenCalled();
    finishVacuum();
    await vi.advanceTimersByTimeAsync(0);
    expect(index).toHaveBeenCalledOnce();
    expect(blockersDuringSlice).toEqual([null, null]);
    controller.abort();
  });

  it("re-checks idleness after waiting at the gate, so a VACUUM that ends into a busy runtime does not start a slice", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let vacuuming = true;
    let idle = true;
    let finishVacuum: () => void = () => undefined;
    const gate = new DatabaseWriteGate({
      isDatabaseVacuuming: () => vacuuming,
      whenDatabaseWritable: () => new Promise<void>((resolve) => { finishVacuum = () => { vacuuming = false; resolve(); }; }),
    });
    const index = vi.fn(() => ({ remaining: false, backfillComplete: true }));
    startMessageSearchIndexing({ signal: controller.signal, writes: gate, index, merge: () => false, idle: () => idle, delays: { start: 0 } });
    await vi.advanceTimersByTimeAsync(0);
    idle = false;
    finishVacuum();
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.busy * 2);
    expect(index).not.toHaveBeenCalled();
    idle = true;
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.busy);
    expect(index).toHaveBeenCalledOnce();
    controller.abort();
  });

  it("backs off after a failed slice and stops quietly once the runtime closes", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onFailure = vi.fn();
    const index = vi.fn(() => { throw new Error("database is closed"); });
    startMessageSearchIndexing({ signal: controller.signal, writes: openGate(), index, merge: () => false, idle: () => true, onFailure, delays: { start: 0 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(index).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.failed - 1);
    expect(index).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(index).toHaveBeenCalledTimes(2);
    controller.abort();
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.failed * 2);
    expect(index).toHaveBeenCalledTimes(2);
  });
});
