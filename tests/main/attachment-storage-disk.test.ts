import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentRegistry } from "../../src/main/attachment-registry";
import { AttachmentUploadStream } from "../../src/main/attachment-upload-stream";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { ATTACHMENT_UPLOAD_CHUNK_BYTES } from "../../src/shared/attachments";
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

it("keeps the free-disk reserve before staging a temporary attachment", async () => {
  root = await mkdtemp(join(tmpdir(), "inertia-temporary-disk-reserve-"));
  const registry = new AttachmentRegistry(join(root, "uploads"));
  const data = Buffer.from("staged text\n");
  disk.available = BigInt(ATTACHMENT_DISK_RESERVE_BYTES + data.length);
  await expect(registry.import([{ name: "fits.txt", mimeType: "text/plain", data }])).resolves.toHaveLength(1);
  disk.available = BigInt(ATTACHMENT_DISK_RESERVE_BYTES + data.length - 1);
  await expect(registry.import([{ name: "denied.txt", mimeType: "text/plain", data }]))
    .rejects.toThrow("Temporary attachment storage is full. Remove an attachment and try again.");
  expect(await readdir(join(root, "uploads"))).toHaveLength(1);
  expect(registry.usage()).toEqual({ records: 1, bytes: data.length });
  await registry.dispose();
});

it("reports a disk that fills during a staged write as full temporary storage", async () => {
  root = await mkdtemp(join(tmpdir(), "inertia-temporary-enospc-"));
  disk.available = BigInt(ATTACHMENT_DISK_RESERVE_BYTES * 2);
  const registry = new AttachmentRegistry(join(root, "uploads"));
  await expect(registry.importFromWriter({
    name: "big.log", mimeType: "text/plain", size: 1024,
    write: async (file) => {
      await file.write(Buffer.alloc(512, 97), 0, 512, 0);
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    },
  })).rejects.toThrow("Temporary attachment storage is full. Remove an attachment and try again.");
  expect(await readdir(join(root, "uploads"))).toEqual([]);
  expect(registry.usage()).toEqual({ records: 0, bytes: 0 });
  await registry.dispose();
});

it("reports a disk that fills during a streamed chunk as full temporary storage", async () => {
  const stream = new AttachmentUploadStream(ATTACHMENT_UPLOAD_CHUNK_BYTES + 1, new AbortController().signal);
  const destination = {
    write: async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    },
  };
  void stream.write(destination as unknown as FileHandle, new AbortController().signal).catch(() => undefined);
  await expect(stream.chunk(new ArrayBuffer(ATTACHMENT_UPLOAD_CHUNK_BYTES), 0, false))
    .rejects.toThrow("Temporary attachment storage is full. Remove an attachment and try again.");
});
