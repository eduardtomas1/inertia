import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotFixture } from "../helpers/snapshot-fixture";
import type { SnapshotSource, SnapshotState } from "../../src/shared/snapshots";
import type { ChatAttachment } from "../../src/shared/contracts";
const native = vi.hoisted(() => ({
  handle: vi.fn(), document: vi.fn(), capture: vi.fn(), trigger: null as (() => Promise<void>) | null,
  saved: { enabled: true, shortcut: "accelerator" } as { enabled: boolean; shortcut: string } | null,
  queue: { items: [] as { id: string; png: Buffer; source: SnapshotSource }[], add: vi.fn(), take: vi.fn(), remove: vi.fn(), clear: vi.fn(), prune: vi.fn() },
}));
vi.mock("electron", () => ({ app: { getPath: () => "/private/fixture" }, ipcMain: { handle: native.handle }, shell: { openExternal: vi.fn() }, systemPreferences: { isTrustedAccessibilityClient: vi.fn() } }));
vi.mock("../../src/main/snapshot-preferences", () => ({ readSnapshotPreferences: async () => native.saved, writeSnapshotPreferences: vi.fn(async () => undefined), clearSnapshotPreferences: vi.fn(async () => undefined) }));
vi.mock("../../src/main/attachment-import-ipc", async (original) => ({ ...await original<typeof import("../../src/main/attachment-import-ipc")>(), attachmentImportDocumentFromEvent: native.document }));
vi.mock("../../src/main/snapshot-queue", () => ({
  SNAPSHOT_QUEUE_LIMIT: 2,
  SnapshotQueue: class {
    mayHaveEntries() { return native.queue.items.length > 0; }
    async count() { return native.queue.items.length; }
    async add(png: Buffer, source: SnapshotSource) {
      native.queue.add(png, source);
      if (native.queue.items.length >= 2) return false;
      native.queue.items.push({ id: `queued-${native.queue.items.length + 1}`, png, source }); return true;
    }
    async take() { native.queue.take(); return [...native.queue.items]; }
    async remove(ids: string[]) { native.queue.remove(ids); native.queue.items = native.queue.items.filter(({ id }) => !ids.includes(id)); }
    async clear() { native.queue.clear(); native.queue.items = []; }
    async prune() { native.queue.prune(); }
  },
}));
vi.mock("../../src/main/snapshot-service", () => ({
  SnapshotError: class extends Error {},
  SnapshotService: class {
    enabled = false;
    shortcut: SnapshotState["shortcut"] = "both-shift";
    constructor(trigger: () => Promise<void>, _failure: unknown, private readonly stopOwned: () => Promise<void>) { native.trigger = trigger; }
    state() { return { enabled: this.enabled, shortcut: this.shortcut, available: true, permission: "granted", message: null }; }
    isDisposing() { return false; }
    async revokeCapture() { this.enabled = false; }
    async dispose() { await this.stopOwned(); }
    async configure(enabled: boolean, shortcut: SnapshotState["shortcut"]) { this.enabled = enabled; this.shortcut = shortcut; return this.state(); }
    capture = native.capture;
  },
}));
vi.mock("../../src/main/snapshot-review", () => ({ SnapshotReviewService: class {
  request = vi.fn(); cancel = vi.fn(async () => undefined); stop = vi.fn(async () => undefined);
} }));
import { registerSnapshotIpc, SNAPSHOT_BUSY, SNAPSHOT_QUEUE_FULL } from "../../src/main/snapshot-ipc";
import { SnapshotError } from "../../src/main/snapshot-service";

const conversationId = "11111111-1111-4111-8111-111111111111";
const captured = (title = "Release checklist") => ({ png: Buffer.from(title), source: { ...snapshotFixture(), windowTitle: title } });
function snapshotWindow() {
  const webContents = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: vi.fn(() => false), mainFrame: { processId: 1, routingId: 2, frameToken: "frame" } });
  return { isFocused: vi.fn(() => true), isDestroyed: vi.fn(() => false), show: vi.fn(), focus: vi.fn(), webContents };
}
beforeEach(() => {
  vi.clearAllMocks();
  native.queue.items = [];
  native.saved = { enabled: true, shortcut: "accelerator" };
});
async function fixture(initiallyOpen = true) {
  let mainOpen = initiallyOpen;
  const main = snapshotWindow();
  const focusMainWindow = vi.fn();
  const chat = snapshotWindow();
  native.document.mockImplementation((event: { window?: typeof chat }) => {
    const destination = event.window ?? chat;
    return { owner: destination.webContents, processId: 1, frameId: 2, frameToken: "frame" };
  });
  const importImage = vi.fn(async (values: { name: string }[]): Promise<ChatAttachment[]> =>
    values.map(({ name }, index) => ({ id: `image-${importImage.mock.calls.length}-${index}`, name, path: "image", mimeType: "image/png", size: 10 })));
  const registry = { import: importImage, setSnapshotSource: vi.fn((id: string, snapshot: SnapshotSource) => ({ id, snapshot })) };
  const imports = { begin: vi.fn(() => "queue-batch"), importSelection: vi.fn(async (_owner, _id, run) => await run(new AbortController().signal)), cancel: vi.fn(async () => undefined) };
  const service = registerSnapshotIpc({ owner: ((event: { window?: typeof chat }) => event.window ?? chat) as never, mainWindow: () => (mainOpen ? main : null) as never, focusMainWindow, registry: (() => registry) as never, imports: imports as never });
  const handler = native.handle.mock.calls[0]![1] as (event: unknown, input: unknown) => Promise<SnapshotState>;
  await handler({}, { type: "state" });
  return { handler, main, chat, imports, importImage, registry, service, focusMainWindow, reopen: () => { mainOpen = true; } };
}

