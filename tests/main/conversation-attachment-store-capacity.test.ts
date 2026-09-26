import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationAttachmentStore,
  type ConversationAttachmentPayload,
} from "../../src/node/conversation-attachment-store";
import {
  CONVERSATION_ATTACHMENT_STORAGE_FULL_MESSAGE,
  ConversationAttachmentStorageFullError,
} from "../../src/node/conversation-attachment-store-capacity";
import { runConversationAttachmentStoreChild } from "../../src/node/conversation-attachment-store-child";

const roots: string[] = [];
const stores: ConversationAttachmentStore[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZY2BgYPgPAAEEAQB9ssjfAAAAAElFTkSuQmCC",
  "base64",
);

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function openStore(
  limits: { maxRecords?: number; maxBytes?: number; autoRemoveOldAttachments?: boolean },
  directory?: string,
): Promise<ConversationAttachmentStore> {
  const root = directory ?? await mkdtemp(join(tmpdir(), "inertia-attachment-capacity-"));
  if (!directory) roots.push(root);
  const store = await ConversationAttachmentStore.open(root, { autoRemoveOldAttachments: true, ...limits });
  stores.push(store);
  return store;
}

async function seededHistory(count: number, size: number) {
  const root = await mkdtemp(join(tmpdir(), "inertia-attachment-history-"));
  roots.push(root);
  const directory = join(root, "conversation-attachments");
  await mkdir(directory, { mode: 0o700 });
  const references = Array.from({ length: count }, () => {
    const id = randomUUID();
    return { id, name: "image.png", path: id, mimeType: "image/png" as const, size };
  });
  for (const { id } of references) {
    await mkdir(join(directory, id), { mode: 0o700 });
    await writeFile(join(directory, id, `${id}.png`), png, { mode: 0o600 });
  }
  return { root, references };
}

function image(id: string = randomUUID()): ConversationAttachmentPayload {
  return {
    attachment: {
      id,
      name: "image.png",
      path: `/private/transient/${id}.png`,
      mimeType: "image/png",
      size: png.length,
    },
    bytes: png,
  };
}

async function sent(
  store: ConversationAttachmentStore,
  payloads: ConversationAttachmentPayload[],
): Promise<string[]> {
  const retentionId = randomUUID();
  const retained = await store.retain(payloads, undefined, retentionId);
  store.acceptRetention(retentionId);
  return retained.map(({ id }) => id);
}

describe("durable conversation attachment capacity", () => {
  it("evicts the oldest settled attachment so another image still fits a full store", async () => {
    const store = await openStore({ maxRecords: 2 });
    const [oldest] = await sent(store, [image()]);
    const [recent] = await sent(store, [image()]);
    const followUp = image();

    const [retained] = await store.retain(
      [followUp],
      undefined,
      randomUUID(),
      () => [oldest!, recent!],
    );

    await expect(readFile(retained!.path)).resolves.toEqual(png);
    await expect(store.preview(oldest!)).resolves.toBeNull();
    await expect(store.preview(recent!)).resolves.not.toBeNull();
    await expect(store.usage()).resolves.toEqual({ records: 2, bytes: 2 * png.length });
  });

  it("frees room for several images at once under record and byte pressure", async () => {
    const store = await openStore({ maxRecords: 10, maxBytes: 3 * png.length });
    const history = await sent(store, [image(), image(), image()]);

    const retained = await store.retain(
      [image(), image()],
      undefined,
      randomUUID(),
      () => history,
    );

    expect(retained).toHaveLength(2);
    await expect(store.preview(history[0]!)).resolves.toBeNull();
    await expect(store.preview(history[1]!)).resolves.toBeNull();
    await expect(store.preview(history[2]!)).resolves.not.toBeNull();
    await expect(store.usage()).resolves.toEqual({ records: 3, bytes: 3 * png.length });
  });

  it("never evicts in-flight, protected, or same-batch attachments", async () => {
    const store = await openStore({ maxRecords: 2 });
    const [inFlight] = (await store.retain([image()])).map(({ id }) => id);
    const [settled] = await sent(store, [image()]);
    const batch = [image(), image()];

    const attempt = store.retain(batch, undefined, randomUUID(), () => [
      inFlight!,
      batch[0]!.attachment.id,
      settled!,
    ]);

    await expect(attempt).rejects.toBeInstanceOf(ConversationAttachmentStorageFullError);
    await expect(attempt).rejects.toThrow(CONVERSATION_ATTACHMENT_STORAGE_FULL_MESSAGE);
    await expect(store.preview(inFlight!)).resolves.not.toBeNull();
    await expect(store.preview(settled!)).resolves.not.toBeNull();
    await expect(store.retain([image()], undefined, randomUUID(), () => []))
      .rejects.toBeInstanceOf(ConversationAttachmentStorageFullError);
    await expect(store.retain([image()]))
      .rejects.toBeInstanceOf(ConversationAttachmentStorageFullError);
  });

  it("keeps every settled image below a configured record budget and evicts only past it", async () => {
    const { root: directory, references } = await seededHistory(4_095, 256 * 1024);
    const reads: string[] = [];
    const store = await ConversationAttachmentStore.open(directory, {
      maxRecords: 4_096, autoRemoveOldAttachments: true,
      readOperationRunner(operation, signal) {
        reads.push(operation.id);
        return runConversationAttachmentStoreChild(operation, signal);
      },
    });
    stores.push(store);
    // No child read per kept record is the property; wall time is not asserted
    // because hosted Windows shards make a 4,095-directory scan itself slow.
    await store.reconcile(references);
    expect(reads).toEqual([]);
    await expect(store.usage()).resolves.toEqual({ records: 4_095, bytes: 4_095 * 256 * 1024 });
    const order = () => references.map(({ id }) => id);

    const [belowBudget] = await store.retain([image()], undefined, randomUUID(), order);
    await expect(readFile(belowBudget!.path)).resolves.toEqual(png);
    await expect(store.usage()).resolves.toEqual({ records: 4_096, bytes: 4_095 * 256 * 1024 + png.length });
    await expect(readFile(join(directory, "conversation-attachments", references[0]!.id, `${references[0]!.id}.png`)))
      .resolves.toEqual(png);

    await store.retain([image()], undefined, randomUUID(), order);
    await expect(store.usage()).resolves.toEqual({ records: 4_096, bytes: 4_094 * 256 * 1024 + 2 * png.length });
    await expect(readFile(join(directory, "conversation-attachments", references[0]!.id, `${references[0]!.id}.png`)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(directory, "conversation-attachments", references[1]!.id, `${references[1]!.id}.png`)))
      .resolves.toEqual(png);
  }, 60_000);

  it("evicts the oldest history once the configured 2 GiB byte budget would be exceeded", async () => {
    const { root: directory, references } = await seededHistory(4, 512 * 1024 * 1024 - 1_024);
    const store = await openStore({ maxBytes: 2 * 1024 ** 3 }, directory);
    await store.reconcile(references);
    const order = () => references.map(({ id }) => id);

    const [fits] = await store.retain([image()], undefined, randomUUID(), order);
    await expect(readFile(fits!.path)).resolves.toEqual(png);
    await expect(store.usage()).resolves.toMatchObject({ records: 5 });

    const large = { ...image(), bytes: Buffer.alloc(8 * 1024, 1) };
    large.attachment = { ...large.attachment, size: large.bytes.length };
    await store.retain([large], undefined, randomUUID(), order);
    await expect(store.usage()).resolves.toEqual({
      records: 5,
      bytes: 3 * (512 * 1024 * 1024 - 1_024) + png.length + large.bytes.length,
    });
  });
});

