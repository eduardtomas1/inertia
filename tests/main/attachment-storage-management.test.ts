import { expect, it, vi } from "vitest";
import { cleanupOldestAttachments, describeAttachmentStorage, type AttachmentStorageManagement } from "../../src/node/conversation-attachment-storage-management";

function management(count: number): AttachmentStorageManagement {
  const ids = Array.from({ length: count }, (_, index) => `file-${index}`);
  return { state: "ready", maxBytes: 16 * 1024 ** 3, maxRecords: 65_536,
    records: new Map(ids.map((id) => [id, 1024])), authoritative: new Set(ids), retained: new Map(), pending: new Map(),
    availableDiskBytes: async () => 100 * 1024 ** 3, removeRecord: async () => undefined };
}
it("bounds each cleanup batch and accounts for partial removal failures", async () => {
  const store = management(70);
  const order = [...store.records.keys()];
  expect(await describeAttachmentStorage(store, () => order)).toMatchObject({ removableRecords: 64, removableBytes: 64 * 1024 });
  let removed = 0;
  store.removeRecord = async () => { if (++removed === 3) throw new Error("fixture unlink failed"); };
  await expect(cleanupOldestAttachments(store, () => order)).rejects.toThrow("fixture unlink failed");
  expect(store.records.size).toBe(68);
  expect(store.authoritative.has(order[0]!)).toBe(false);
  expect(store.authoritative.has(order[2]!)).toBe(true);
  store.removeRecord = vi.fn().mockResolvedValue(undefined);
  await expect(cleanupOldestAttachments(store, () => order)).resolves.toEqual({ records: 64, bytes: 64 * 1024 });
  expect(store.records.size).toBe(4);
});

it("keeps usage unknown during reconciliation instead of reporting a full or empty store", async () => {
  const store = management(1);
  store.state = "reconciling";
  store.availableDiskBytes = async () => { throw new Error("unavailable"); };
  await expect(describeAttachmentStorage(store, () => [...store.records.keys()])).resolves.toMatchObject({
    state: "reconciling", bytes: null, records: null, availableDiskBytes: null, removableRecords: 0,
  });
});