describe("shortcut outcomes", () => {
  it("explains a shortcut pressed while a capture is running without moving focus", async () => {
    const { handler, main, chat } = await fixture();
    await handler({}, { type: "bind", conversationId });
    let finish!: (value: unknown) => void;
    native.capture.mockImplementationOnce(async () => await new Promise((resolve) => { finish = resolve; }));
    const running = native.trigger!();
    await native.trigger!();
    expect(native.capture).toHaveBeenCalledOnce();
    expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith("inertia:snapshot-ready", { notice: SNAPSHOT_BUSY });
    expect(main.focus).not.toHaveBeenCalled(); expect(main.show).not.toHaveBeenCalled(); expect(chat.focus).not.toHaveBeenCalled();
    finish(captured()); await running;
    expect(chat.webContents.send).toHaveBeenCalledWith("inertia:snapshot-ready", expect.objectContaining({ conversationId, selection: expect.any(Object) }));
  });

  it("queues a capture taken while no chat is open and asks the main window to open one", async () => {
    const { main, imports } = await fixture();
    native.capture.mockResolvedValueOnce(captured());
    await native.trigger!();
    expect(native.queue.add).toHaveBeenCalledOnce();
    expect(native.queue.items).toHaveLength(1);
    expect(imports.begin).not.toHaveBeenCalled();
    expect(main.show).toHaveBeenCalledOnce(); expect(main.focus).toHaveBeenCalledOnce();
    expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith("inertia:snapshot-ready", { pending: true });
  });

  it("queues a capture when the bound chat's window closed", async () => {
    const { handler, chat, main } = await fixture();
    await handler({}, { type: "bind", conversationId });
    chat.isDestroyed.mockReturnValue(true);
    native.capture.mockResolvedValueOnce(captured());
    await native.trigger!();
    expect(native.queue.items).toHaveLength(1);
    expect(main.webContents.send).toHaveBeenCalledWith("inertia:snapshot-ready", { pending: true });
  });

  it("opens the main window for a queued capture after the macOS window was closed", async () => {
    const { focusMainWindow } = await fixture(false);
    native.capture.mockResolvedValueOnce(captured());
    await native.trigger!();
    expect(native.queue.items).toHaveLength(1);
    expect(focusMainWindow).toHaveBeenCalledOnce();
  });

  it("shows a failure from while the macOS window was closed once the reopened window binds a chat", async () => {
    const { handler, main, focusMainWindow, reopen } = await fixture(false);
    native.capture.mockRejectedValueOnce(new SnapshotError("The foreground window changed. Try the snapshot again."));
    await native.trigger!();
    expect(focusMainWindow).toHaveBeenCalledOnce();
    reopen();
    await handler({ window: main }, { type: "bind", conversationId });
    expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith("inertia:snapshot-ready", { notice: "The foreground window changed. Try the snapshot again." });
    await handler({ window: main }, { type: "bind", conversationId });
    expect(main.webContents.send).toHaveBeenCalledOnce();
  });

  it("does not open a closed main window for a busy press", async () => {
    const { handler, focusMainWindow } = await fixture(false);
    await handler({}, { type: "bind", conversationId });
    let finish!: (value: unknown) => void;
    native.capture.mockImplementationOnce(async () => await new Promise((resolve) => { finish = resolve; }));
    const running = native.trigger!();
    await native.trigger!();
    expect(focusMainWindow).not.toHaveBeenCalled();
    finish(captured()); await running;
  });

  it("explains a capture failure in the main window when no chat is open", async () => {
    const { main } = await fixture();
    native.capture.mockRejectedValueOnce(new SnapshotError("The foreground window changed. Try the snapshot again."));
    await native.trigger!();
    expect(native.queue.items).toHaveLength(0);
    expect(main.focus).toHaveBeenCalledOnce();
    expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith("inertia:snapshot-ready", { notice: "The foreground window changed. Try the snapshot again." });
  });

  it("does not take pixels when the queue is full and says why", async () => {
    const { main } = await fixture();
    native.queue.items = [{ id: "a", ...captured("A") }, { id: "b", ...captured("B") }];
    await native.trigger!();
    expect(native.capture).not.toHaveBeenCalled();
    expect(main.webContents.send.mock.calls).toEqual([["inertia:snapshot-ready", { pending: true }], ["inertia:snapshot-ready", { notice: SNAPSHOT_QUEUE_FULL }]]);
  });
});

