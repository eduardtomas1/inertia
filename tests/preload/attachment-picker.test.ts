import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../../src/shared/desktop";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => []),
  sendSync: vi.fn(() => true),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    sendSync: electron.sendSync,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

describe("preload attachment picker", () => {
  let bridge: DesktopBridge;

  beforeAll(async () => {
    await import("../../src/preload/index");
    bridge = electron.exposeInMainWorld.mock.calls[0]![1] as DesktopBridge;
  });

  it("forwards the image-only authority to the privileged picker", async () => {
    await bridge.selectAttachments("images");
    expect(electron.invoke).toHaveBeenCalledWith(
      "inertia:select-attachments",
      "images",
    );
  });

  it("reconnects and replays Browser bounds when main has no live lease", async () => {
    electron.invoke.mockReset();
    electron.invoke.mockResolvedValueOnce({});
    const connection = {
      ownerId: "primary" as const,
      contextId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
    };
    await bridge.previewConnect(connection);
    electron.invoke.mockClear();
    electron.invoke
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(true);
    const request = {
      ...connection,
      bounds: { x: 10, y: 20, width: 900, height: 600 },
    };

    await bridge.previewSetBounds(request);

    expect(electron.invoke.mock.calls).toEqual([
      ["inertia:preview-set-bounds", request],
      ["inertia:preview-connect", {
        ...request, recoverMissingLease: true,
      }],
      ["inertia:preview-set-bounds", request],
    ]);
    electron.invoke.mockResolvedValue([]);
  });

  it("applies concurrent Browser bounds in renderer order", async () => {
    electron.invoke.mockReset();
    electron.invoke.mockResolvedValueOnce({});
    const connection = {
      ownerId: "primary" as const,
      contextId: "33333333-3333-4333-8333-333333333333",
      connectionId: "44444444-4444-4444-8444-444444444444",
    };
    await bridge.previewConnect(connection);
    electron.invoke.mockClear();
    let settleFirstBounds!: (accepted: boolean) => void;
    const firstBounds = new Promise<boolean>((resolve) => {
      settleFirstBounds = resolve;
    });
    let boundsCalls = 0;
    electron.invoke.mockImplementation(async (channel: unknown) => {
      if (channel !== "inertia:preview-set-bounds") return {};
      boundsCalls += 1;
      return boundsCalls === 1 ? await firstBounds : true;
    });
    const first = { ...connection, bounds: { x: 1, y: 2, width: 300, height: 200 } };
    const hidden = { ...connection, bounds: null };
    const final = { ...connection, bounds: { x: 3, y: 4, width: 500, height: 400 } };

    const pending = [
      bridge.previewSetBounds(first),
      bridge.previewSetBounds(hidden),
      bridge.previewSetBounds(final),
    ];
    await vi.waitFor(() => expect(electron.invoke.mock.calls).toEqual([
      ["inertia:preview-set-bounds", first],
    ]));
    settleFirstBounds(false);
    await Promise.all(pending);

    expect(electron.invoke.mock.calls).toEqual([
      ["inertia:preview-set-bounds", first],
      ["inertia:preview-connect", { ...first, recoverMissingLease: true }],
      ["inertia:preview-set-bounds", first],
      ["inertia:preview-set-bounds", hidden],
      ["inertia:preview-set-bounds", final],
    ]);
  });

  it("does not recover hidden or closed Browser leases", async () => {
    electron.invoke.mockReset();
    electron.invoke.mockResolvedValueOnce({});
    const connection = {
      ownerId: "primary" as const,
      contextId: "55555555-5555-4555-8555-555555555555",
      connectionId: "66666666-6666-4666-8666-666666666666",
    };
    await bridge.previewConnect(connection);
    electron.invoke.mockClear();
    electron.invoke.mockResolvedValueOnce(false);
    const hidden = { ...connection, bounds: null };

    await bridge.previewSetBounds(hidden);

    expect(electron.invoke.mock.calls).toEqual([
      ["inertia:preview-set-bounds", hidden],
    ]);

    let settleVisibleBounds!: (accepted: boolean) => void;
    const visibleBounds = new Promise<boolean>((resolve) => {
      settleVisibleBounds = resolve;
    });
    electron.invoke.mockReset();
    electron.invoke.mockImplementation(async (channel: unknown) =>
      channel === "inertia:preview-set-bounds" ? await visibleBounds : undefined);
    const visible = {
      ...connection,
      bounds: { x: 10, y: 20, width: 900, height: 600 },
    };
    const pendingBounds = bridge.previewSetBounds(visible);
    await vi.waitFor(() => expect(electron.invoke).toHaveBeenCalledWith(
      "inertia:preview-set-bounds",
      visible,
    ));
    const closing = bridge.previewClose(connection);
    await bridge.previewSetBounds(visible);
    settleVisibleBounds(false);
    await Promise.all([pendingBounds, closing]);

    expect(electron.invoke.mock.calls).toEqual([
      ["inertia:preview-set-bounds", visible],
      ["inertia:preview-close", connection],
    ]);
    electron.invoke.mockResolvedValue([]);
  });

  it("forwards only the opaque lifecycle token with sequential renderer imports", async () => {
    electron.invoke.mockClear();
    const batchId = "11111111-1111-4111-8111-111111111111";
    const files = [{
      name: "safe.pdf",
      mimeType: "application/pdf",
      data: new ArrayBuffer(1),
    }];

    await bridge.beginAttachmentImport();
    await bridge.importAttachments(batchId, files);
    await bridge.commitAttachmentImport(batchId, [batchId]);
    await bridge.cancelAttachmentImport(batchId);

    expect(electron.invoke.mock.calls).toEqual([
      ["inertia:begin-attachment-import"],
      ["inertia:import-attachments", batchId, files],
      ["inertia:commit-attachment-import", batchId, [batchId]],
      ["inertia:cancel-attachment-import", batchId],
    ]);
  });

  it("exposes pending draft hydration and acknowledgement only to main", async () => {
    electron.invoke.mockClear();
    const acknowledgement = {
      conversationId: "11111111-1111-4111-8111-111111111111",
      handoffId: "22222222-2222-4222-8222-222222222222",
    };

    await bridge.getPendingDetachedChatDrafts();
    await bridge.acknowledgeDetachedChatDraft(acknowledgement);

    expect(electron.invoke.mock.calls).toEqual([
      ["inertia:detached-chat-pending-drafts"],
      ["inertia:detached-chat-acknowledge-draft", acknowledgement],
    ]);
  });

  it("subscribes to pending draft handoffs with exact listener cleanup", () => {
    const listener = vi.fn();
    const dispose = bridge.onDetachedChatDraftChanged(listener);
    const registration = electron.on.mock.calls.find(
      ([channel]) => channel === "inertia:detached-chat-draft-changed",
    );
    const handoff = {
      conversationId: "11111111-1111-4111-8111-111111111111",
      draft: "safe handoff",
      handoffId: "22222222-2222-4222-8222-222222222222",
    };

    registration?.[1]({}, handoff);
    expect(listener).toHaveBeenCalledWith(handoff);
    dispose();
    expect(electron.removeListener).toHaveBeenCalledWith(
      "inertia:detached-chat-draft-changed",
      registration?.[1],
    );
  });

  it("subscribes to live popup draft mirrors with exact listener cleanup", () => {
    const listener = vi.fn();
    const dispose = bridge.onDetachedChatDraftMirrored(listener);
    const registration = electron.on.mock.calls.find(
      ([channel]) => channel === "inertia:detached-chat-draft-mirrored",
    );
    const handoff = {
      conversationId: "11111111-1111-4111-8111-111111111111",
      draft: "live popup draft",
    };

    registration?.[1]({}, handoff);
    expect(listener).toHaveBeenCalledWith(handoff);
    dispose();
    expect(electron.removeListener).toHaveBeenCalledWith(
      "inertia:detached-chat-draft-mirrored",
      registration?.[1],
    );
  });
});
