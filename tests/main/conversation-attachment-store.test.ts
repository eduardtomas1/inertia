import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateAttachmentImport } from "../../src/main/attachment-import";
import {
  ConversationAttachmentStore,
  type ConversationAttachmentPayload,
} from "../../src/node/conversation-attachment-store";

const roots: string[] = [];
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-conversation-attachments-"));
  roots.push(directory);
  return directory;
}

function image(
  id = "11111111-1111-4111-8111-111111111111",
): ConversationAttachmentPayload {
  return {
    attachment: {
      id,
      name: "reference.png",
      path: "/private/transient/reference.png",
      mimeType: "image/png",
      size: png.length,
    },
    bytes: png,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("durable conversation attachment storage", () => {
  it("retains validated bytes across store and application restart", async () => {
    const dataDirectory = await root();
    const writer = await ConversationAttachmentStore.open(dataDirectory);
    const [retained] = await writer.retain([image()]);

    expect(retained).toMatchObject({
      id: image().attachment.id,
      name: "reference.png",
      mimeType: "image/png",
      size: png.length,
    });
    expect(retained!.path).not.toBe(image().attachment.path);

    const reader = await ConversationAttachmentStore.open(dataDirectory, {
      validate: validateAttachmentImport,
    });
    await expect(reader.preview(retained!.id)).resolves.toMatchObject({
      attachment: retained,
      bytes: png,
    });
  });

  it("reconciles restart storage against authoritative message references", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory);
    const kept = image("11111111-1111-4111-8111-111111111111");
    const orphan = image("22222222-2222-4222-8222-222222222222");
    const [keptAttachment, orphanAttachment] = await store.retain([
      kept,
      orphan,
    ]);

    await store.reconcile([keptAttachment!]);

    await expect(store.preview(keptAttachment!.id)).resolves.not.toBeNull();
    await expect(store.preview(orphanAttachment!.id)).resolves.toBeNull();
    await expect(store.usage()).resolves.toEqual({
      records: 1,
      bytes: png.length,
    });
  });

  it("cleans contained unexpected entries without blocking restart", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory);
    await writeFile(join(store.directory, ".DS_Store"), "fixture", "utf8");
    await mkdir(join(store.directory, "interrupted-maintenance"));

    await expect(store.reconcile([])).resolves.toBeUndefined();

    await expect(readdir(store.directory)).resolves.toEqual([]);
  });

  it("rejects attachment identity reuse with different retained content", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory);
    const original = image();
    await store.retain([original]);
    const changed = {
      attachment: original.attachment,
      bytes: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b,
      ]),
    };

    await expect(store.retain([changed]))
      .rejects.toThrow(/identity was reused/u);
  });

  it("treats an exact retained identity retry as idempotent", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory);
    const original = image();
    const [first] = await store.retain([original]);
    const [retried] = await store.retain([original]);

    expect(retried).toEqual(first);
    await expect(store.usage()).resolves.toEqual({
      records: 1,
      bytes: png.length,
    });
  });

  it("rejects malformed privileged metadata before creating a record", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory);
    const valid = image();
    const malformed: ConversationAttachmentPayload = {
      ...valid,
      attachment: {
        ...valid.attachment,
        name: "../reference.png",
      },
    };

    await expect(store.retain([malformed]))
      .rejects.toThrow(/invalid/u);
    await expect(store.usage()).resolves.toEqual({ records: 0, bytes: 0 });
  });

  it("honors cancellation before durable filesystem mutation", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory);
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(store.retain([image()], cancellation.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(store.usage()).resolves.toEqual({ records: 0, bytes: 0 });
  });

  it("fails closed when retained bytes or their private record are replaced", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      validate: validateAttachmentImport,
    });
    const [retained] = await store.retain([image()]);
    await writeFile(retained!.path, Buffer.from("tampered", "utf8"));

    await expect(store.preview(retained!.id)).rejects.toThrow(/changed|invalid/u);

    await store.release([retained!.id]);
    const unsafeDirectory = join(
      store.directory,
      "33333333-3333-4333-8333-333333333333",
    );
    await mkdir(unsafeDirectory);
    await writeFile(join(unsafeDirectory, "metadata.json"), "{}", "utf8");
    await expect(store.reconcile([])).resolves.toBeUndefined();
    await expect(readFile(join(unsafeDirectory, "metadata.json"), "utf8"))
      .rejects.toThrow();
  });

  it("removes interrupted records instead of blocking restart reconciliation", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory);
    const payload = image("55555555-5555-4555-8555-555555555555");
    const interruptedDirectory = join(
      store.directory,
      payload.attachment.id,
    );
    await mkdir(interruptedDirectory);
    await writeFile(
      join(interruptedDirectory, `${payload.attachment.id}.png`),
      png,
    );

    await expect(store.reconcile([payload.attachment]))
      .resolves.toBeUndefined();
    await expect(store.preview(payload.attachment.id)).resolves.toBeNull();
    await expect(store.retain([payload])).resolves.toHaveLength(1);
  });

  it.runIf(process.platform !== "win32")(
    "rejects records that are no longer owner-only",
    async () => {
      const dataDirectory = await root();
      const store = await ConversationAttachmentStore.open(dataDirectory);
      const [retained] = await store.retain([image()]);
      await chmod(retained!.path, 0o644);

      await expect(store.preview(retained!.id)).rejects.toThrow(/unsafe/u);
      await expect(store.reconcile([retained!])).resolves.toBeUndefined();
      await expect(store.preview(retained!.id)).resolves.toBeNull();
    },
  );

  it("enforces bounded persistent record and byte capacity", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      maxRecords: 1,
      maxBytes: png.length,
    });
    await store.retain([image()]);

    await expect(store.retain([
      image("44444444-4444-4444-8444-444444444444"),
    ])).rejects.toThrow(/storage is full/u);
  });
});
