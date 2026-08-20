import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../../src/shared/desktop";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => []),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
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
});
