import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { parseAttachmentPickerMode } from "../shared/desktop";
import { attachmentPickerConfiguration } from "./attachment-import";
import { attachmentImportDocumentFromEvent, type RendererAttachmentImportCoordinator } from "./attachment-import-ipc";
import type { AttachmentRegistry } from "./attachment-registry";
import { importSelectedAttachmentPaths, privacySafeAttachmentImportError } from "./attachment-selection-import";

export function registerAttachmentSelectionIpc(options: {
  owner(event: IpcMainInvokeEvent, count: number): BrowserWindow;
  registry(): AttachmentRegistry;
  imports: RendererAttachmentImportCoordinator;
}): void {
  ipcMain.handle("inertia:select-attachments", async (event, ...args) => {
    const ownerWindow = options.owner(event, args.length);
    const mode = parseAttachmentPickerMode(args[0]);
    if (!mode) throw new Error("Invalid attachment picker mode.");
    const picker = attachmentPickerConfiguration(mode);
    const document = attachmentImportDocumentFromEvent(event);
    const batchId = options.imports.begin(document);
    try {
      const result = await dialog.showOpenDialog(ownerWindow, {
        title: picker.title,
        buttonLabel: "Attach",
        filters: [{
          name: picker.filterName,
          extensions: picker.extensions,
        }],
        properties: ["openFile", "multiSelections"],
      });
      if (result.canceled) {
        await options.imports.cancel(document, batchId);
        return null;
      }
      const attachments = await options.imports.importSelection(
        document,
        batchId,
        async (signal) => await importSelectedAttachmentPaths(
          options.registry(),
          result.filePaths,
          mode,
          signal,
        ),
      );
      return { batchId, attachments };
    } catch (error) {
      try {
        await options.imports.cancel(document, batchId);
      } catch (cleanupError) {
        throw privacySafeAttachmentImportError(new AggregateError([
          error,
          cleanupError,
        ]));
      }
      throw privacySafeAttachmentImportError(error);
    }
  });
}
