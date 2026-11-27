import { beforeEach, describe, expect, it, vi } from "vitest";

const { ipcHandlers, openPath } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  openPath: vi.fn(async () => ""),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, listener);
    }),
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath },
}));

import type { AttachmentRegistry } from "../../src/main/attachment-registry";
import type { RendererAttachmentImportCoordinator } from "../../src/main/attachment-import-ipc";
import { attachmentWindowScopeForRegistry } from "../../src/main/attachment-window-scope";
import { registerChatAttachmentIpc } from "../../src/main/chat-attachment-ipc";
import type { ConversationAttachmentAccess } from "../../src/main/conversation-attachment-access";
import type { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { parseAttachmentHandoffRequest } from "../../src/shared/attachment-handoff";
import type { DesktopWindowContext } from "../../src/shared/desktop";
import { DESKTOP_IPC as IPC } from "../../src/shared/desktop-ipc";

const requestId = "11111111-1111-4111-8111-111111111111";
const ownRequestId = "33333333-3333-4333-8333-333333333333";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const ownAttachmentId = "44444444-4444-4444-8444-444444444444";
const retainedPdfId = "55555555-5555-4555-8555-555555555555";

describe("attachment handoff IPC payload", () => {
  it("accepts only one strict request with unique opaque capabilities", () => {
    expect(parseAttachmentHandoffRequest({
      requestId,
      attachmentIds: [attachmentId],
    })).toEqual({ requestId, attachmentIds: [attachmentId] });
    expect(parseAttachmentHandoffRequest({
      requestId,
      attachmentIds: [attachmentId, attachmentId],
    })).toBeNull();
    expect(parseAttachmentHandoffRequest({
      requestId,
      attachmentIds: [attachmentId],
      extra: true,
    })).toBeNull();
    expect(parseAttachmentHandoffRequest({
      requestId: "not-a-request",
      attachmentIds: [attachmentId],
    })).toBeNull();
  });
});

describe("detached-chat attachment lifecycle and external PDF isolation", () => {
  beforeEach(() => {
    ipcHandlers.clear();
    openPath.mockReset().mockResolvedValue("");
  });

  function setup(conversationsByAttachment: Record<string, string[]> = {}) {
    const registry = {
      prepareHandoff: vi.fn(async () => undefined),
      finishHandoff: vi.fn(),
      release: vi.fn(async () => undefined),
      releaseFromRenderer: vi.fn(async () => true),
      resolve: vi.fn(async (id: string) => (
        id === attachmentId || id === ownAttachmentId
          ? { id, mimeType: "application/pdf", path: `/tmp/${id}.pdf` }
          : null
      )),
      import: vi.fn(async () => [{ id: "66666666-6666-4666-8666-666666666666" }]),
    } as unknown as AttachmentRegistry;
    const retained = Promise.resolve({
      preview: vi.fn(async (id: string) => id === retainedPdfId ? {
        attachment: { id, name: "report.pdf", mimeType: "application/pdf", size: 8 },
        bytes: Buffer.from("%PDF-1.7"),
      } : null),
    }) as unknown as ConversationAttachmentAccess;
    const supervisor = {
      ownsAttachment: vi.fn(() => false),
      deferAttachmentRelease: vi.fn(() => false),
      attachmentConversations: vi.fn(async (id: string) => conversationsByAttachment[id] ?? []),
      attachmentReattachContext: vi.fn(async (id: string) => ({
        conversationIds: conversationsByAttachment[id] ?? [],
      })),
    } as unknown as RuntimeSupervisor;
    let activeContext: DesktopWindowContext = { role: "main" };
    registerChatAttachmentIpc({
      owner: vi.fn() as never,
      assertTrusted: () => activeContext,
      registry: () => registry,
      imports: {} as RendererAttachmentImportCoordinator,
      conversationAttachments: () => retained,
      supervisor: () => supervisor,
    });
    const tracker = attachmentWindowScopeForRegistry(registry);
    return {
      registry,
      supervisor,
      tracker,
      setContext: (context: DesktopWindowContext) => { activeContext = context; },
      invoke: async (channel: string, ...args: unknown[]) =>
        await ipcHandlers.get(channel)!({ sender: {} }, ...args),
    };
  }

  it("blocks a detached chat from preparing, finishing, releasing, or opening attachments owned by main or another chat", async () => {
    const { registry, tracker, setContext, invoke } = setup({
      [retainedPdfId]: ["conv-b"],
    });
    tracker.recordAttachment(attachmentId, { kind: "main" });
    tracker.recordHandoff(requestId, { kind: "main" });
    tracker.recordAttachment(ownAttachmentId, { kind: "detached-chat", conversationId: "conv-a" });

    setContext({
      role: "detached-chat",
      conversationId: "conv-a",
      alwaysOnTop: false,
      draft: "",
      terminalIds: [],
    });
    await expect(invoke(IPC.prepareAttachmentHandoff, { requestId: ownRequestId, attachmentIds: [attachmentId] }))
      .rejects.toThrow("Invalid attachment handoff.");
    await expect(invoke(IPC.finishAttachmentHandoff, requestId))
      .rejects.toThrow("Invalid attachment handoff.");
    await expect(invoke(IPC.releaseAttachment, attachmentId))
      .rejects.toThrow("Invalid attachment.");
    await expect(invoke(IPC.openAttachmentExternally, attachmentId))
      .rejects.toThrow("The PDF attachment is unavailable.");
    await expect(invoke(IPC.openAttachmentExternally, retainedPdfId))
      .rejects.toThrow("The PDF attachment is unavailable.");
    expect(registry.prepareHandoff).not.toHaveBeenCalled();
    expect(registry.finishHandoff).not.toHaveBeenCalled();
    expect(registry.releaseFromRenderer).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();

    // Same detached chat can manage and open its own staged attachment and handoff.
    await invoke(IPC.openAttachmentExternally, ownAttachmentId);
    expect(openPath).toHaveBeenCalledWith(`/tmp/${ownAttachmentId}.pdf`);
    await invoke(IPC.prepareAttachmentHandoff, { requestId: ownRequestId, attachmentIds: [ownAttachmentId] });
    expect(registry.prepareHandoff).toHaveBeenCalledTimes(1);
    await invoke(IPC.finishAttachmentHandoff, ownRequestId);
    expect(registry.finishHandoff).toHaveBeenCalledWith(ownRequestId);
    await invoke(IPC.releaseAttachment, ownAttachmentId);
    expect(registry.releaseFromRenderer).toHaveBeenCalledWith(ownAttachmentId);

    // A detached chat for conv-b cannot touch conv-a's handoff or attachment, and can open conv-b's retained PDF.
    tracker.recordAttachment(ownAttachmentId, { kind: "detached-chat", conversationId: "conv-a" });
    tracker.recordHandoff(ownRequestId, { kind: "detached-chat", conversationId: "conv-a" });
    setContext({
      role: "detached-chat",
      conversationId: "conv-b",
      alwaysOnTop: false,
      draft: "",
      terminalIds: [],
    });
    await expect(invoke(IPC.prepareAttachmentHandoff, { requestId, attachmentIds: [ownAttachmentId] }))
      .rejects.toThrow("Invalid attachment handoff.");
    await expect(invoke(IPC.finishAttachmentHandoff, ownRequestId))
      .rejects.toThrow("Invalid attachment handoff.");
    await expect(invoke(IPC.releaseAttachment, ownAttachmentId))
      .rejects.toThrow("Invalid attachment.");
  });
});
