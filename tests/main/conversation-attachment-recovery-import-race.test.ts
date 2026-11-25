import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationAttachmentStore,
  type ConversationAttachmentStoreOperationRunner,
} from "../../src/node/conversation-attachment-store";
import { metadataFor } from "../../src/node/conversation-attachment-store-metadata";
import type { ChatAttachment } from "../../src/shared/contracts";

const roots: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZY2BgYPgPAAEEAQB9ssjfAAAAAElFTkSuQmCC",
  "base64",
);
const STAGING = ".recovery-import-77777777-7777-4777-8777-777777777777.partial";
const STALLED = ".stalled-cleanup";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-attachment-import-race-"));
  roots.push(directory);
  return directory;
}

function attachment(id: string): ChatAttachment {
  return { id, name: "imported.png", path: id, mimeType: "image/png", size: png.length };
}

async function publishRecord(storeDirectory: string, record: ChatAttachment): Promise<void> {
  const directory = join(storeDirectory, record.id);
  await mkdir(directory, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  await writeFile(join(directory, `${record.id}.png`), png, { mode: 0o600 });
  await writeFile(
    join(directory, "metadata.json"),
    JSON.stringify(metadataFor({ attachment: record, bytes: png })),
    { mode: 0o600 },
  );
}

async function stageImport(storeDirectory: string): Promise<void> {
  await mkdir(join(storeDirectory, STAGING, "ready"), { recursive: true, mode: 0o700 });
  await writeFile(join(storeDirectory, STAGING, "ready", "pending.bin"), "staged", { mode: 0o600 });
}

function heldCleanupRunner(): {
  readonly runner: ConversationAttachmentStoreOperationRunner;
  readonly release: () => void;
} {
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  const runner: ConversationAttachmentStoreOperationRunner = (operation, signal) => {
    const result = (async () => {
      if (operation.operation !== "remove") throw new Error("Unexpected persistence in this test.");
      if (operation.name === STALLED) {
        await new Promise<void>((resolveHeld, rejectHeld) => {
          const abort = (): void => rejectHeld(signal?.reason ?? new Error("aborted"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          void held.then(resolveHeld);
        });
      }
      await rm(join(operation.root, operation.name), { recursive: true, force: true });
    })();
    return { result, stopped: result.then(() => undefined, () => undefined) };
  };
  return { runner, release };
}

describe("attachment reconciliation during a recovery import", () => {
  it("keeps import staging and queues imported references while reconciliation runs", async () => {
    const dataDirectory = await root();
    const held = heldCleanupRunner();
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      operationRunner: held.runner,
      reconciliationBatchEntries: 1,
      reconciliationBatchTimeoutMs: 25,
    });
    try {
      const imported = attachment("88888888-8888-4888-8888-888888888888");
      await writeFile(join(store.directory, STALLED), "stalled", "utf8");
      await stageImport(store.directory);

      await store.reconcile([]);
      await publishRecord(store.directory, imported);
      await store.syncImportedReferences([imported]);
      held.release();
      await store.whenReconciled();

      await expect(lstat(join(store.directory, STAGING, "ready", "pending.bin"))).resolves.toBeTruthy();
      await expect(lstat(join(store.directory, imported.id))).resolves.toBeTruthy();
      await expect(store.preview(imported.id)).resolves.toMatchObject({ bytes: png });
      await expect(store.usage()).resolves.toEqual({ bytes: png.length, records: 1 });
      expect((await readdir(store.directory)).sort()).toEqual([STAGING, imported.id].sort());
    } finally {
      await store.close();
    }
  });

  it("re-checks committed references before deleting a folder missing from the startup list", async () => {
    const dataDirectory = await root();
    const held = heldCleanupRunner();
    const store = await ConversationAttachmentStore.open(dataDirectory, {
      operationRunner: held.runner,
      reconciliationBatchEntries: 1,
      reconciliationBatchTimeoutMs: 25,
    });
    try {
      const committed = attachment("99999999-9999-4999-8999-999999999999");
      const orphan = attachment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      const referenced = new Set<string>();
      await writeFile(join(store.directory, STALLED), "stalled", "utf8");
      await publishRecord(store.directory, committed);
      await publishRecord(store.directory, orphan);

      await store.reconcile([], { isReferenced: (id) => referenced.has(id) });
      referenced.add(committed.id);
      held.release();
      await store.whenReconciled();

      await expect(lstat(join(store.directory, committed.id))).resolves.toBeTruthy();
      await expect(lstat(join(store.directory, orphan.id))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(store.usage()).resolves.toEqual({ bytes: png.length, records: 1 });
    } finally {
      await store.close();
    }
  });

  it("leaves import staging alone when usage is measured without reconciliation", async () => {
    const dataDirectory = await root();
    const held = heldCleanupRunner();
    const store = await ConversationAttachmentStore.open(dataDirectory, { operationRunner: held.runner });
    try {
      await stageImport(store.directory);
      await writeFile(join(store.directory, ".unexpected"), "junk", "utf8");

      await expect(store.usage()).resolves.toEqual({ bytes: 0, records: 0 });

      expect(await readdir(store.directory)).toEqual([STAGING]);
    } finally {
      await store.close();
    }
  });

  it("resolves the reconciliation wait immediately when nothing is reconciling", async () => {
    const dataDirectory = await root();
    const store = await ConversationAttachmentStore.open(dataDirectory, { operationRunner: heldCleanupRunner().runner });
    try {
      await expect(store.whenReconciled()).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });
});
