import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { ATTACHMENT_DISK_RESERVE_BYTES } from "../../src/shared/attachment-storage";

const disk = vi.hoisted(() => ({ available: BigInt(512 * 1024 * 1024) }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  statfs: async () => ({ bavail: disk.available, bsize: 1n }),
}));
let store: ConversationAttachmentStore | undefined;
let root: string | undefined;
afterEach(async () => { await store?.close(); if (root) await rm(root, { recursive: true, force: true }); });
it("keeps the free-disk reserve at admission without evicting existing files on low disk", async () => {
  root = await mkdtemp(join(tmpdir(), "inertia-disk-reserve-"));
  store = await ConversationAttachmentStore.open(root, { maxRecords: 1, autoRemoveOldAttachments: true });
  const data = Buffer.from("original file");
  const payload = () => { const id = randomUUID(); return { attachment: {
    id, path: id, name: "image.png", mimeType: "image/png" as const, size: data.length,
  }, bytes: data }; };
  disk.available = BigInt(ATTACHMENT_DISK_RESERVE_BYTES + 64 * 1024 + data.length);
  const retentionId = randomUUID();
  const [saved] = await store.retain([payload()], undefined, retentionId);
  store.acceptRetention(retentionId);
  disk.available -= 1n;
  await expect(store.retain([payload()], undefined, randomUUID(), () => [saved!.id])).rejects.toThrow("Not enough free disk space");
  expect(await readdir(store.directory)).toEqual([saved!.id]);
  await expect(store.usage()).resolves.toEqual({ records: 1, bytes: data.length });
});
