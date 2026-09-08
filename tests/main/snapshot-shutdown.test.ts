import { expect, it, vi } from "vitest";
import { cleanupWithSnapshots, SnapshotCleanupUnconfirmedError } from "../../src/main/snapshot-shutdown";

it("drains the remaining owners before reporting an unconfirmed snapshot and retains it for retry", async () => {
  const snapshots = { dispose: vi.fn().mockRejectedValueOnce(new Error("worker timeout")).mockResolvedValueOnce(undefined) };
  const remaining = vi.fn(async () => true);
  await expect(cleanupWithSnapshots(snapshots, remaining)).rejects.toBeInstanceOf(SnapshotCleanupUnconfirmedError);
  expect(remaining).toHaveBeenCalledOnce();
  await expect(cleanupWithSnapshots(snapshots, remaining)).resolves.toBe(true);
  expect(snapshots.dispose).toHaveBeenCalledTimes(2);
});

it("never converts another owner's unconfirmed cleanup or rejection into success", async () => {
  await expect(cleanupWithSnapshots(null, async () => false)).resolves.toBe(false);
  const failure = new Error("runtime cleanup failed");
  await expect(cleanupWithSnapshots({ dispose: async () => { throw new Error("snapshot timeout"); } }, async () => { throw failure; })).rejects.toBe(failure);
});
