import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotFixture } from "../helpers/snapshot-fixture";
import type { SnapshotState } from "../../src/shared/snapshots";
const native = vi.hoisted(() => ({ handle: vi.fn(), write: vi.fn(), capture: vi.fn(), configure: vi.fn(), trigger: null as (() => Promise<void>) | null }));
vi.mock("electron", () => ({ app: { getPath: () => "/private/fixture" }, ipcMain: { handle: native.handle }, shell: { openExternal: vi.fn() }, systemPreferences: { isTrustedAccessibilityClient: vi.fn() } }));
vi.mock("../../src/main/snapshot-preferences", () => ({ readSnapshotPreferences: async () => null, writeSnapshotPreferences: native.write }));
vi.mock("../../src/main/attachment-import-ipc", () => ({ attachmentImportDocumentFromEvent: (event: unknown) => event }));
vi.mock("../../src/main/snapshot-service", () => ({
  SnapshotError: class extends Error {},
  SnapshotService: class {
    enabled = false;
    shortcut: SnapshotState["shortcut"] = "both-shift";
    constructor(trigger: () => Promise<void>) { native.trigger = trigger; }
    state() { return { enabled: this.enabled, shortcut: this.shortcut, available: true, permission: "granted", message: null }; }
    async configure(enabled: boolean, shortcut: SnapshotState["shortcut"]) { native.configure(enabled); this.enabled = enabled; this.shortcut = shortcut; return this.state(); }
    capture = native.capture;
  },
}));
import { registerSnapshotIpc } from "../../src/main/snapshot-ipc";
beforeEach(() => { vi.clearAllMocks(); native.write.mockResolvedValue(undefined); });
function fixture() {
  const send = vi.fn();
  const window = { isFocused: () => true, isDestroyed: () => false, show: vi.fn(), focus: vi.fn(), webContents: { send } };
  const importImage = vi.fn(async () => [{ id: "image", name: "snapshot.png", path: "image", mimeType: "image/png", size: 10 }]);
  const registry = { import: importImage, setSnapshotSource: vi.fn((id, snapshot) => ({ id, snapshot })) };
  const imports = { begin: vi.fn(() => "capture-batch"), importSelection: vi.fn(async (_owner, _id, run) => await run(new AbortController().signal)), cancel: vi.fn(async () => undefined) };
  const owner = vi.fn(() => window);
  registerSnapshotIpc({ owner: owner as never, registry: (() => registry) as never, imports: imports as never });
  const handler = native.handle.mock.calls[0]![1] as (event: unknown, input: unknown) => Promise<SnapshotState>;
  return { handler, send, imports, importImage, owner };
}
describe("snapshot destination and preference boundaries", () => {
  it("disables capture if saving the enabled preference fails", async () => {
    const { handler } = fixture(); native.write.mockRejectedValueOnce(new Error("write failed"));
    await expect(handler({}, { type: "configure", enabled: true, shortcut: "accelerator" })).rejects.toThrow("Snapshots has been disabled");
    expect(native.configure.mock.calls).toEqual([[true], [false]]);
    expect((await handler({}, { type: "state" })).enabled).toBe(false);
  });
  it("keeps the destination captured before an in-flight operation even if the chat changes", async () => {
    const { handler, send } = fixture();
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
  it("rolls back failed imports without exposing filesystem errors", async () => {
    const { handler, send, imports, importImage } = fixture();
    native.capture.mockResolvedValueOnce({ png: Buffer.alloc(10), source: snapshotFixture() });
    importImage.mockRejectedValueOnce(new Error("ENOENT /private/fixture/never-expose.png"));
    await handler({}, { type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
    await native.trigger!();
    expect(imports.cancel).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("inertia:snapshot-ready", expect.objectContaining({ error: "Attachments could not be added safely." }));
  });
  it("rejects arbitrary capture calls and extra native arguments", async () => {
    const { handler } = fixture();
    await expect(handler({}, { type: "capture" })).rejects.toThrow();
    await expect(handler({}, { type: "state", path: "/private" })).rejects.toThrow();
    expect(native.capture).not.toHaveBeenCalled();
  });
});
