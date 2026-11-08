import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";

import type { DesktopWindowContext } from "../shared/desktop.js";
import { DESKTOP_IPC as IPC } from "../shared/desktop-ipc.js";
import { registerAttachmentLifecycleIpc } from "./attachment-ipc.js";
import { registerRendererAttachmentImportIpc, type RendererAttachmentImportCoordinator } from "./attachment-import-ipc.js";
import type { AttachmentRegistry } from "./attachment-registry.js";
import { registerAttachmentReattachIpc } from "./attachment-reattach.js";
import { registerAttachmentSelectionIpc } from "./attachment-selection-ipc.js";
import { privacySafeAttachmentImportError } from "./attachment-selection-import.js";
import { openPdfAttachment, type ConversationAttachmentAccess } from "./conversation-attachment-access.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Registers the chat window's attachment channels: picking, importing,
 * re-attaching a sent file, handing files to the runtime, and opening a PDF.
 */
export function registerChatAttachmentIpc(options: {
  owner(event: IpcMainInvokeEvent, count: number): BrowserWindow;
  assertTrusted(event: IpcMainInvokeEvent, argumentCount: number, expectedArguments?: number): DesktopWindowContext;
  registry(): AttachmentRegistry;
  imports: RendererAttachmentImportCoordinator;
  conversationAttachments(): ConversationAttachmentAccess | null;
  supervisor(): RuntimeSupervisor | null;
}): void {
  const { assertTrusted, registry, imports } = options;
  registerAttachmentSelectionIpc({ owner: options.owner, registry, imports });
  registerRendererAttachmentImportIpc({
    ipcMain,
    channels: {
      begin: IPC.beginAttachmentImport,
      importOne: IPC.importAttachments,
      commit: IPC.commitAttachmentImport,
      cancel: IPC.cancelAttachmentImport,
    },
    assertTrusted,
    coordinator: imports,
    sanitizeError: privacySafeAttachmentImportError,
  });
  registerAttachmentReattachIpc({
    ipcMain, channel: IPC.reattachAttachment, assertTrusted, registry, imports,
    retained: () => options.conversationAttachments(),
    attachmentConversations: async (attachmentId) => {
      const supervisor = options.supervisor();
      if (!supervisor) throw new Error("The local runtime is not available");
      return await supervisor.attachmentConversations(attachmentId);
    },
  });
  registerAttachmentLifecycleIpc({
    channels: {
      prepare: IPC.prepareAttachmentHandoff,
      finish: IPC.finishAttachmentHandoff,
      release: IPC.releaseAttachment,
    },
    assertTrusted,
    registry,
    supervisor: options.supervisor,
  });
  ipcMain.handle(IPC.openAttachmentExternally, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const [value] = args;
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Error("Invalid attachment.");
    }
    await openPdfAttachment(registry(), options.conversationAttachments(), value);
  });
}
