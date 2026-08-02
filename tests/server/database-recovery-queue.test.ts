import { describe, expect, it } from "vitest";

import { DatabaseRecoveryOperationQueue } from "../../src/server/runtime/database-recovery-queue";

describe("database recovery operation serialization", () => {
  it("does not overlap imports/exports and continues after a failed operation", async () => {
    const queue = new DatabaseRecoveryOperationQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstBlocked;
      events.push("first:end");
      throw new Error("injected failure");
    });
    const second = queue.enqueue(async () => {
      events.push("second:start");
      events.push("second:end");
      return "complete";
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("injected failure");
    await expect(second).resolves.toBe("complete");
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });
});
