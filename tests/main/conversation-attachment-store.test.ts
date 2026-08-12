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
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })));
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

  it("bounds startup reconciliation and defers stalled cleanup", async () => {
    const dataDirectory = await root();
    let cleanupBlocked = true;
    let cleanupAttempts = 0;
    const operationRunner: ConversationAttachmentStoreOperationRunner = (
      operation,
      signal,
    ) => {
      if (operation.operation !== "remove" || !cleanupBlocked) {
        return testOperationRunner(operation, signal);
      }
      cleanupAttempts += 1;
      const result = new Promise<void>((_resolve, reject) => {
        const abort = () => reject(
          signal?.reason ?? new Error("Reconciliation was cancelled."),
        );
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      return {
        result,
        stopped: result.then(() => undefined, () => undefined),
      };
    };
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      maxBytes: png.length * 2,
      maxRecords: 2,
      operationRunner,
      reconciliationBatchEntries: 1,
      reconciliationBatchTimeoutMs: 25,
    });
    await writeFile(join(store.directory, ".stalled-cleanup"), "one", "utf8");
    await writeFile(join(store.directory, ".deferred-cleanup"), "two", "utf8");

    const startedAt = Date.now();
    await expect(store.reconcile([])).resolves.toBeUndefined();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(cleanupAttempts).toBe(1);
    await expect(store.usage()).resolves.toEqual({
      bytes: png.length * 2,
      records: 2,
    });
    await expect(store.retain([image()])).rejects.toThrow(/reconciling/u);

    cleanupBlocked = false;
    await vi.waitFor(async () => {
      await expect(readdir(store.directory)).resolves.toEqual([]);
      await expect(store.usage()).resolves.toEqual({ bytes: 0, records: 0 });
    }, { timeout: 5_000, interval: 10 });
  });

  it("holds the reconciliation mutation barrier until aborted cleanup stops", async () => {
    const dataDirectory = await root();
    let signalCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      signalCleanupStarted = resolve;
    });
    let signalCleanupAborted!: () => void;
    const cleanupAborted = new Promise<void>((resolve) => {
      signalCleanupAborted = resolve;
    });
    let finishCleanupStop!: () => void;
    let holdCleanup = true;
    const operationRunner: ConversationAttachmentStoreOperationRunner = (
      operation,
      signal,
    ) => {
      if (operation.operation !== "remove" || !holdCleanup) {
        return testOperationRunner(operation, signal);
      }
      holdCleanup = false;
      signalCleanupStarted();
      const result = new Promise<void>((_resolve, reject) => {
        const abort = () => {
          signalCleanupAborted();
          reject(signal?.reason ?? new Error("Cleanup was cancelled."));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      const stopped = new Promise<void>((resolve) => {
        finishCleanupStop = resolve;
      });
      return { result, stopped };
    };
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      operationRunner,
      reconciliationBatchEntries: 1,
      reconciliationBatchTimeoutMs: 25,
    });
    await writeFile(join(store.directory, ".held-cleanup"), "held", "utf8");

    const reconciling = store.reconcile([]);
    await cleanupStarted;
    await cleanupAborted;
    const usage = store.usage();
    const settledBeforeStop = await Promise.race([
      Promise.allSettled([reconciling, usage]).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    expect(settledBeforeStop).toBe(false);

    finishCleanupStop();
    await expect(reconciling).resolves.toBeUndefined();
    await expect(usage).resolves.toEqual({
      bytes: 512 * 1024 * 1024,
      records: 256,
    });
    await vi.waitFor(async () => {
      await expect(readdir(store.directory)).resolves.toEqual([]);
      await expect(store.usage()).resolves.toEqual({ bytes: 0, records: 0 });
    }, { timeout: 5_000, interval: 10 });
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

  it("bounds concurrent cleanup across many independent records", async () => {
    const dataDirectory = await root();
    let activeRemovals = 0;
    let maximumActiveRemovals = 0;
    const finishRemovals: Array<() => void> = [];
    const operationRunner: ConversationAttachmentStoreOperationRunner = (
      operation,
      signal,
    ) => {
      if (operation.operation !== "remove") {
        return testOperationRunner(operation, signal);
      }
      activeRemovals += 1;
      maximumActiveRemovals = Math.max(
        maximumActiveRemovals,
        activeRemovals,
      );
      const result = new Promise<void>((resolve) => {
        finishRemovals.push(() => {
          activeRemovals -= 1;
          resolve();
        });
      });
      return {
        result,
        stopped: result.then(() => undefined),
      };
    };
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      operationRunner,
    });
    const payloads = Array.from({ length: 9 }, (_, index) => image(
      `${String(index + 20).padStart(8, "0")}-2020-4020-8020-${String(
        index + 20,
      ).padStart(12, "0")}`,
    ));
    const firstRetention = "15151515-1515-4515-8515-151515151515";
    const secondRetention = "19191919-1919-4919-8919-191919191919";
    const retained = await store.retain(
      payloads.slice(0, 8),
      undefined,
      firstRetention,
    );
    retained.push(...await store.retain(
      payloads.slice(8),
      undefined,
      secondRetention,
    ));
    store.acceptRetention(firstRetention);
    store.acceptRetention(secondRetention);

    const releasing = store.release(retained.map(({ id }) => id));
    await vi.waitFor(() => expect(activeRemovals).toBe(8));
    expect(maximumActiveRemovals).toBe(8);
    finishRemovals.splice(0).forEach((finish) => finish());
    await vi.waitFor(() => expect(activeRemovals).toBe(1));
    finishRemovals.splice(0).forEach((finish) => finish());
    await expect(releasing).resolves.toBeUndefined();
    await expect(store.usage()).resolves.toEqual({ bytes: 0, records: 0 });
  });

  it("preserves an in-flight retry lease during authoritative deletion", async () => {
    const dataDirectory = await root();
    const store = await openTestStore(dataDirectory);
    const authoritativeLease = "16161616-1616-4616-8616-161616161616";
    const retryLease = "17171717-1717-4717-8717-171717171717";
    const [retained] = await store.retain(
      [image()],
      undefined,
      authoritativeLease,
    );
    store.acceptRetention(authoritativeLease);
    await store.retain([image()], undefined, retryLease);

    await store.release([retained!.id]);

    await expect(store.preview(retained!.id)).resolves.not.toBeNull();
    store.acceptRetention(retryLease);
    await expect(store.preview(retained!.id)).resolves.not.toBeNull();
  });

  it("keeps failed retention cleanup retryable after partial progress", async () => {
    const dataDirectory = await root();
    const failed = image("67676767-6767-4767-8767-676767676767");
    const removed = image("68686868-6868-4868-8868-686868686868");
    let cleanupFails = true;
    const operationRunner: ConversationAttachmentStoreOperationRunner = (
      operation,
      signal,
    ) => {
      if (
        cleanupFails
        && operation.operation === "remove"
        && operation.name === failed.attachment.id
      ) {
        const result = Promise.reject(new Error("Transient cleanup failure."));
        return {
          result,
          stopped: result.then(() => undefined, () => undefined),
        };
      }
      return testOperationRunner(operation, signal);
    };
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      operationRunner,
    });
    const retentionId = "69696969-6969-4969-8969-696969696969";
    await store.retain([failed, removed], undefined, retentionId);

    await expect(store.releaseRetention(retentionId))
      .rejects.toThrow("Transient cleanup failure.");
    await expect(store.preview(failed.attachment.id)).resolves.not.toBeNull();
    await expect(store.preview(removed.attachment.id)).resolves.toBeNull();
    await expect(store.usage()).resolves.toEqual({
      bytes: png.length,
      records: 1,
    });

    cleanupFails = false;
    await expect(store.releaseRetention(retentionId)).resolves.toBeUndefined();
    await expect(store.preview(failed.attachment.id)).resolves.toBeNull();
    await expect(store.usage()).resolves.toEqual({ bytes: 0, records: 0 });
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

  it("does not close until an aborted persistence child and cleanup have stopped", async () => {
    const dataDirectory = await root();
    const payload = image("10101010-1010-4010-8010-101010101010");
    let started = false;
    let finishStop!: () => void;
    const operationRunner: ConversationAttachmentStoreOperationRunner = (
      operation,
      signal,
    ) => {
      if (operation.operation !== "persist") {
        return testOperationRunner(operation, signal);
      }
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
      operationRunner,
    });
    const retaining = store.retain([payload]);
    await vi.waitFor(() => expect(started).toBe(true));

    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await expect(retaining).rejects.toThrow(/closing/u);
    await Promise.resolve();
    expect(closed).toBe(false);

    finishStop();
    await expect(closing).resolves.toBeUndefined();
    expect(closed).toBe(true);
    await expect(store.preview(payload.attachment.id)).rejects.toThrow(/closing/u);
  });

  it("cancels and drains an active durable preview read during close", async () => {
    const dataDirectory = await root();
    const payload = image("20202020-2020-4020-8020-202020202020");
    let readReady!: () => void;
    const ready = new Promise<void>((resolve) => { readReady = resolve; });
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      operationRunner: testOperationRunner,
      readFault: {
        attachmentId: payload.attachment.id,
        stallBeforeRecordRevalidateMs: 60_000,
        onReady: readReady,
      },
    });
    await store.retain([payload]);
    const preview = store.preview(payload.attachment.id);
    await ready;

    const closing = store.close();
    await expect(preview).rejects.toThrow(/closing/u);
    await expect(closing).resolves.toBeUndefined();
  });

  it("cancels reconciliation and drains its active child before closing", async () => {
    const dataDirectory = await root();
    const storeDirectory = join(dataDirectory, "conversation-attachments");
    await mkdir(storeDirectory, { recursive: true });
    await mkdir(join(storeDirectory, "foreign-entry"));
    let started = false;
    let finishStop!: () => void;
    const operationRunner: ConversationAttachmentStoreOperationRunner = (
      operation,
      signal,
    ) => {
      if (operation.operation !== "remove") {
        return testOperationRunner(operation, signal);
      }
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
      operationRunner,
    });
    const reconciling = store.reconcile([]);
    await vi.waitFor(() => expect(started).toBe(true));

    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    const settledBeforeStop = await Promise.race([
      Promise.allSettled([reconciling, closing]).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    expect(settledBeforeStop).toBe(false);
    expect(closed).toBe(false);
    finishStop();
    await expect(reconciling).rejects.toThrow(/closing/u);
    await expect(closing).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });

  it("bounds a cleanup whose child never confirms it stopped", async () => {
    const dataDirectory = await root();
    const storeDirectory = join(dataDirectory, "conversation-attachments");
    await mkdir(storeDirectory, { recursive: true });
    await writeFile(join(storeDirectory, "foreign-entry"), "foreign");
    const operationRunner: ConversationAttachmentStoreOperationRunner = (
      operation,
      signal,
    ) => {
      if (operation.operation !== "remove") {
        return testOperationRunner(operation, signal);
      }
      const result = new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      return { result, stopped: new Promise<void>(() => undefined) };
    };
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      operationRunner,
      reconciliationBatchTimeoutMs: 25,
    });

    const startedAt = Date.now();
    await expect(store.reconcile([])).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(store.usage()).rejects.toThrow(/still stopping/u);
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
      await expect(store.reconcile([])).rejects.toThrow(/changed|failed/u);
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

  it.runIf(process.platform !== "win32")(
    "rejects a record name rebound during an anchored read",
    async () => {
      const dataDirectory = await root();
      const payload = image("96969696-9696-4696-8696-969696969696");
      let signalReadReady!: () => void;
      const readReady = new Promise<void>((resolve) => {
        signalReadReady = resolve;
      });
      const store = await ConversationAttachmentStore.open(dataDirectory, {
        readFault: {
          attachmentId: payload.attachment.id,
          stallBeforeRecordRevalidateMs: 10_000,
          onReady: signalReadReady,
        },
      });
      const [retained] = await store.retain([payload]);
      const record = join(store.directory, retained!.id);
      const moved = `${record}-opened`;
      const metadata = await readFile(join(record, "metadata.json"));
      const reading = store.preview(retained!.id);

      await readReady;
      await rename(record, moved);
      await mkdir(record, { mode: 0o700 });
      await writeFile(retained!.path, png, { mode: 0o600 });
      await writeFile(join(record, "metadata.json"), metadata, { mode: 0o600 });
      if (process.platform !== "win32") {
        await chmod(record, 0o700);
        await chmod(retained!.path, 0o600);
        await chmod(join(record, "metadata.json"), 0o600);
      }
      try {
        await expect(reading).rejects.toThrow(/read failed/u);
      } finally {
        await rm(record, { recursive: true, force: true });
        await rename(moved, record);
      }
    },
    15_000,
  );

  it("fails closed when retained bytes or their private record are replaced", async () => {
    const dataDirectory = await root();
    const store = await openTestStore(dataDirectory, {
      validate: validateAttachmentImport,
    });
    const retentionId = "18181818-1818-4818-8818-181818181818";
    const [retained] = await store.retain(
      [image()],
      undefined,
      retentionId,
    );
    store.acceptRetention(retentionId);
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