it("keeps stored images by default, applies a larger budget immediately, and never deletes when lowering it", async () => {
  const store = await openStore({ maxBytes: png.length, autoRemoveOldAttachments: false });
  const original = image();
  const [oldest] = await sent(store, [original]);
  await expect(store.retain([image()], undefined, randomUUID(), () => [oldest!]))
    .rejects.toThrow(CONVERSATION_ATTACHMENT_STORAGE_FULL_MESSAGE);
  await expect(store.preview(oldest!)).resolves.not.toBeNull();
  store.setStoragePolicy(2 * png.length, false);
  await sent(store, [image()]);
  store.setStoragePolicy(png.length, false);
  await expect(store.usage()).resolves.toEqual({ records: 2, bytes: 2 * png.length });
  await expect(store.retain([original])).resolves.toHaveLength(1);
  await expect(store.preview(oldest!)).resolves.not.toBeNull();
});

it("explicit cleanup protects active retentions and reports exact released bytes across restart", async () => {
  const store = await openStore({});
  const history = await sent(store, [image(), image()]);
  const pending = await store.retain([image()]);
  const order = () => [...history, pending[0]!.id];
  await expect(store.storageStatus(order)).resolves.toMatchObject({
    state: "ready", maxBytes: 16 * 1024 ** 3, maxRecords: 65_536,
    records: 3, bytes: 3 * png.length, removableRecords: 2, removableBytes: 2 * png.length,
  });
  await expect(store.cleanupOldest(order)).resolves.toEqual({ records: 2, bytes: 2 * png.length });
  await expect(store.preview(pending[0]!.id)).resolves.not.toBeNull();
  await expect(store.usage()).resolves.toEqual({ records: 1, bytes: png.length });
  await store.close();
  const restarted = await openStore({}, roots[roots.length - 1]);
  await restarted.reconcile(pending);
  await expect(restarted.usage()).resolves.toEqual({ records: 1, bytes: png.length });
  await expect(restarted.preview(history[0]!)).resolves.toBeNull();
});

it("serializes cleanup with imports and rechecks newly active conversations before unlinking", async () => {
  const store = await openStore({});
  const history = await sent(store, [image(), image()]);
  let checks = 0;
  const cleanup = store.cleanupOldest(() => ++checks <= 2 ? history : [history[0]!]);
  const incoming = image();
  const retention = store.retain([incoming]);
  await expect(cleanup).resolves.toEqual({ records: 1, bytes: png.length });
  await retention;
  await expect(store.preview(history[1]!)).resolves.not.toBeNull();
  await expect(store.preview(incoming.attachment.id)).resolves.not.toBeNull();
  await expect(store.usage()).resolves.toEqual({ records: 2, bytes: 2 * png.length });
});

it("retains more than 4,096 images without evicting history under the new default", async () => {
  const { root, references } = await seededHistory(4_097, png.length);
  const store = await openStore({ autoRemoveOldAttachments: false }, root);
  await store.reconcile(references);
  await expect(store.usage()).resolves.toEqual({ records: 4_097, bytes: 4_097 * png.length });
  await sent(store, [image()]);
  await expect(store.usage()).resolves.toEqual({ records: 4_098, bytes: 4_098 * png.length });
  await expect(readFile(join(root, "conversation-attachments", references[0]!.id, `${references[0]!.id}.png`))).resolves.toEqual(png);
}, 60_000);
