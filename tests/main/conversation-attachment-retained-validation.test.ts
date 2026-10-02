import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateAttachmentImport } from "../../src/main/attachment-import";
import {
  ConversationAttachmentStore,
  type ConversationAttachmentPayload,
} from "../../src/node/conversation-attachment-store";
import {
  runConversationAttachmentStoreChild,
  type ConversationAttachmentStoreReadOperationRunner,
} from "../../src/node/conversation-attachment-store-child";
import { metadataFromUnknown } from "../../src/node/conversation-attachment-store-metadata";
import { pngWithoutPalette } from "../fixtures/attachments/png-chunks";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZY2BgYPgPAAEEAQB9ssjfAAAAAElFTkSuQmCC",
  "base64",
);

function payload(id: string, name: string, bytes: Buffer): ConversationAttachmentPayload {
  return { attachment: { id, name, path: `/transient/${name}`, mimeType: "image/png", size: bytes.length }, bytes };
}

const utilityRead: ConversationAttachmentStoreReadOperationRunner = (operation, signal) => {
  const child = runConversationAttachmentStoreChild(operation, signal);
  const result = child.result.then(async (receipt) => {
    if (receipt.missing || operation.validateContent === false) return receipt;
    const metadata = metadataFromUnknown(JSON.parse(receipt.metadata));
    if (!metadata) return { missing: true } as const;
    const validated = await validateAttachmentImport({
      name: metadata.name, mimeType: metadata.mimeType, data: Buffer.from(receipt.bytes),
    });
    if (validated.digest !== metadata.digest) throw new Error("Invalid attachment content.");
    return receipt;
  });
  return { result, stopped: child.stopped, ready: child.ready };
};

describe("retained attachments that the current validator rejects", () => {
  it("keep storage status and retention working while their preview stays unavailable", async () => {
    const legacyId = "11111111-1111-4111-8111-111111111111";
    const dataDirectory = await mkdtemp(join(tmpdir(), "inertia-retained-validation-"));
    roots.push(dataDirectory);
    const writer = await ConversationAttachmentStore.open(dataDirectory);
    await writer.retain([payload(legacyId, "legacy.png", pngWithoutPalette())]);
    await writer.close();

    const store = await ConversationAttachmentStore.open(dataDirectory, { readOperationRunner: utilityRead });
    try {
      await expect(store.storageStatus(() => [])).resolves.toMatchObject({ records: 1, state: "ready" });
      await expect(store.retain([payload("22222222-2222-4222-8222-222222222222", "fresh.png", png)])).resolves.toHaveLength(1);
      await expect(store.retain([payload(legacyId, "legacy.png", pngWithoutPalette())])).resolves.toHaveLength(1);
      await expect(store.preview(legacyId)).rejects.toThrow("Attachment content does not match its safe file type.");
    } finally {
      await store.close();
    }
  }, 60_000);
});
