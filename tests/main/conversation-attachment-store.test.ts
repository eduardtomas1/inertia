import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateAttachmentImport } from "../../src/main/attachment-import";
import {
  ConversationAttachmentStore,
  type ConversationAttachmentPayload,
  type ConversationAttachmentStoreOperationRunner,
  type ConversationAttachmentStoreOptions,
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

const testOperationRunner: ConversationAttachmentStoreOperationRunner = (
  operation,
  signal,
) => {
  const result = (async () => {
    signal?.throwIfAborted();
    const root = await lstat(operation.root, { bigint: true });
    expect(operation.rootDev).toBe(String(root.dev));
    expect(operation.rootIno).toBe(String(root.ino));
    expect(operation.rootUid).toBe(
      process.platform === "win32" ? null : String(root.uid),
    );
    if (operation.operation === "remove") {
      await rm(join(operation.root, operation.name), {
        recursive: true,
        force: true,
      });
      return;
    }
    const record = join(operation.root, operation.id);
    await mkdir(record, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(record, 0o700);
    const content = join(
      record,
      `${operation.id}.${operation.extension}`,
    );
    await writeFile(content, operation.bytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(record, "metadata.json"), operation.metadata, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      await chmod(content, 0o600);
      await chmod(join(record, "metadata.json"), 0o600);
    }
  })();
  return {
    result,
    stopped: result.then(() => undefined, () => undefined),
  };
};

async function openTestStore(
  dataDirectory: string,
  options: ConversationAttachmentStoreOptions = {},
): Promise<ConversationAttachmentStore> {
  return await ConversationAttachmentStore.open(dataDirectory, {
    ...options,
    operationRunner: testOperationRunner,
  });
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

    const reader = await openTestStore(dataDirectory, {
      validate: validateAttachmentImport,
    });
    await expect(reader.preview(retained!.id)).resolves.toMatchObject({
      attachment: retained,
      bytes: png,
    });
  });

  it("reconciles restart storage against authoritative message references", async () => {
    const dataDirectory = await root();
    const store = await openTestStore(dataDirectory);
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
    const store = await openTestStore(dataDirectory);
    await writeFile(join(store.directory, ".DS_Store"), "fixture", "utf8");
    await mkdir(join(store.directory, "interrupted-maintenance"));

    await expect(store.reconcile([])).resolves.toBeUndefined();

    await expect(readdir(store.directory)).resolves.toEqual([]);
  });

  it("rejects attachment identity reuse with different retained content", async () => {
    const dataDirectory = await root();
    const store = await openTestStore(dataDirectory);
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
    const store = await openTestStore(dataDirectory);
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
    const store = await openTestStore(dataDirectory);
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
    const store = await openTestStore(dataDirectory);
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(store.retain([image()], cancellation.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(store.usage()).resolves.toEqual({ records: 0, bytes: 0 });
  });

  it("does not let late cleanup delete an attachment claimed by a retry", async () => {
    const dataDirectory = await root();
    const store = await openTestStore(dataDirectory);
    const firstRetention = "66666666-6666-4666-8666-666666666666";
    const retryRetention = "77777777-7777-4777-8777-777777777777";
    const [first] = await store.retain(
      [image()],
      undefined,
      firstRetention,
    );
    const [retry] = await store.retain(
      [image()],
      undefined,
      retryRetention,
    );

    await store.releaseRetention(firstRetention);

    await expect(store.preview(retry!.id)).resolves.toMatchObject({
      attachment: retry,
    });
    store.acceptRetention(retryRetention);
    await store.releaseRetention(firstRetention);
    await expect(store.preview(first!.id)).resolves.not.toBeNull();
  });

  it("releases the mutation queue when durable publication is cancelled", async () => {
    const dataDirectory = await root();
    const completed = image("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    const stalled = image("88888888-8888-4888-8888-888888888888");
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      persistenceFault: {
        attachmentId: stalled.attachment.id,
        stallBeforePublishMs: 60_000,
      },
    });
    const cancellation = new AbortController();
    const retaining = store.retain(
      [completed, stalled],
      cancellation.signal,
      "99999999-9999-4999-8999-999999999999",
    );
    try {
      await vi.waitFor(async () => {
        const pending = (await readdir(store.directory)).find((name) =>
          name.startsWith(".pending-"));
        expect(pending).toBeDefined();
        await expect(readFile(join(
            store.directory,
            pending!,
            `${stalled.attachment.id}.png`,
        ))).resolves.toEqual(png);
      }, { timeout: 10_000, interval: 10 });

      cancellation.abort();
      await expect(retaining).rejects.toMatchObject({ name: "AbortError" });

      const next = image("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      let timeout!: ReturnType<typeof setTimeout>;
      try {
        await expect(Promise.race([
          store.retain(
            [next],
            undefined,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          ),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("The mutation queue remained occupied.")),
              5_000,
            );
          }),
        ])).resolves.toHaveLength(1);
      } finally {
        clearTimeout(timeout);
      }
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const pending = (await readdir(store.directory)).filter((name) =>
          name.startsWith(".pending-"));
        if (pending.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await readdir(store.directory)).filter((name) =>
        name.startsWith(".pending-"))).toEqual([]);
      await expect(store.preview(completed.attachment.id)).resolves.toBeNull();
    } finally {
      cancellation.abort();
      await retaining.catch(() => undefined);
    }
  }, 20_000);

  it("reserves capacity until a cancelled persistence child has stopped", async () => {
    const dataDirectory = await root();
    const stalled = image("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    let finishStop!: () => void;
    let started = false;
    const operationRunner: ConversationAttachmentStoreOperationRunner = (
      operation,
      signal,
    ) => {
      if (
        operation.operation !== "persist"
        || operation.id !== stalled.attachment.id
      ) return testOperationRunner(operation, signal);
      started = true;
      const result = new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      const stopped = new Promise<void>((resolve) => {
        finishStop = resolve;
      });
      return { result, stopped };
    };
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      maxRecords: 1,
      operationRunner,
    });
    const cancellation = new AbortController();
    const retaining = store.retain([stalled], cancellation.signal);
    await vi.waitFor(() => expect(started).toBe(true));

    cancellation.abort();
    await expect(retaining).rejects.toMatchObject({ name: "AbortError" });
    await expect(store.retain([
      image("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    ])).rejects.toThrow(/storage is full/u);

    finishStop();
    await Promise.resolve();
    await store.usage();
    await expect(store.retain([
      image("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    ])).resolves.toHaveLength(1);
  });

  it("keeps failed-cleanup bytes reserved until reconciliation succeeds", async () => {
    const dataDirectory = await root();
    const first = image("12121212-1212-4212-8212-121212121212");
    const failed = image("34343434-3434-4434-8434-343434343434");
    let cleanupFails = true;
    const operationRunner: ConversationAttachmentStoreOperationRunner = (
      operation,
      signal,
    ) => {
      if (operation.operation === "persist" && operation.id === failed.attachment.id) {
        throw new Error("Injected publication failure.");
      }
      if (
        cleanupFails
        && operation.operation === "remove"
        && operation.name === first.attachment.id
      ) {
        const result = Promise.reject(new Error("Injected cleanup failure."));
        return {
          result,
          stopped: result.then(() => undefined, () => undefined),
        };
      }
      return testOperationRunner(operation, signal);
    };
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      maxRecords: 2,
      operationRunner,
    });

    await expect(store.retain([first, failed]))
      .rejects.toThrow("Injected publication failure.");
    await expect(store.preview(first.attachment.id)).resolves.not.toBeNull();
    const retry = [
      image("56565656-5656-4656-8656-565656565656"),
      image("78787878-7878-4878-8878-787878787878"),
    ];
    await expect(store.retain(retry)).rejects.toThrow(/storage is full/u);

    cleanupFails = false;
    await store.reconcile([]);
    await expect(store.retain(retry)).resolves.toHaveLength(2);
  });

  it("blocks an immediate retry until a cancelled publication is reconciled", async () => {
    const dataDirectory = await root();
    const payload = image("90909090-9090-4090-8090-909090909090");
    let published = false;
    let stalled = false;
    let finishStop!: () => void;
    const operationRunner: ConversationAttachmentStoreOperationRunner = (
      operation,
      signal,
    ) => {
      if (
        operation.operation !== "persist"
        || operation.id !== payload.attachment.id
        || stalled
      ) return testOperationRunner(operation, signal);
      stalled = true;
      const result = (async () => {
        await testOperationRunner(operation, signal).result;
        published = true;
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      })();
      const stopped = new Promise<void>((resolve) => {
        finishStop = resolve;
      });
      return { result, stopped };
    };
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      operationRunner,
    });
    const cancellation = new AbortController();
    const retaining = store.retain(
      [payload],
      cancellation.signal,
      "91919191-9191-4191-8191-919191919191",
    );
    await vi.waitFor(() => expect(published).toBe(true));

    cancellation.abort();
    await expect(retaining).rejects.toMatchObject({ name: "AbortError" });
    await expect(store.retain(
      [payload],
      undefined,
      "92929292-9292-4292-8292-929292929292",
    )).rejects.toThrow(/still cleaning up/u);

    finishStop();
    await vi.waitFor(async () => {
      await expect(store.preview(payload.attachment.id)).resolves.toBeNull();
    });
    await expect(store.retain(
      [payload],
      undefined,
      "93939393-9393-4393-8393-939393939393",
    )).resolves.toHaveLength(1);
  });

  it("refuses cleanup after its pinned storage root is replaced", async () => {
    const dataDirectory = await root();
    const outside = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory);
    await store.usage();
    const moved = `${store.directory}-moved`;
    await writeFile(join(outside, ".DS_Store"), "preserve", "utf8");
    await rename(store.directory, moved);
    await symlink(
      outside,
      store.directory,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      await expect(store.reconcile([])).rejects.toThrow(/failed/u);
      await expect(store.retain([
        image("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      ])).rejects.toThrow(/failed/u);
      await expect(readFile(join(outside, ".DS_Store"), "utf8"))
        .resolves.toBe("preserve");
      await expect(readdir(outside)).resolves.toEqual([".DS_Store"]);
    } finally {
      await rm(store.directory, { recursive: true, force: true });
      await rename(moved, store.directory);
    }
  });

  it("refuses reads after its pinned storage root is replaced", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory);
    const payload = image("94949494-9494-4494-8494-949494949494");
    const [retained] = await store.retain([payload]);
    const moved = `${store.directory}-moved`;
    await rename(store.directory, moved);
    await mkdir(store.directory, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(store.directory, 0o700);
    await rename(
      join(moved, retained!.id),
      join(store.directory, retained!.id),
    );
    try {
      await expect(store.preview(retained!.id)).rejects.toThrow(/read failed/u);
      await expect(store.retain(
        [payload],
        undefined,
        "95959595-9595-4595-8595-959595959595",
      )).rejects.toThrow(/read failed/u);
    } finally {
      await rm(store.directory, { recursive: true, force: true });
      await rename(moved, store.directory);
    }
  });

  it("fails closed when retained bytes or their private record are replaced", async () => {
    const dataDirectory = await root();
    const store = await openTestStore(dataDirectory, {
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
    const store = await openTestStore(dataDirectory);
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
      const store = await openTestStore(dataDirectory);
      const [retained] = await store.retain([image()]);
      await chmod(retained!.path, 0o644);

      await expect(store.preview(retained!.id)).rejects.toThrow(/unsafe/u);
      await expect(store.reconcile([retained!])).resolves.toBeUndefined();
      await expect(store.preview(retained!.id)).resolves.toBeNull();
    },
  );

  it("enforces bounded persistent record and byte capacity", async () => {
    const dataDirectory = await root();
    const store = await openTestStore(dataDirectory, {
      maxRecords: 1,
      maxBytes: png.length,
    });
    await store.retain([image()]);

    await expect(store.retain([
      image("44444444-4444-4444-8444-444444444444"),
    ])).rejects.toThrow(/storage is full/u);
  });
});
