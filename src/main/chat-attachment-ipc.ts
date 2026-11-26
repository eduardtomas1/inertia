import { ipcMain, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";

import type { ChatAttachment } from "../shared/contracts.js";
import type { DesktopWindowContext } from "../shared/desktop.js";
import { DESKTOP_IPC as IPC } from "../shared/desktop-ipc.js";
import { registerAttachmentLifecycleIpc } from "./attachment-ipc.js";
import {
  registerRendererAttachmentImportIpc,
  type AttachmentImportDocument,
  type RendererAttachmentImportCoordinator,
} from "./attachment-import-ipc.js";
import type { AttachmentRegistry } from "./attachment-registry.js";
import { registerAttachmentReattachIpc } from "./attachment-reattach.js";
import { registerAttachmentSelectionIpc } from "./attachment-selection-ipc.js";
import { privacySafeAttachmentImportError } from "./attachment-selection-import.js";
import {
  attachmentWindowOwnerForContext,
  attachmentWindowScopeForRegistry,
  authorizeAttachmentForConversationScope,
  type AttachmentWindowOwner,
} from "./attachment-window-scope.js";
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
  const senderOwners = new WeakMap<object, AttachmentWindowOwner>();
  const recordAttachmentsForSender = (
    sender: object,
    attachments: readonly { id: string }[],
  ): void => {
    const owner = senderOwners.get(sender);
    if (!owner || attachments.length === 0) return;
    attachmentWindowScopeForRegistry(registry()).recordAttachments(
      attachments.map((attachment) => attachment.id),
      owner,
    );
  };
  const assertTrustedAndTrack = (
    event: IpcMainInvokeEvent,
    argumentCount: number,
    expectedArguments?: number,
  ): DesktopWindowContext => {
    const context = assertTrusted(event, argumentCount, expectedArguments);
    senderOwners.set(event.sender, attachmentWindowOwnerForContext(context));
    return context;
  };
  const scopedImports = new Proxy(imports, {
    get(target, property) {
      if (property === "importSelection") {
        return async (
          document: AttachmentImportDocument,
          batchId: unknown,
          importer: (signal: AbortSignal) => Promise<ChatAttachment[]>,
        ): Promise<ChatAttachment[]> => {
          const attachments = await target.importSelection(document, batchId, importer);
          recordAttachmentsForSender(document.owner, attachments);
          return attachments;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const importTrackingIpcMain: Pick<IpcMain, "handle"> = {
    handle(channel, listener) {
      ipcMain.handle(channel, async (event, ...args) => {
        const result: unknown = await listener(event, ...args);
        if (channel === IPC.importAttachments && Array.isArray(result)) {
          recordAttachmentsForSender(event.sender, result as readonly ChatAttachment[]);
        }
        return result;
      });
    },
  };

  registerAttachmentSelectionIpc({
    owner: (event, count) => {
      assertTrustedAndTrack(event, count, 1);
      return options.owner(event, count);
    },
    registry,
    imports: scopedImports,
  });
  registerRendererAttachmentImportIpc({
    ipcMain: importTrackingIpcMain,
    channels: {
      begin: IPC.beginAttachmentImport,
      importOne: IPC.importAttachments,
      commit: IPC.commitAttachmentImport,
      cancel: IPC.cancelAttachmentImport,
    },
    assertTrusted: assertTrustedAndTrack,
    coordinator: imports,
    sanitizeError: privacySafeAttachmentImportError,
  });
  registerAttachmentReattachIpc({
    ipcMain, channel: IPC.reattachAttachment, assertTrusted: assertTrustedAndTrack, registry, imports: scopedImports,
    retained: () => options.conversationAttachments(),
    attachmentReattachContext: async (attachmentId) => {
      const supervisor = options.supervisor();
      if (!supervisor) throw new Error("The local runtime is not available");
      return await supervisor.attachmentReattachContext(attachmentId);
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
    const context = assertTrusted(event, args.length, 1);
    const [value] = args;
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Error("Invalid attachment.");
    }
    const currentRegistry = registry();
    const scopePolicy = context.role === "detached-chat"
      ? authorizeAttachmentForConversationScope(
        value,
        context.conversationId,
        attachmentWindowScopeForRegistry(currentRegistry),
        options.supervisor(),
      )
      : undefined;
    await openPdfAttachment(currentRegistry, options.conversationAttachments(), value, scopePolicy);
  });
}
