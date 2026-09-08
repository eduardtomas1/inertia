import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotFixture } from "../helpers/snapshot-fixture";
import type { SnapshotState } from "../../src/shared/snapshots";
import type { ChatAttachment } from "../../src/shared/contracts";
const native = vi.hoisted(() => ({ handle: vi.fn(), document: vi.fn(), write: vi.fn(), capture: vi.fn(), configure: vi.fn(), revoke: vi.fn(), trigger: null as (() => Promise<void>) | null }));
vi.mock("electron", () => ({ app: { getPath: () => "/private/fixture" }, ipcMain: { handle: native.handle }, shell: { openExternal: vi.fn() }, systemPreferences: { isTrustedAccessibilityClient: vi.fn() } }));
vi.mock("../../src/main/snapshot-preferences", () => ({ readSnapshotPreferences: async () => ({ enabled: true, shortcut: "accelerator" }), writeSnapshotPreferences: native.write }));
vi.mock("../../src/main/attachment-import-ipc", async (original) => ({ ...await original<typeof import("../../src/main/attachment-import-ipc")>(), attachmentImportDocumentFromEvent: native.document }));
vi.mock("../../src/main/snapshot-service", () => ({
  SnapshotError: class extends Error {},
  SnapshotService: class {
    enabled = false;
    disposalStarted = false;
    shortcut: SnapshotState["shortcut"] = "both-shift";
    constructor(trigger: () => Promise<void>) { native.trigger = trigger; }
    state() { return { enabled: this.enabled, shortcut: this.shortcut, available: true, permission: "granted", message: null }; }
    isDisposing() { return this.disposalStarted; }
    async revokeCapture() { this.enabled = false; await native.revoke(); }
    async dispose() { this.disposalStarted = true; }
    async configure(enabled: boolean, shortcut: SnapshotState["shortcut"]) { native.configure(enabled); this.enabled = enabled; this.shortcut = shortcut; return this.state(); }
    capture = native.capture;
  },
}));
import { registerSnapshotIpc } from "../../src/main/snapshot-ipc";
import { SnapshotError } from "../../src/main/snapshot-service";
import { RendererAttachmentImportCoordinator } from "../../src/main/attachment-import-ipc";
beforeEach(() => { vi.clearAllMocks(); native.write.mockResolvedValue(undefined); });
function snapshotWindow() {
  const send = vi.fn();
  const webContents = Object.assign(new EventEmitter(), { send, isDestroyed: vi.fn(() => false), mainFrame: { processId: 1, routingId: 2, frameToken: "original-frame" } });
  return { isFocused: vi.fn(() => true), isDestroyed: vi.fn(() => false), show: vi.fn(), focus: vi.fn(), webContents };
}
async function fixture(realImports = false) {
  const window = snapshotWindow(); const send = window.webContents.send;
  const controller = new AbortController();
  native.document.mockImplementation((event: { window?: typeof window }) => {
    const destination = event.window ?? window;
    return { owner: destination.webContents, processId: destination.webContents.mainFrame.processId, frameId: destination.webContents.mainFrame.routingId, frameToken: destination.webContents.mainFrame.frameToken };
  });
  const importImage = vi.fn(async (): Promise<ChatAttachment[]> => [{ id: "image", name: "snapshot.png", path: "image", mimeType: "image/png", size: 10 }]);
  const rollbackBatch = vi.fn(async (): Promise<void> => undefined);
  const registry = { rollback: vi.fn(async () => undefined), rendererImports: { hold: vi.fn(), commit: vi.fn(async () => undefined), rollback: rollbackBatch }, import: importImage, setSnapshotSource: vi.fn((id, snapshot) => ({ id, snapshot })) };
  const imports = { begin: vi.fn(() => "capture-batch"), importSelection: vi.fn(async (_owner, _id, run) => {
    try { return await run(controller.signal); } catch (error) { controller.abort(); throw error; }
  }), cancel: vi.fn(async () => { controller.abort(); }) };
  const owner = vi.fn((event: { window?: typeof window }) => event.window ?? window);
  const coordinator = new RendererAttachmentImportCoordinator(() => registry);
  const service = registerSnapshotIpc({ owner: owner as never, registry: (() => registry) as never, imports: realImports ? coordinator : imports as never });
  const handler = native.handle.mock.calls[0]![1] as (event: unknown, input: unknown) => Promise<SnapshotState>;
  await handler({}, { type: "state" });
  return { handler, send, imports, importImage, owner, window, controller, service, coordinator, rollbackBatch };
}
describe("snapshot destination and preference boundaries", () => {
  it("releases the sender's destination without disabling snapshot preferences", async () => {
    const { handler, imports, service } = await fixture();
    await handler({}, { type: "configure", enabled: true, shortcut: "accelerator" });
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    await handler({}, { type: "unbind" });
    await native.trigger!();
    expect(imports.begin).not.toHaveBeenCalled(); expect(native.capture).not.toHaveBeenCalled();
    expect(service.state().enabled).toBe(true);
  });
  it.each(["other-window", "replaced-document"])("does not release a destination owned by %s", async (cause) => {
    const { handler, window, send } = await fixture(); const otherWindow = snapshotWindow();
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    if (cause === "replaced-document") native.document.mockReturnValueOnce({ owner: window.webContents, processId: 1, frameId: 2, frameToken: "old-frame" });
    await handler(cause === "other-window" ? { window: otherWindow } : {}, { type: "unbind" });
    native.capture.mockResolvedValueOnce({ png: Buffer.alloc(10), source: snapshotFixture() });
    await native.trigger!(); expect(send).toHaveBeenCalledOnce();
  });
  it("cancels the exact in-flight capture when the last destination unbinds", async () => {
    const { handler, send, imports, window } = await fixture();
    let finish!: (value: unknown) => void;
    native.capture.mockImplementationOnce(async () => await new Promise((resolve) => { finish = resolve; }));
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    const pending = native.trigger!();
    await handler({}, { type: "unbind" });
    finish({ png: Buffer.alloc(10), source: snapshotFixture() }); await pending;
    expect(imports.cancel).toHaveBeenCalledWith(expect.objectContaining({ owner: window.webContents }), "capture-batch");
    expect(send).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled();
  });
  it.each(["worker", "import"])("revokes a held %s lease owned by another window before queued configuration finishes", async (phase) => {
    const { handler, send, imports, importImage, window, controller } = await fixture(); const otherWindow = snapshotWindow();
    await handler({}, { type: "configure", enabled: true, shortcut: "accelerator" });
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    native.capture.mockImplementationOnce(async () => {
      if (phase === "worker") await held;
      return { png: Buffer.alloc(10), source: snapshotFixture() };
    });
    if (phase === "import") importImage.mockImplementationOnce(async () => {
      await held; return [{ id: "image", name: "snapshot.png", path: "image", mimeType: "image/png", size: 10 }];
    });
    // Model the coordinator's cancellation receipt: abort now, drain import before acknowledgment.
    imports.cancel.mockImplementation(async () => { controller.abort(); await held; });
    const pending = native.trigger!();
    if (phase === "import") await vi.waitFor(() => expect(importImage).toHaveBeenCalledOnce());
    await handler({ window: otherWindow }, { type: "bind", conversationId: "22222222-2222-4222-8222-222222222222" });
    let save!: () => void;
    native.write.mockImplementationOnce(async () => await new Promise<void>((resolve) => { save = resolve; }));
    const configuring = handler({}, { type: "configure", enabled: true, shortcut: "accelerator" });
    await vi.waitFor(() => expect(save).toBeDefined());
    let acknowledged = false;
    const disabling = handler({ window: otherWindow }, { type: "configure", enabled: false, shortcut: "accelerator" }).then((state) => { acknowledged = true; return state; });
    const abortedBeforeQueue = controller.signal.aborted;
    save(); await configuring; await Promise.resolve();
    const acknowledgedBeforeImport = acknowledged;
    finish(); await pending; await disabling;
    expect(abortedBeforeQueue).toBe(true);
    expect(acknowledgedBeforeImport).toBe(false);
    expect(imports.cancel).toHaveBeenCalledWith(expect.objectContaining({ owner: window.webContents }), "capture-batch");
    expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(otherWindow.show).not.toHaveBeenCalled(); expect(otherWindow.focus).not.toHaveBeenCalled(); expect(otherWindow.webContents.send).not.toHaveBeenCalled();
    expect((await handler({}, { type: "configure", enabled: true, shortcut: "accelerator" })).enabled).toBe(true);
  });

  it("does not deliver a successful import after disable and re-enable", async () => {
    const { handler, send, imports, window, controller } = await fixture();
    await handler({}, { type: "configure", enabled: true, shortcut: "accelerator" });
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    native.capture.mockResolvedValueOnce({ png: Buffer.alloc(10), source: snapshotFixture() });
    imports.importSelection.mockImplementationOnce(async (_owner, _id, run) => {
      const result = await run(controller.signal);
      await handler({}, { type: "configure", enabled: false, shortcut: "accelerator" });
      await handler({}, { type: "configure", enabled: true, shortcut: "accelerator" });
      return result;
    });
    await native.trigger!();
    expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it("joins a real cancelled import and rollback before acknowledging disable, then can capture again", async () => {
    const { handler, send, importImage, window, coordinator, rollbackBatch } = await fixture(true);
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    let signal!: AbortSignal; let finish!: () => void; let rollback!: () => void;
    native.capture.mockImplementationOnce(async (value: AbortSignal) => { signal = value; return { png: Buffer.alloc(10), source: snapshotFixture() }; });
    importImage.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return [{ id: "image", name: "snapshot.png", path: "image", mimeType: "image/png", size: 10 }];
    });
    rollbackBatch.mockImplementationOnce(async () => await new Promise<void>((resolve) => { rollback = resolve; }));
    const pending = native.trigger!();
    await vi.waitFor(() => expect(finish).toBeDefined());
    let acknowledged = false;
    const disabling = handler({}, { type: "configure", enabled: false, shortcut: "accelerator" }).then((state) => { acknowledged = true; return state; });
    expect(signal.aborted).toBe(true);
    expect(acknowledged).toBe(false);
    finish(); await vi.waitFor(() => expect(rollback).toBeDefined());
    expect(acknowledged).toBe(false);
    rollback(); await disabling; await pending;
    expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect((await handler({}, { type: "configure", enabled: true, shortcut: "accelerator" })).enabled).toBe(true);
    native.capture.mockResolvedValueOnce({ png: Buffer.alloc(10), source: snapshotFixture() });
    await native.trigger!(); expect(send).toHaveBeenCalledOnce();
    await coordinator.dispose();
  });

  it("still disables shortcuts and rejects acknowledgment when capture revocation fails", async () => {
    const { handler } = await fixture();
    native.revoke.mockRejectedValueOnce(new SnapshotError("Snapshot worker cleanup is unconfirmed."));
    await expect(handler({}, { type: "configure", enabled: false, shortcut: "accelerator" })).rejects.toThrow("cleanup is unconfirmed");
    expect(native.configure).toHaveBeenLastCalledWith(false);
  });

  it.each(["save-failure", "native-failure"])("preserves the correct delivery policy on %s", async (cause) => {
    const { handler, send, service, window } = await fixture();
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    let finish!: (value: unknown) => void;
    native.capture.mockImplementationOnce(async () => await new Promise((resolve, reject) => { finish = cause === "save-failure" ? resolve : reject; }));
    const pending = native.trigger!();
    if (cause === "save-failure") {
      native.write.mockRejectedValueOnce(new Error("write failed"));
      await expect(handler({}, { type: "configure", enabled: true, shortcut: "accelerator" })).rejects.toThrow("Snapshots has been disabled");
      finish({ png: Buffer.alloc(10), source: snapshotFixture() }); await pending;
      expect(window.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    } else {
      await service.configure(false, "accelerator");
      finish(new SnapshotError("Snapshot worker cleanup is unconfirmed. Restart Inertia before capturing again.")); await pending;
      expect(send).toHaveBeenCalledWith("inertia:snapshot-ready", expect.objectContaining({ error: expect.stringContaining("cleanup is unconfirmed") }));
    }
  });

  it("disables capture if saving the enabled preference fails", async () => {
    const { handler } = await fixture(); native.write.mockRejectedValueOnce(new Error("write failed"));
    await expect(handler({}, { type: "configure", enabled: true, shortcut: "accelerator" })).rejects.toThrow("Snapshots has been disabled");
    expect(native.configure.mock.calls.slice(-2)).toEqual([[true], [false]]);
    expect((await handler({}, { type: "state" })).enabled).toBe(false);
  });
  it("keeps the destination captured before an in-flight operation even if the chat changes", async () => {
    const { handler, send } = await fixture();
    const before = "11111111-1111-4111-8111-111111111111";
    const after = "22222222-2222-4222-8222-222222222222";
    let finish!: (value: unknown) => void;
    native.capture.mockImplementationOnce(async () => await new Promise((resolve) => { finish = resolve; }));
    await handler({}, { type: "bind", conversationId: before });
    const pending = native.trigger!();
    await handler({}, { type: "bind", conversationId: after });
    finish({ png: Buffer.alloc(10), source: snapshotFixture() }); await pending;
    expect(send).toHaveBeenCalledWith("inertia:snapshot-ready", expect.objectContaining({ conversationId: before, selection: expect.any(Object) }));
  });
  it.each(["replaced-frame", "destroyed-document"])("rejects successful delivery to a %s", async (cause) => {
    const { handler, send, window } = await fixture();
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    native.capture.mockImplementationOnce(async () => {
      if (cause === "replaced-frame") window.webContents.mainFrame.frameToken = "replacement-frame";
      else window.webContents.isDestroyed.mockReturnValue(true);
      return { png: Buffer.alloc(10), source: snapshotFixture() };
    });
    await native.trigger!();
    expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it("rolls back failed imports without exposing filesystem errors", async () => {
    const { handler, send, imports, importImage } = await fixture();
    native.capture.mockResolvedValueOnce({ png: Buffer.alloc(10), source: snapshotFixture() });
    importImage.mockRejectedValueOnce(new Error("ENOENT /private/fixture/never-expose.png"));
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    await native.trigger!();
    expect(imports.cancel).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("inertia:snapshot-ready", expect.objectContaining({ error: "Attachments could not be added safely." }));
  });
  it.each([false, true])("brings the current destination forward before a failure, including an unchanged binding: %s", async (rebind) => {
    const { handler, send, imports, importImage, window } = await fixture();
    window.isFocused.mockReturnValue(false);
    const message = "The foreground window changed. Try the snapshot again.";
    native.capture.mockRejectedValueOnce(new SnapshotError(message));
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    if (rebind) imports.cancel.mockImplementationOnce(async () => { await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" }); });
    await native.trigger!();
    expect(imports.cancel).toHaveBeenCalledOnce();
    expect(importImage).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.show.mock.invocationCallOrder[0]).toBeLessThan(window.focus.mock.invocationCallOrder[0]!);
    expect(window.focus.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(send).toHaveBeenCalledWith("inertia:snapshot-ready", { conversationId: "11111111-1111-4111-8111-111111111111", error: message });
    expect(window.webContents.eventNames()).toEqual([]);
  });
  it("keeps a completed import cancelled before delivery silent", async () => {
    const { handler, send, imports, window, controller } = await fixture();
    native.capture.mockResolvedValueOnce({ png: Buffer.alloc(10), source: snapshotFixture() });
    imports.importSelection.mockImplementationOnce(async (_owner, _id, run) => {
      await run(controller.signal); controller.abort(); throw new Error("Attachment import was cancelled.");
    });
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    await native.trigger!();
    expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(imports.cancel).toHaveBeenCalledOnce();
  });
  it.each(["rejects", "resolves"])("does not refocus a deferred capture that %s after service disposal starts", async (outcome) => {
    const { handler, send, window, controller, service } = await fixture();
    let finishCapture!: (value: unknown) => void;
    native.capture.mockImplementationOnce(async () => await new Promise((resolve, reject) => { finishCapture = outcome === "rejects" ? reject : resolve; }));
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    const pending = native.trigger!();
    await service.dispose();
    expect(controller.signal.aborted).toBe(false);
    finishCapture(outcome === "rejects" ? new SnapshotError("Snapshot capture stopped before completing.") : { png: Buffer.alloc(10), source: snapshotFixture() });
    await pending;
    expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(window.webContents.eventNames()).toEqual([]);
  });
  it("does not refocus a failed capture when service disposal starts during rollback", async () => {
    const { handler, send, imports, window, service } = await fixture();
    let finishRollback!: () => void;
    imports.cancel.mockImplementationOnce(async () => await new Promise<void>((resolve) => { finishRollback = resolve; }));
    native.capture.mockRejectedValueOnce(new SnapshotError("The foreground window changed."));
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    const pending = native.trigger!();
    await vi.waitFor(() => expect(imports.cancel).toHaveBeenCalledOnce());
    await service.dispose(); finishRollback(); await pending;
    expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(window.webContents.eventNames()).toEqual([]);
  });
  it.each(["cancelled", "destroyed-window", "destroyed-document", "navigation", "renderer-gone", "replaced-frame"])("keeps a %s capture failure silent", async (cause) => {
    const { handler, send, imports, window, controller } = await fixture();
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    native.capture.mockImplementationOnce(async () => {
      if (cause === "cancelled") controller.abort();
      if (cause === "destroyed-window") window.isDestroyed.mockReturnValue(true);
      if (cause === "destroyed-document") window.webContents.isDestroyed.mockReturnValue(true);
      if (cause === "navigation") window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      if (cause === "renderer-gone") window.webContents.emit("render-process-gone");
      if (cause === "replaced-frame") window.webContents.mainFrame.frameToken = "replacement-frame";
      throw new SnapshotError("Snapshot cancelled.");
    });
    await native.trigger!();
    expect(imports.cancel).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(window.webContents.eventNames()).toEqual([]);
  });
  it.each(["conversation", "window", "returned-conversation", "navigation-during-rollback"])("does not let a stale failure steal focus after changing %s", async (change) => {
    const { handler, send, imports, window } = await fixture(); const otherWindow = snapshotWindow();
    const before = "11111111-1111-4111-8111-111111111111"; const after = "22222222-2222-4222-8222-222222222222";
    await handler({}, { type: "bind", conversationId: before });
    native.capture.mockRejectedValueOnce(new SnapshotError("The foreground window changed."));
    imports.cancel.mockImplementationOnce(async () => {
      if (change === "navigation-during-rollback") window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      else {
        await handler(change === "window" ? { window: otherWindow } : {}, { type: "bind", conversationId: after });
        if (change === "returned-conversation") await handler({}, { type: "bind", conversationId: before });
      }
    });
    await native.trigger!();
    expect(imports.cancel).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(otherWindow.show).not.toHaveBeenCalled(); expect(otherWindow.focus).not.toHaveBeenCalled(); expect(otherWindow.webContents.send).not.toHaveBeenCalled();
    expect(window.webContents.eventNames()).toEqual([]);
  });
  it("rejects arbitrary capture calls and extra native arguments", async () => {
    const { handler } = await fixture();
    await expect(handler({}, { type: "capture" })).rejects.toThrow();
    await expect(handler({}, { type: "state", path: "/private" })).rejects.toThrow();
    expect(native.capture).not.toHaveBeenCalled();
  });
});
