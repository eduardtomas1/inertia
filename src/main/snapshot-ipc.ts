import { app, ipcMain, shell, systemPreferences, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AttachmentRegistry } from "./attachment-registry.js";
import { attachmentImportDocumentFromEvent, type AttachmentImportDocument, type RendererAttachmentImportCoordinator } from "./attachment-import-ipc.js";
import { SnapshotError, SnapshotService } from "./snapshot-service.js";
import { privacySafeAttachmentImportError } from "./attachment-selection-import.js";
import { readSnapshotPreferences, writeSnapshotPreferences } from "./snapshot-preferences.js";

const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }).strict(),
  z.object({ type: z.literal("configure"), enabled: z.boolean(), shortcut: z.enum(["both-shift", "accelerator"]) }).strict(),
  z.object({ type: z.literal("bind"), conversationId: z.uuid() }).strict(),
  z.object({ type: z.literal("unbind") }).strict(),
  z.object({ type: z.literal("permission"), permission: z.enum(["accessibility", "screen"]) }).strict(),
]);

export function registerSnapshotIpc(options: {
  owner(event: IpcMainInvokeEvent, count: number): BrowserWindow;
  registry(): AttachmentRegistry;
  imports: RendererAttachmentImportCoordinator;
}): SnapshotService {
  let target: { document: AttachmentImportDocument; window: BrowserWindow; conversationId: string } | null = null;
  let operation = false;
  let cancelCapture: ((document: AttachmentImportDocument) => Promise<void>) | null = null;
  const sameDocument = (left: AttachmentImportDocument, right: AttachmentImportDocument): boolean =>
    left.owner === right.owner && left.processId === right.processId
      && left.frameId === right.frameId && left.frameToken === right.frameToken;
  let configuration = Promise.resolve();
  const service = new SnapshotService(async () => {
    const owner = target;
    if (!owner || owner.window.isDestroyed() || operation) return;
    let invalidated = false;
    const invalidate = (): void => { invalidated = true; };
    const navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) invalidate();
    };
    const current = (): boolean => {
      if (service.isDisposing() || invalidated || target !== owner || owner.window.isDestroyed() || owner.window.webContents.isDestroyed()) return false;
      const frame = owner.window.webContents.mainFrame;
      return owner.document.owner === owner.window.webContents && frame.processId === owner.document.processId
        && frame.routingId === owner.document.frameId && frame.frameToken === owner.document.frameToken;
    };
    if (!current()) return;
    owner.document.owner.on("destroyed", invalidate);
    owner.document.owner.on("render-process-gone", invalidate);
    owner.document.owner.on("did-start-navigation", navigation);
    operation = true;
    let batchId: string | null = null;
    let captureSignal: AbortSignal | null = null;
    let importerCancelled: boolean | null = null;
    cancelCapture = async (document) => {
      if (!sameDocument(owner.document, document)) return;
      invalidate();
      if (batchId) await options.imports.cancel(owner.document, batchId);
    };
    try {
      batchId = options.imports.begin(owner.document);
      const attachments = await options.imports.importSelection(owner.document, batchId, async (signal) => {
        captureSignal = signal;
        try {
          const result = await service.capture(signal);
          const attachment = await options.registry().import([{
            name: `snapshot-${result.source.capturedAt.replace(/[:.]/gu, "-")}.png`,
            mimeType: "image/png", data: result.png,
          }], signal);
          return attachment.map((item) => options.registry().setSnapshotSource(item.id, result.source));
        } catch (error) {
          // Failed-import rollback also aborts the signal; preserve the cause first.
          importerCancelled = signal.aborted;
          throw error;
        }
      });
      if (invalidated || service.isDisposing() || owner.window.isDestroyed()) throw new Error("Snapshot destination closed.");
      owner.window.show(); owner.window.focus();
      owner.window.webContents.send("inertia:snapshot-ready", { conversationId: owner.conversationId, selection: { batchId, attachments } });
    } catch (error) {
      const cancelled = importerCancelled ?? (captureSignal as AbortSignal | null)?.aborted ?? false;
      let failure = error;
      if (batchId) {
        try { await options.imports.cancel(owner.document, batchId); }
        catch (cleanup) { failure = new AggregateError([error, cleanup]); }
      }
      if (!cancelled && current()) {
        owner.window.show(); owner.window.focus();
        owner.window.webContents.send("inertia:snapshot-ready", {
          conversationId: owner.conversationId, error: failure instanceof SnapshotError ? failure.message : privacySafeAttachmentImportError(failure).message,
        });
      }
    } finally {
      owner.document.owner.removeListener("destroyed", invalidate);
      owner.document.owner.removeListener("render-process-gone", invalidate);
      owner.document.owner.removeListener("did-start-navigation", navigation);
      operation = false;
      cancelCapture = null;
    }
  });
  configuration = readSnapshotPreferences(app.getPath("userData")).then(async (saved) => {
    if (saved) await service.configure(saved.enabled, saved.shortcut);
  }).catch(() => undefined);
  ipcMain.handle("inertia:snapshot", async (event, ...args) => {
    const window = options.owner(event, args.length);
    const request = requestSchema.parse(args[0]);
    switch (request.type) {
      case "state": await configuration; return service.state();
      case "configure": {
        const next = configuration.then(async () => {
          const state = await service.configure(request.enabled, request.shortcut);
          try { await writeSnapshotPreferences(app.getPath("userData"), { enabled: state.enabled, shortcut: state.shortcut }); }
          catch {
            await service.configure(false, request.shortcut);
            throw new Error("Snapshot settings could not be saved. Snapshots has been disabled.");
          }
          return state;
        });
        configuration = next.then(() => undefined, () => undefined);
        return await next;
      }
      case "bind": {
        if (window.isFocused() || !target || target.window === window || target.window.isDestroyed()) {
          const document = attachmentImportDocumentFromEvent(event);
          if (!target || target.window !== window || target.conversationId !== request.conversationId
            || target.document.owner !== document.owner || target.document.processId !== document.processId
            || target.document.frameId !== document.frameId || target.document.frameToken !== document.frameToken) {
            target = { document, window, conversationId: request.conversationId };
          }
        }
        return service.state();
      }
      case "unbind": {
        const document = attachmentImportDocumentFromEvent(event);
        if (target && sameDocument(target.document, document)) target = null;
        await cancelCapture?.(document);
        return service.state();
      }
      case "permission": {
        if (process.platform === "darwin") {
          if (request.permission === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
          await shell.openExternal(request.permission === "screen"
            ? "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            : "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        }
        return service.state();
      }
    }
  });
  return service;
}