describe("queued capture delivery", () => {
  it("delivers queued captures oldest first to the next chat that binds, then forgets them", async () => {
    const { handler, chat, imports, importImage, registry } = await fixture();
    native.queue.items = [{ id: "a", ...captured("First") }, { id: "b", ...captured("Second") }];
    await handler({}, { type: "bind", conversationId });
    await vi.waitFor(() => expect(chat.webContents.send).toHaveBeenCalled());
    expect(imports.begin).toHaveBeenCalledOnce();
    expect(importImage.mock.calls.map(([values]) => (values[0] as unknown as { data: Buffer }).data.toString())).toEqual(["First", "Second"]);
    expect(registry.setSnapshotSource.mock.calls.map(([, source]) => source.windowTitle)).toEqual(["First", "Second"]);
    expect(chat.webContents.send).toHaveBeenCalledExactlyOnceWith("inertia:snapshot-ready", {
      conversationId, selection: { batchId: "queue-batch", attachments: [expect.objectContaining({ id: "image-1-0" }), expect.objectContaining({ id: "image-2-0" })] },
    });
    await vi.waitFor(() => expect(native.queue.remove).toHaveBeenCalledWith(["a", "b"]));
    expect(native.queue.items).toEqual([]);
  });

  it("keeps queued captures for the next chat when the destination closes during delivery", async () => {
    const { handler, chat, imports } = await fixture();
    native.queue.items = [{ id: "a", ...captured() }];
    imports.importSelection.mockImplementationOnce(async (_owner, _id, run) => {
      const result = await run(new AbortController().signal);
      chat.webContents.emit("render-process-gone");
      return result;
    });
    await handler({}, { type: "bind", conversationId });
    await vi.waitFor(() => expect(imports.cancel).toHaveBeenCalledOnce());
    expect(chat.webContents.send).not.toHaveBeenCalled();
    expect(native.queue.remove).not.toHaveBeenCalled();
    expect(native.queue.items).toHaveLength(1);
  });

  it("explains a queued delivery failure once and does not retry it on every focus", async () => {
    const { handler, chat, importImage } = await fixture();
    native.queue.items = [{ id: "a", ...captured() }];
    importImage.mockRejectedValueOnce(new Error("ENOENT /private/fixture/never-expose.png"));
    await handler({}, { type: "bind", conversationId });
    await vi.waitFor(() => expect(native.queue.remove).toHaveBeenCalledWith(["a"]));
    expect(chat.webContents.send).toHaveBeenCalledExactlyOnceWith("inertia:snapshot-ready", { conversationId, error: "Attachments could not be added safely." });
    await handler({}, { type: "bind", conversationId });
    expect(chat.webContents.send).toHaveBeenCalledOnce();
  });

  it("delivers a capture queued while the bound chat was gone once a chat binds again", async () => {
    const { handler, chat, main } = await fixture();
    native.capture.mockResolvedValueOnce(captured());
    await native.trigger!();
    expect(main.webContents.send).toHaveBeenCalledWith("inertia:snapshot-ready", { pending: true });
    await handler({}, { type: "bind", conversationId });
    await vi.waitFor(() => expect(chat.webContents.send).toHaveBeenCalledWith("inertia:snapshot-ready", expect.objectContaining({ conversationId, selection: expect.any(Object) })));
  });

  it("removes queued captures when snapshots is disabled and does not deliver them afterwards", async () => {
    const { handler, chat } = await fixture();
    native.queue.items = [{ id: "a", ...captured() }];
    await handler({}, { type: "configure", enabled: false, shortcut: "accelerator" });
    expect(native.queue.clear).toHaveBeenCalled();
    await handler({}, { type: "configure", enabled: true, shortcut: "accelerator" });
    await handler({}, { type: "bind", conversationId });
    await Promise.resolve();
    expect(chat.webContents.send).not.toHaveBeenCalled();
  });

  it("removes queued captures when Inertia quits", async () => {
    const { service } = await fixture();
    native.queue.items = [{ id: "a", ...captured() }];
    await service.dispose();
    expect(native.queue.clear).toHaveBeenCalled();
    expect(native.queue.items).toEqual([]);
  });

  it("removes queued captures at launch when snapshots was left disabled", async () => {
    native.saved = { enabled: false, shortcut: "accelerator" };
    await fixture();
    expect(native.queue.clear).toHaveBeenCalledOnce();
    expect(native.queue.prune).not.toHaveBeenCalled();
  });
});
