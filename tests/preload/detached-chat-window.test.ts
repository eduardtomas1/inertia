import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "../../src/shared/desktop";
import {
  DETACHED_CHAT_IPC,
  type DetachedChatBridge,
} from "../../src/shared/detached-chat-ipc";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => undefined),
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

describe("detached chat preload", () => {
  let bridge: DetachedChatBridge;

  beforeAll(async () => {
    await import("../../src/preload/detached-chat");
    bridge = electron.exposeInMainWorld.mock.calls[0]![1] as DetachedChatBridge;
  });

  it("exposes only the popup-safe desktop capabilities", () => {
    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
    expect(electron.exposeInMainWorld).toHaveBeenCalledWith(
      "inertia",
      bridge,
    );
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual([
      "closeDetachedChat",
      "copyText",
      "dockDetachedChat",
      "finishAttachmentHandoff",
      "getPlatform",
      "getRuntimeConnection",
      "getWindowContext",
      "importAttachments",
      "onRuntimeReady",
      "openAttachmentExternally",
      "openExternal",
      "openProjectPath",
      "prepareAttachmentHandoff",
      "releaseAttachment",
      "retargetDetachedChat",
      "selectAttachments",
      "setDetachedChatAlwaysOnTop",
    ]);

    for (const forbidden of [
      "openDetachedChat",
      "focusDetachedChat",
      "getDetachedChatWindows",
      "onDetachedChatWindowsChanged",
      "showThreadNotification",
      "checkAppUpdate",
      "exportRecoveryData",
      "getBackendCredentialState",
      "getPrivateConnectState",
      "previewNavigate",
      "getAppHealth",
    ] satisfies (keyof DesktopBridge)[]) {
      expect(bridge).not.toHaveProperty(forbidden);
    }
  });

  it("forwards only the exact sender-bound and chat-safe IPC calls", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const request = { conversationId, title: "Detached chat" };
    const files = [{
      name: "image.png",
      mimeType: "image/png",
      data: new ArrayBuffer(1),
    }];
    const handoff = {
      requestId: "22222222-2222-4222-8222-222222222222",
      attachmentIds: ["33333333-3333-4333-8333-333333333333"],
    };
    const projectPath = {
      projectId: "44444444-4444-4444-8444-444444444444",
      conversationId,
      relativePath: "src/index.ts",
      action: "reveal" as const,
    };

    await bridge.getWindowContext();
    await bridge.setDetachedChatAlwaysOnTop(true);
    await bridge.retargetDetachedChat(request);
    await bridge.dockDetachedChat();
    await bridge.closeDetachedChat();
    await bridge.getRuntimeConnection();
    await bridge.copyText("copy me");
    await bridge.selectAttachments("images");
    await bridge.importAttachments(files);
    await bridge.prepareAttachmentHandoff(handoff);
    await bridge.finishAttachmentHandoff(handoff.requestId);
    await bridge.releaseAttachment(handoff.attachmentIds[0]!);
    await bridge.openAttachmentExternally(handoff.attachmentIds[0]!);
    await bridge.openProjectPath(projectPath);
    await bridge.openExternal("https://example.com/");

    expect(electron.invoke.mock.calls).toEqual([
      [DETACHED_CHAT_IPC.getWindowContext],
      [DETACHED_CHAT_IPC.setAlwaysOnTop, true],
      [DETACHED_CHAT_IPC.retarget, request],
      [DETACHED_CHAT_IPC.dock],
      [DETACHED_CHAT_IPC.close],
      ["inertia:runtime-connection"],
      ["inertia:copy-text", "copy me"],
      ["inertia:select-attachments", "images"],
      ["inertia:import-attachments", files],
      ["inertia:prepare-attachment-handoff", handoff],
      ["inertia:finish-attachment-handoff", handoff.requestId],
      ["inertia:release-attachment", handoff.attachmentIds[0]],
      ["inertia:open-attachment-externally", handoff.attachmentIds[0]],
      ["inertia:open-project-path", projectPath],
      ["inertia:open-external", "https://example.com/"],
    ]);
    expect(bridge.getPlatform()).toBe(process.platform);
  });

  it("subscribes to runtime readiness and removes the exact listener", () => {
    const listener = vi.fn();
    const dispose = bridge.onRuntimeReady(listener);
    expect(electron.on).toHaveBeenCalledOnce();
    expect(electron.on.mock.calls[0]?.[0]).toBe("inertia:runtime-ready");

    const handler = electron.on.mock.calls[0]?.[1] as (() => void) | undefined;
    handler?.();
    expect(listener).toHaveBeenCalledOnce();

    dispose();
    expect(electron.removeListener).toHaveBeenCalledWith(
      "inertia:runtime-ready",
      handler,
    );
  });
});
