import { app, ipcMain, shell, systemPreferences, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AttachmentRegistry } from "./attachment-registry.js";
import { attachmentImportDocumentFromEvent, type AttachmentImportDocument, type RendererAttachmentImportCoordinator } from "./attachment-import-ipc.js";
import { SnapshotError, SnapshotService } from "./snapshot-service.js";
import type { SnapshotDelivery, SnapshotFailureDiagnostic, SnapshotSource } from "../shared/snapshots.js";
import type { ChatAttachment } from "../shared/contracts.js";
import { SNAPSHOT_QUEUE_LIMIT, SnapshotQueue } from "./snapshot-queue.js";
import { DESKTOP_IPC } from "../shared/desktop-ipc.js";
import { privacySafeAttachmentImportError } from "./attachment-selection-import.js";
import { clearSnapshotPreferences, readSnapshotPreferences, writeSnapshotPreferences, type SnapshotPreferences } from "./snapshot-preferences.js";

import { snapshotReviewRequestSchemas, type SnapshotReviewRequest } from "../shared/snapshot-review.js";
import { SnapshotReviewService } from "./snapshot-review.js";

const requestSchema = z.discriminatedUnion("type", [
  ...snapshotReviewRequestSchemas,
  z.object({ type: z.literal("state") }).strict(),
  z.object({ type: z.literal("configure"), enabled: z.boolean(), shortcut: z.enum(["both-shift", "accelerator"]) }).strict(),
  z.object({ type: z.literal("bind"), conversationId: z.uuid() }).strict(),
  z.object({ type: z.literal("unbind") }).strict(),
  z.object({ type: z.literal("permission"), permission: z.enum(["accessibility", "screen"]) }).strict(),
]);

const UNCONFIRMED_DISABLE = "Snapshot cleanup is unconfirmed, and the disabled setting could not be saved. Snapshots may turn back on at the next launch.";

export const SNAPSHOT_BUSY = "A snapshot is already being captured. Try again when it finishes.";
export const SNAPSHOT_QUEUE_FULL = "Snapshot not taken: earlier snapshots are still waiting for a chat. Open a chat to receive them, then try again.";

type SnapshotTarget = { document: AttachmentImportDocument; window: BrowserWindow; conversationId: string };
type DeliveryOutcome = "delivered" | "failed" | "cancelled";

