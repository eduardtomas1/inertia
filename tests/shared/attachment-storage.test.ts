import { expect, it } from "vitest";
import { clientCommandSchema } from "../../src/shared/contracts";
import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";
import { parseAttachmentStorageGiB } from "../../src/shared/attachment-storage";

it("bounds disk settings and validates storage results at the runtime boundary", () => {
  const requestId = "00000000-0000-4000-8000-000000000001";
  for (const value of [2, 4, 8, 16, 32, 64]) expect(clientCommandSchema.safeParse({
    type: "settings.update", requestId, payload: { attachmentStorageGiB: value },
  }).success).toBe(true);
  for (const value of [0, 3, 65, 1e20, "64", null]) {
    expect(clientCommandSchema.safeParse({ type: "settings.update", requestId, payload: { attachmentStorageGiB: value } }).success).toBe(false);
    expect(parseAttachmentStorageGiB(value)).toBe(16);
  }
  const storage = { state: "ready", bytes: 2, records: 1, maxBytes: 16 * 1024 ** 3, maxRecords: 65_536,
    availableDiskBytes: null, removableBytes: 2, removableRecords: 1 };
  const event = { type: "request.result", requestId, result: { kind: "attachment.storage", storage } };
  expect(serverEventSchema.safeParse(event).success).toBe(true);
  expect(serverEventSchema.safeParse({ ...event, result: { ...event.result, storage: { ...storage, bytes: -1 } } }).success).toBe(false);
  expect(clientCommandSchema.safeParse({ type: "attachment.storage.cleanup", requestId, path: "/arbitrary" }).success).toBe(false);
});
