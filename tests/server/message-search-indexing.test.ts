import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MESSAGE_SEARCH_INDEX_BATCH_MS,
  MESSAGE_SEARCH_INDEX_DELAYS_MS,
  MESSAGE_SEARCH_MERGE_SLICE_MS,
  startMessageSearchIndexing,
  type MessageSearchIndexAvailability,
} from "../../src/server/runtime/message-search-indexing";
import { DatabaseWriteGate } from "../../src/server/runtime/database-write-gate";

afterEach(() => { vi.useRealTimers(); });

const openGate = () => new DatabaseWriteGate({ isDatabaseVacuuming: () => false, whenDatabaseWritable: async () => undefined });

describe("background message search indexing", () => {
  it("waits for startup, yields to interactive work and slows down while agents run", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let availability: MessageSearchIndexAvailability = "blocked";
    let remaining = true;
    const index = vi.fn(async () => ({ remaining, backfillComplete: !remaining }));
    startMessageSearchIndexing({ signal: controller.signal, writes: openGate(), index, availability: () => availability });
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.start - 1);
    expect(index).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 + MESSAGE_SEARCH_INDEX_DELAYS_MS.busy * 3);
    expect(index).not.toHaveBeenCalled();
    availability = "idle";
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.busy);
    expect(index).toHaveBeenCalledTimes(1);
    expect(index).toHaveBeenLastCalledWith({ budgetMs: MESSAGE_SEARCH_INDEX_BATCH_MS, mergeMs: MESSAGE_SEARCH_MERGE_SLICE_MS });
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.continue * 5);
    expect(index).toHaveBeenCalledTimes(6);
    availability = "busy";
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.continue);
    expect(index).toHaveBeenCalledTimes(7);
    expect(index).toHaveBeenLastCalledWith({ budgetMs: MESSAGE_SEARCH_INDEX_BATCH_MS, mergeMs: 0 });
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.busy - 1);
    expect(index).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(index).toHaveBeenCalledTimes(8);
    availability = "idle";
    remaining = false;
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.busy);
    expect(index).toHaveBeenCalledTimes(9);
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.settled - 1);
    expect(index).toHaveBeenCalledTimes(9);
    await vi.advanceTimersByTimeAsync(1);
    expect(index).toHaveBeenCalledTimes(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_INDEX_DELAYS_MS.failed * 2);
    expect(index).toHaveBeenCalledTimes(10);
  });

  it("runs every batch inside the database write gate so a full VACUUM cannot start underneath it", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let vacuuming = true;
    let finishVacuum: () => void = () => undefined;
    const gate = new DatabaseWriteGate({
      isDatabaseVacuuming: () => vacuuming,
      whenDatabaseWritable: () => new Promise<void>((resolve) => { finishVacuum = () => { vacuuming = false; resolve(); }; }),
    });
    const release: Array<() => void> = [];
    const activeDuringBatch: number[] = [];
    const index = vi.fn(() => {
      activeDuringBatch.push(gate.activeWrites());
      return new Promise<{ remaining: boolean; backfillComplete: boolean }>((resolve) => {
        release.push(() => resolve({ remaining: false, backfillComplete: true }));
      });
    });
    startMessageSearchIndexing({ signal: controller.signal, writes: gate, index, availability: () => "idle", delays: { start: 0 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(index).not.toHaveBeenCalled();
    expect(gate.activeWrites()).toBe(0);
    finishVacuum();
    await vi.advanceTimersByTimeAsync(0);
    expect(index).toHaveBeenCalledOnce();
    expect(activeDuringBatch).toEqual([1]);
    expect(gate.activeWrites()).toBe(1);
    release.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.activeWrites()).toBe(0);
    controller.abort();
  });

  it("backs off after a failed batch and stops quietly once the runtime closes", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onFailure = vi.fn();
    const index = vi.fn(async () => { throw new Error("database is closed"); });
    startMessageSearchIndexing({ signal: controller.signal, writes: openGate(), index, availability: () => "idle", onFailure, delays: { start: 0 } });
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