export function registerSnapshotIpc(options: {
  owner(event: IpcMainInvokeEvent, count: number): BrowserWindow;
  mainWindow?(): BrowserWindow | null;
  focusMainWindow?(): void;
  registry(): AttachmentRegistry;
  imports: RendererAttachmentImportCoordinator;
  onFailure?: (diagnostic: SnapshotFailureDiagnostic) => void;
}): SnapshotService {
  const reviews = new SnapshotReviewService({ ...options, onFailure: () => options.onFailure?.({ category: "native-failure", phase: "screenshot" }) });
  const queue = new SnapshotQueue(app.getPath("userData"));
  let target: SnapshotTarget | null = null;
  let operation = false;
  let draining = false;
  let generation = 0;
  let captureEnabled = false;
  let cancelCapture: ((document?: AttachmentImportDocument) => Promise<void>) | null = null;
  const sameDocument = (left: AttachmentImportDocument, right: AttachmentImportDocument): boolean =>
    left.owner === right.owner && left.processId === right.processId
      && left.frameId === right.frameId && left.frameToken === right.frameToken;
  const documentLive = (owner: SnapshotTarget): boolean => {
    if (owner.window.isDestroyed() || owner.window.webContents.isDestroyed()) return false;
    const frame = owner.window.webContents.mainFrame;
    return owner.document.owner === owner.window.webContents && frame.processId === owner.document.processId
      && frame.routingId === owner.document.frameId && frame.frameToken === owner.document.frameToken;
  };
  const failureMessage = (failure: unknown): string =>
    failure instanceof SnapshotError ? failure.message : privacySafeAttachmentImportError(failure).message;
  let heldNotice: string | null = null;
  const notify = (delivery: SnapshotDelivery, focus: boolean): void => {
    const window = options.mainWindow?.();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      if (!focus) return;
      if (delivery.notice) heldNotice = delivery.notice;
      options.focusMainWindow?.();
      return;
    }
    if (focus) { window.show(); window.focus(); }
    window.webContents.send(DESKTOP_IPC.snapshotReady, delivery);
  };
  let configuration = Promise.resolve();
  const deliver = async (
    owner: SnapshotTarget,
    produce: (signal: AbortSignal) => Promise<ChatAttachment[]>,
  ): Promise<DeliveryOutcome> => {
    const captureGeneration = generation;
    let invalidated = false;
    const invalidate = (): void => { invalidated = true; };
    const navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) invalidate();
    };
    const live = (): boolean => captureEnabled && captureGeneration === generation && !service.isDisposing()
      && !invalidated && documentLive(owner);
    const current = (): boolean => target === owner && live();
    if (!current()) return "cancelled";
    owner.document.owner.on("destroyed", invalidate);
    owner.document.owner.on("render-process-gone", invalidate);
    owner.document.owner.on("did-start-navigation", navigation);
    operation = true;
    let batchId: string | null = null;
    let captureSignal: AbortSignal | null = null;
    let importerCancelled: boolean | null = null;
    cancelCapture = async (document) => {
      if (document && !sameDocument(owner.document, document)) return;
      invalidate();
      if (batchId) await options.imports.cancel(owner.document, batchId);
    };
    try {
      batchId = options.imports.begin(owner.document);
      const attachments = await options.imports.importSelection(owner.document, batchId, async (signal) => {
        captureSignal = signal;
        try { return await produce(signal); }
        catch (error) {
          // Failed-import rollback also aborts the signal; preserve the cause first.
          importerCancelled = signal.aborted;
          throw error;
        }
      });
      if (!live() || !service.state().enabled) throw new Error("Snapshot destination closed.");
      owner.window.show(); owner.window.focus();
      owner.window.webContents.send(DESKTOP_IPC.snapshotReady, { conversationId: owner.conversationId, selection: { batchId, attachments } });
      return "delivered";
    } catch (error) {
      const cancelled = importerCancelled ?? (captureSignal as AbortSignal | null)?.aborted ?? false;
      let failure = error;
      if (batchId) {
        try { await options.imports.cancel(owner.document, batchId); }
        catch (cleanup) { failure = new AggregateError([error, cleanup]); }
      }
      if (cancelled || !current()) return "cancelled";
      owner.window.show(); owner.window.focus();
      owner.window.webContents.send(DESKTOP_IPC.snapshotReady, { conversationId: owner.conversationId, error: failureMessage(failure) });
      return "failed";
    } finally {
      owner.document.owner.removeListener("destroyed", invalidate);
      owner.document.owner.removeListener("render-process-gone", invalidate);
      owner.document.owner.removeListener("did-start-navigation", navigation);
      operation = false;
      cancelCapture = null;
    }
  };
  const importSnapshot = async (png: Buffer, source: SnapshotSource, signal: AbortSignal): Promise<ChatAttachment[]> => {
    const attachment = await options.registry().import([{
      name: `snapshot-${source.capturedAt.replace(/[:.]/gu, "-")}.png`, mimeType: "image/png", data: png,
    }], signal);
    return attachment.map((item) => options.registry().setSnapshotSource(item.id, source));
  };
  const drain = async (): Promise<void> => {
    if (draining || operation || !captureEnabled || !queue.mayHaveEntries()) return;
    draining = true;
    try {
      const items = await queue.take();
      const owner = target;
      if (items.length === 0 || operation || !captureEnabled || !owner || !documentLive(owner)) return;
      const outcome = await deliver(owner, async (signal) => {
        const attachments: ChatAttachment[] = [];
        for (const item of items) attachments.push(...await importSnapshot(item.png, item.source, signal));
        return attachments;
      });
      if (outcome !== "cancelled") await queue.remove(items.map(({ id }) => id));
    } catch {
      return;
    } finally { draining = false; }
  };
  const captureToQueue = async (): Promise<void> => {
    const captureGeneration = generation;
    const controller = new AbortController();
    operation = true;
    cancelCapture = async (document) => { if (!document) controller.abort(); };
    try {
      if (await queue.count() >= SNAPSHOT_QUEUE_LIMIT) {
        notify({ pending: true }, true);
        notify({ notice: SNAPSHOT_QUEUE_FULL }, false);
        return;
      }
      const result = await service.capture(controller.signal);
      if (controller.signal.aborted || captureGeneration !== generation || !captureEnabled || service.isDisposing()) return;
      if (!await queue.add(result.png, result.source)) {
        notify({ pending: true }, true);
        notify({ notice: SNAPSHOT_QUEUE_FULL }, false);
        return;
      }
      if (!target || !documentLive(target)) notify({ pending: true }, true);
    } catch (error) {
      if (!controller.signal.aborted && captureGeneration === generation && captureEnabled && !service.isDisposing()) {
        notify({ notice: failureMessage(error) }, true);
      }
    } finally {
      operation = false;
      cancelCapture = null;
    }
    await drain();
  };
  const service = new SnapshotService(async () => {
    if (!captureEnabled) return;
    if (operation || draining) { notify({ notice: SNAPSHOT_BUSY }, false); return; }
    const owner = target;
    if (!owner || !documentLive(owner)) { await captureToQueue(); return; }
    await deliver(owner, async (signal) => {
      const result = await service.capture(signal);
      return await importSnapshot(result.png, result.source, signal);
    });
  }, options.onFailure, () => Promise.all([reviews.stop(), queue.clear()]).then(() => undefined));
  const revoke = (): Promise<PromiseSettledResult<void>[]> => {
    generation += 1;
    captureEnabled = false;
    // Abort the captured owner's lease, not the requesting window or the latest target.
    return Promise.allSettled([service.revokeCapture(), cancelCapture?.() ?? Promise.resolve(), queue.clear()]);
  };
  const requireRevoked = (results: PromiseSettledResult<void>[]): void => {
    if (results.some((result) => result.status === "rejected")) throw new SnapshotError("Snapshot cleanup is unconfirmed.");
  };
  // Make the next launch start with Snapshots off: save the disabled state,
  // or else forget the saved preference. False when neither is possible.
  const persistDisabled = async (shortcut: SnapshotPreferences["shortcut"]): Promise<boolean> => {
    const directory = app.getPath("userData");
    try { await writeSnapshotPreferences(directory, { enabled: false, shortcut }); return true; }
    catch { return await clearSnapshotPreferences(directory).then(() => true, () => false); }
  };
  configuration = readSnapshotPreferences(app.getPath("userData")).then(async (saved) => {
    await (saved?.enabled ? queue.prune() : queue.clear()).catch(() => undefined);
    if (saved && generation === 0) {
      const state = await service.configure(saved.enabled, saved.shortcut);
      if (generation === 0) captureEnabled = state.enabled;
    }
  }).catch(() => undefined);
  ipcMain.handle(DESKTOP_IPC.snapshot, async (event, ...args) => {
    const window = options.owner(event, args.length);
    const request = requestSchema.parse(args[0]);
    if (request.type.startsWith("review-")) {
      const document = attachmentImportDocumentFromEvent(event);
      const reviewRequest = request as SnapshotReviewRequest;
      if (reviewRequest.type === "review-start") await configuration;
      const conversationId = reviewRequest.type === "review-start" ? reviewRequest.conversationId : target?.conversationId;
      if (service.isDisposing() || !target || target.window !== window || !sameDocument(target.document, document)
        || target.conversationId !== conversationId) throw new SnapshotError("Focus the chat you want to attach the screenshot to.");
      await reviews.request({ document, window, conversationId }, reviewRequest);
      return service.state();
    }
    switch (request.type) {
      case "state": await configuration; return service.state();
      case "configure": {
        const revoked = request.enabled ? Promise.resolve([]) : revoke();
        const requestGeneration = generation;
        const next = configuration.then(async () => {
          const [configured, cancellation] = await Promise.all([
            service.configure(request.enabled, request.shortcut).then(
              (state) => ({ state, error: null }), (error: unknown) => ({ state: null, error })),
            revoked,
          ]);
          // A disable that cannot be fully confirmed must still not come back
          // on at the next launch from a stale saved preference.
          if (!request.enabled && (configured.state === null || cancellation.some(({ status }) => status === "rejected"))) {
            if (!await persistDisabled(request.shortcut)) throw new SnapshotError(UNCONFIRMED_DISABLE);
          }
          if (configured.state === null) throw configured.error;
          requireRevoked(cancellation);
          const state = configured.state;
          if (generation === requestGeneration) captureEnabled = state.enabled;
          try { await writeSnapshotPreferences(app.getPath("userData"), { enabled: state.enabled, shortcut: state.shortcut }); }
          catch {
            const revoked = revoke();
            const [stopped, cancellation] = await Promise.all([
              service.configure(false, request.shortcut).then(() => null, (error: unknown) => error), revoked,
            ]);
            // This session is off now; keep the saved preference from turning it back on.
            const persisted = await persistDisabled(request.shortcut);
            if (!persisted && (stopped || cancellation.some(({ status }) => status === "rejected"))) {
              throw new SnapshotError(UNCONFIRMED_DISABLE);
            }
            if (stopped) throw stopped;
            requireRevoked(cancellation);
            throw new Error(persisted
              ? "Snapshot settings could not be saved. Snapshots has been disabled."
              : "Snapshot settings could not be saved. Snapshots has been disabled for now, but may turn back on at the next launch.");
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
            const cancelled = reviews.cancel();
            target = { document, window, conversationId: request.conversationId };
            await cancelled;
          }
        }
        if (heldNotice && window === options.mainWindow?.()) {
          window.webContents.send(DESKTOP_IPC.snapshotReady, { notice: heldNotice });
          heldNotice = null;
        }
        void drain();
        return service.state();
      }
      case "unbind": {
        const document = attachmentImportDocumentFromEvent(event);
        if (target && sameDocument(target.document, document)) target = null;
        await Promise.all([cancelCapture?.(document), reviews.cancel(document)]);
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
