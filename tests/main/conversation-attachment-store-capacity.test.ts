import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  limits: { maxRecords?: number; maxBytes?: number },
): Promise<ConversationAttachmentStore> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-attachment-capacity-"));
  roots.push(directory);
  const store = await ConversationAttachmentStore.open(directory, limits);
  stores.push(store);
  return store;
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
});
