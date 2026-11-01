import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RendererAttachmentImportCoordinator } from "../../src/main/attachment-import-ipc";
import {
  REATTACH_CHANGED_ERROR,
  REATTACH_MISSING_ERROR,
  REATTACH_UNAVAILABLE_ERROR,
  REATTACH_UNREADABLE_ERROR,
  importRetainedAttachment,
  privacySafeReattachError,
  registerAttachmentReattachIpc,
} from "../../src/main/attachment-reattach";
import { AttachmentRegistry } from "../../src/main/attachment-registry";
import {
  ConversationAttachmentStore,
  type ConversationAttachmentStoreOperationRunner,
} from "../../src/node/conversation-attachment-store";
import type { DesktopAttachmentImportSelection, DesktopWindowContext } from "../../src/shared/desktop";

const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const textId = "11111111-1111-4111-8111-111111111111";
const imageId = "22222222-2222-4222-8222-222222222222";
const absentId = "33333333-3333-4333-8333-333333333333";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZY2BgYPgPAAEEAQB9ssjfAAAAAElFTkSuQmCC",
  "base64",
);
const text = Buffer.from("Quarterly notes\nline two\n");
const roots: string[] = [];
const disposers: (() => Promise<void>)[] = [];

async function root(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

const persistRunner: ConversationAttachmentStoreOperationRunner = (operation, signal) => {
  const result = (async () => {
    signal?.throwIfAborted();
    if (operation.operation === "remove") {
      await rm(join(operation.root, operation.name), { recursive: true, force: true });
      return;
    }
    const record = join(operation.root, operation.id);
    await mkdir(record, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(record, 0o700);
    const content = join(record, `${operation.id}.${operation.extension}`);
    await writeFile(content, operation.bytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(record, "metadata.json"), operation.metadata, { encoding: "utf8", flag: "wx", mode: 0o600 });
  })();
  return { result, stopped: result.then(() => undefined, () => undefined) };
};

async function fixture() {
  const store = await ConversationAttachmentStore.open(await root("inertia-reattach-store-"), {
    operationRunner: persistRunner,
  });
  const registry = new AttachmentRegistry(await root("inertia-reattach-drafts-"));
  disposers.push(async () => {
    await registry.dispose();
    await store.close();
  });
  await store.retain([
    { attachment: { id: textId, name: "notes.txt", path: "/transient/notes.txt", mimeType: "text/plain", size: text.length }, bytes: text },
    { attachment: { id: imageId, name: "shot.png", path: "/transient/shot.png", mimeType: "image/png", size: png.length }, bytes: png },
  ]);
  const contentPath = (id: string, extension: string): string => join(store.directory, id, `${id}.${extension}`);
  return { store, registry, contentPath };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(disposers.splice(0).map(async (dispose) => await dispose()));
  await Promise.all(roots.splice(0).map(async (directory) =>
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("re-attaching a retained attachment", () => {
  it.each([
    { id: textId, name: "notes.txt", mimeType: "text/plain", bytes: text },
    { id: imageId, name: "shot.png", mimeType: "image/png", bytes: png },
  ])("copies $name into a fresh draft capability without exposing a path", async ({ id, name, mimeType, bytes }) => {
    const { store, registry } = await fixture();

    const [draft, ...rest] = await importRetainedAttachment(registry, store, id, new AbortController().signal);

    expect(rest).toEqual([]);
    expect(draft).toMatchObject({ name, mimeType, size: bytes.length });
    expect(draft!.id).not.toBe(id);
    expect(draft!.path).toBe(draft!.id);
    const temporary = await registry.resolve(draft!.id);
    expect(await readFile(temporary!.path)).toEqual(bytes);
    // The retained original is untouched and still resolvable for its message.
    expect((await store.resolve(id))?.attachment.size).toBe(bytes.length);
    expect(registry.usage().records).toBe(1);
  });

  it("fails with a readable error when the stored file no longer exists", async () => {
    const { store, registry, contentPath } = await fixture();

    await expect(importRetainedAttachment(registry, store, absentId, new AbortController().signal))
      .rejects.toThrow(REATTACH_MISSING_ERROR);
    await unlink(contentPath(textId, "txt"));
    await expect(importRetainedAttachment(registry, store, textId, new AbortController().signal))
      .rejects.toThrow(REATTACH_UNREADABLE_ERROR);
    await rm(join(store.directory, imageId), { recursive: true });
    await expect(importRetainedAttachment(registry, store, imageId, new AbortController().signal))
      .rejects.toThrow(REATTACH_MISSING_ERROR);
    expect(registry.usage().records).toBe(0);
  });

  it("refuses retained content that changed after it was stored", async () => {
    const { store, registry, contentPath } = await fixture();
    const tampered = Buffer.from(text);
    tampered[0] = "q".charCodeAt(0);
    await writeFile(contentPath(textId, "txt"), tampered);

    await expect(importRetainedAttachment(registry, store, textId, new AbortController().signal))
      .rejects.toThrow(REATTACH_UNREADABLE_ERROR);
    expect(registry.usage().records).toBe(0);
  });

  it("revalidates the store receipt in main before copying", async () => {
    const { store, registry } = await fixture();
    const receipt = (await store.resolve(textId))!;
    const outside = join(await root("inertia-reattach-escape-"), `${textId}.txt`);
    await writeFile(outside, text);
    for (const forged of [
      { ...receipt, source: { ...receipt.source!, digest: "0".repeat(64) } },
      { ...receipt, source: { ...receipt.source!, path: outside } },
      { ...receipt, attachment: { ...receipt.attachment, id: imageId } },
      { ...receipt, attachment: { ...receipt.attachment, size: receipt.attachment.size + 1 } },
    ]) {
      const source = { directory: store.directory, resolve: vi.fn(async () => forged) };
      await expect(importRetainedAttachment(registry, source, textId, new AbortController().signal))
        .rejects.toThrow(REATTACH_CHANGED_ERROR);
    }
    expect(registry.usage().records).toBe(0);
  });

  it.skipIf(process.platform === "win32")("refuses a retained file replaced by a symbolic link", async () => {
    const { store, registry, contentPath } = await fixture();
    const outside = join(await root("inertia-reattach-outside-"), "notes.txt");
    await writeFile(outside, text);
    const target = contentPath(textId, "txt");
    await unlink(target);
    await symlink(outside, target);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);

    await expect(importRetainedAttachment(registry, store, textId, new AbortController().signal))
      .rejects.toThrow(REATTACH_UNREADABLE_ERROR);
    expect(registry.usage().records).toBe(0);
  });

  it("keeps temporary storage caps: a full draft store refuses the copy", async () => {
    const { store } = await fixture();
    const registry = new AttachmentRegistry(await root("inertia-reattach-full-"), { maxRecords: 1 });
    disposers.push(async () => await registry.dispose());
    await importRetainedAttachment(registry, store, textId, new AbortController().signal);

    const failure = await importRetainedAttachment(registry, store, imageId, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(privacySafeReattachError(failure).message)
      .toBe("Temporary attachment storage is full. Remove an attachment and try again.");
    expect(registry.usage().records).toBe(1);
  });

  it("reports retained storage failures without leaking details", async () => {
    const { registry } = await fixture();
    const broken = {
      directory: "/nonexistent",
      resolve: vi.fn(async () => { throw new Error("EACCES /private/user/path"); }),
    };
    await expect(importRetainedAttachment(registry, broken, textId, new AbortController().signal))
      .rejects.toThrow(REATTACH_UNAVAILABLE_ERROR);
    expect(privacySafeReattachError(new Error("EACCES /private/user/path")).message)
      .toBe("This file could not be re-attached safely.");
  });
});

class FakeSender extends EventEmitter {
  readonly mainFrame = { frameToken: "frame-one" };
  isDestroyed(): boolean { return false; }
}

function registerHandler(options: {
  context?: DesktopWindowContext;
  retained: () => Promise<ConversationAttachmentStore> | null;
  registry: AttachmentRegistry;
  attachmentConversations?: (attachmentId: string) => Promise<readonly string[]>;
}) {
  let handler!: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<DesktopAttachmentImportSelection>;
  const imports = new RendererAttachmentImportCoordinator(() => options.registry);
  registerAttachmentReattachIpc({
    ipcMain: { handle: (_channel: string, listener: typeof handler) => { handler = listener; } } as never,
    channel: "inertia:reattach-attachment",
    assertTrusted: (_event, count, expected) => {
      if (count !== expected) throw new Error("Rejected untrusted renderer request");
      return options.context ?? { role: "main" };
    },
    registry: () => options.registry,
    imports,
    retained: options.retained,
    ...(options.attachmentConversations ? { attachmentConversations: options.attachmentConversations } : {}),
  });
  const sender = new FakeSender();
  const event = { sender, senderFrame: sender.mainFrame, processId: 7, frameId: 9 } as unknown as IpcMainInvokeEvent;
  return { invoke: async (...args: unknown[]) => await handler(event, ...args), imports, event };
}

describe("re-attach IPC", () => {
  it("returns an import lease for one validated request and cancels it cleanly", async () => {
    const { store, registry } = await fixture();
    const { invoke, imports, event } = registerHandler({ registry, retained: () => Promise.resolve(store) });

    const selection = await invoke({ conversationId, attachmentId: textId });

    expect(selection.attachments).toHaveLength(1);
    expect(selection.attachments[0]).toMatchObject({ name: "notes.txt", mimeType: "text/plain" });
    expect(registry.usage().records).toBe(1);
    await imports.cancel({ owner: event.sender as never, processId: 7, frameId: 9, frameToken: "frame-one" }, selection.batchId);
    expect(registry.usage().records).toBe(0);
  });

  it.each([
    [undefined],
    [{ conversationId, attachmentId: "../notes.txt" }],
    [{ conversationId: "not-a-chat", attachmentId: textId }],
    [{ conversationId, attachmentId: textId, path: "/etc/passwd" }],
  ])("rejects malformed payload %j", async (payload) => {
    const { store, registry } = await fixture();
    const { invoke } = registerHandler({ registry, retained: () => Promise.resolve(store) });
    await expect(invoke(payload)).rejects.toThrow("Invalid attachment.");
    expect(registry.usage().records).toBe(0);
  });

  it("keeps a detached chat window inside its own conversation", async () => {
    const { store, registry } = await fixture();
    const { invoke } = registerHandler({
      registry,
      retained: () => Promise.resolve(store),
      context: { role: "detached-chat", conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } as DesktopWindowContext,
    });
    await expect(invoke({ conversationId, attachmentId: textId })).rejects.toThrow("Invalid attachment.");
  });

  it("re-attaches only a file sent in the requesting chat when ownership is known", async () => {
    const { store, registry } = await fixture();
    const owners = new Map<string, readonly string[]>([[textId, [conversationId]], [imageId, ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]]]);
    const lookups: string[] = [];
    const { invoke } = registerHandler({
      registry,
      retained: () => Promise.resolve(store),
      attachmentConversations: async (attachmentId) => {
        lookups.push(attachmentId);
        return owners.get(attachmentId) ?? [];
      },
    });
    await expect(invoke({ conversationId, attachmentId: imageId })).rejects.toThrow("Invalid attachment.");
    await expect(invoke({ conversationId, attachmentId: absentId })).rejects.toThrow("Invalid attachment.");
    expect(registry.usage().records).toBe(0);
    const selection = await invoke({ conversationId, attachmentId: textId });
    expect(selection.attachments).toHaveLength(1);
    expect(lookups).toEqual([imageId, absentId, textId]);

    const failing = registerHandler({
      registry,
      retained: () => Promise.resolve(store),
      attachmentConversations: async () => { throw new Error("runtime offline"); },
    });
    await expect(failing.invoke({ conversationId, attachmentId: textId })).rejects.toThrow(REATTACH_UNAVAILABLE_ERROR);
  });

  it("surfaces missing files and unavailable storage as readable errors and leaves no draft copy", async () => {
    const { store, registry } = await fixture();
    const missing = registerHandler({ registry, retained: () => Promise.resolve(store) });
    await expect(missing.invoke({ conversationId, attachmentId: absentId })).rejects.toThrow(REATTACH_MISSING_ERROR);
    const unavailable = registerHandler({ registry, retained: () => null });
    await expect(unavailable.invoke({ conversationId, attachmentId: textId })).rejects.toThrow(REATTACH_UNAVAILABLE_ERROR);
    expect(registry.usage().records).toBe(0);
  });
});
