import { randomUUID } from "node:crypto";

import type {
  Event as ElectronEvent,
  IpcMain,
  IpcMainInvokeEvent,
  RenderProcessGoneDetails,
  WebContentsDidStartNavigationEventParams,
} from "electron";

import type { ChatAttachment } from "../shared/contracts.js";
import { MAX_CHAT_ATTACHMENTS } from "../shared/attachments.js";
import type { AttachmentRegistry } from "./attachment-registry.js";

const MAX_ACTIVE_RENDERER_IMPORT_BATCHES = 16;
const MAX_ACTIVE_RENDERER_IMPORT_BATCHES_PER_OWNER = 4;
const RENDERER_IMPORT_BATCH_TIMEOUT_MS = 210_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type NavigationEvent = ElectronEvent<WebContentsDidStartNavigationEventParams>;
type NavigationListener = (
  details: NavigationEvent,
  url: string,
  isInPlace: boolean,
  isMainFrame: boolean,
  frameProcessId: number,
  frameRoutingId: number,
) => void;
type RenderProcessGoneListener = (
  event: ElectronEvent,
  details: RenderProcessGoneDetails,
) => void;

export interface AttachmentImportBatchOwner {
  isDestroyed(): boolean;
  on(event: "destroyed", listener: () => void): this;
  on(
    event: "render-process-gone",
    listener: RenderProcessGoneListener,
  ): this;
  on(event: "did-start-navigation", listener: NavigationListener): this;
  removeListener(event: "destroyed", listener: () => void): this;
  removeListener(
    event: "render-process-gone",
    listener: RenderProcessGoneListener,
  ): this;
  removeListener(event: "did-start-navigation", listener: NavigationListener): this;
}

export interface AttachmentImportDocument {
  readonly owner: AttachmentImportBatchOwner;
  readonly processId: number;
  readonly frameId: number;
  readonly frameToken: string;
}

interface AttachmentImportBatchRegistry {
  readonly import: AttachmentRegistry["import"];
  readonly rollback: AttachmentRegistry["rollback"];
  readonly rendererImports: {
    hold(batchId: string, attachmentIds: readonly string[]): void;
    commit(
      batchId: string,
      adoptedAttachmentIds: readonly string[],
      rollback: (attachmentId: string) => Promise<void>,
    ): Promise<void>;
    rollback(
      batchId: string,
      rollback: (attachmentId: string) => Promise<void>,
    ): Promise<void>;
  };
}

interface RendererAttachmentImportBatch {
  readonly id: string;
  readonly document: AttachmentImportDocument;
  readonly registry: AttachmentImportBatchRegistry;
  readonly attachmentIds: Set<string>;
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  state: "open" | "cancelled" | "committed";
  inFlight: Promise<ChatAttachment[]> | null;
  cleanup: Promise<void> | null;
}

interface RendererAttachmentImportOwnerRecord {
  readonly document: AttachmentImportDocument;
  readonly batchIds: Set<string>;
  readonly onDestroyed: () => void;
  readonly onRenderProcessGone: RenderProcessGoneListener;
  readonly onDidStartNavigation: NavigationListener;
}

export interface RendererAttachmentImportIpcOptions {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly channels: {
    readonly begin: string;
    readonly importOne: string;
    readonly commit: string;
    readonly cancel: string;
  };
  readonly assertTrusted: (
    event: IpcMainInvokeEvent,
    actual: number,
    expected?: number,
  ) => void;
  readonly coordinator: RendererAttachmentImportCoordinator;
  readonly sanitizeError: (error: unknown) => Error;
}

function assertBatchId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Invalid attachment import batch.");
  }
}

function assertAdoptedAttachmentIds(
  value: unknown,
): asserts value is string[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_CHAT_ATTACHMENTS
    || new Set(value).size !== value.length
    || value.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
  ) {
    throw new Error("Invalid adopted attachments.");
  }
}

export function attachmentImportDocumentFromEvent(
  event: IpcMainInvokeEvent,
): AttachmentImportDocument {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) {
    throw new Error("Attachment import is unavailable.");
  }
  return {
    owner: event.sender,
    processId: event.processId,
    frameId: event.frameId,
    frameToken: frame.frameToken,
  };
}

function sameDocument(
  left: AttachmentImportDocument,
  right: AttachmentImportDocument,
): boolean {
  return left.owner === right.owner
    && left.processId === right.processId
    && left.frameId === right.frameId
    && left.frameToken === right.frameToken;
}

/**
 * Keeps renderer-created attachment capabilities privileged until Composer
 * synchronously adopts an exact subset. Losing the originating document
 * therefore reclaims every successfully imported prefix.
 */
export class RendererAttachmentImportCoordinator {
  private readonly batches = new Map<string, RendererAttachmentImportBatch>();
  private readonly ownerRecords = new Map<
    AttachmentImportBatchOwner,
    RendererAttachmentImportOwnerRecord
  >();
  private readonly pendingCleanup = new Set<Promise<void>>();
  private readonly commitResponseDelayMs: number;
  private disposed = false;

  constructor(
    private readonly registry: () => AttachmentImportBatchRegistry,
    commitResponseDelayMs = 0,
  ) {
    this.commitResponseDelayMs = Number.isFinite(commitResponseDelayMs)
      ? Math.max(0, Math.min(Math.trunc(commitResponseDelayMs), 10_000))
      : 0;
  }

  begin(document: AttachmentImportDocument): string {
    const ownerRecord = this.ownerRecords.get(document.owner);
    if (
      this.disposed
      || document.owner.isDestroyed()
      || this.batches.size >= MAX_ACTIVE_RENDERER_IMPORT_BATCHES
      || (ownerRecord && !sameDocument(ownerRecord.document, document))
      || (ownerRecord?.batchIds.size ?? 0)
        >= MAX_ACTIVE_RENDERER_IMPORT_BATCHES_PER_OWNER
    ) {
      throw new Error("Attachment import is unavailable.");
    }
    const id = randomUUID();
    let batch!: RendererAttachmentImportBatch;
    batch = {
      id,
      document,
      registry: this.registry(),
      attachmentIds: new Set(),
      controller: new AbortController(),
      timer: setTimeout(() => {
        void this.cancelBatch(batch);
      }, RENDERER_IMPORT_BATCH_TIMEOUT_MS),
      state: "open",
      inFlight: null,
      cleanup: null,
    };
    batch.timer.unref();
    this.batches.set(id, batch);
    const record = ownerRecord ?? this.createOwnerRecord(document);
    record.batchIds.add(id);
    if (document.owner.isDestroyed()) void this.cancelBatch(batch);
    return id;
  }

  async importOne(
    document: AttachmentImportDocument,
    batchId: unknown,
    values: readonly unknown[],
  ): Promise<ChatAttachment[]> {
    const batch = this.openOwnedBatch(document, batchId);
    if (batch.inFlight || values.length !== 1) {
      throw new Error("Invalid attachments.");
    }
    return await this.importIntoBatch(batch, async (signal) =>
      await batch.registry.import(values, signal));
  }

  async importSelection(
    document: AttachmentImportDocument,
    batchId: unknown,
    importer: (signal: AbortSignal) => Promise<ChatAttachment[]>,
  ): Promise<ChatAttachment[]> {
    const batch = this.openOwnedBatch(document, batchId);
    if (batch.inFlight) throw new Error("Invalid attachments.");
    return await this.importIntoBatch(batch, importer);
  }

  private async importIntoBatch(
    batch: RendererAttachmentImportBatch,
    importer: (signal: AbortSignal) => Promise<ChatAttachment[]>,
  ): Promise<ChatAttachment[]> {
    const imported = Promise.resolve().then(async () => {
      const attachments = await importer(batch.controller.signal);
      for (const attachment of attachments) {
        batch.attachmentIds.add(attachment.id);
        try {
          batch.registry.rendererImports.hold(batch.id, [attachment.id]);
        } catch (error) {
          batch.attachmentIds.delete(attachment.id);
          await batch.registry.rollback(attachment.id);
          throw error;
        }
      }
      return attachments;
    });
    batch.inFlight = imported;
    try {
      const attachments = await imported;
      if (batch.state !== "open" || batch.document.owner.isDestroyed()) {
        await this.cancelBatch(batch);
        throw new Error("Attachment import was cancelled.");
      }
      return attachments;
    } catch (error) {
      await this.cancelBatch(batch);
      throw error;
    } finally {
      if (batch.inFlight === imported) batch.inFlight = null;
    }
  }

  async commit(
    document: AttachmentImportDocument,
    batchId: unknown,
    adoptedAttachmentIds: unknown,
  ): Promise<void> {
    const batch = this.openOwnedBatch(document, batchId);
    try {
      assertAdoptedAttachmentIds(adoptedAttachmentIds);
    } catch (error) {
      await this.cancelBatch(batch);
      throw error;
    }
    if (
      batch.inFlight
      || document.owner.isDestroyed()
      || adoptedAttachmentIds.some((id) => !batch.attachmentIds.has(id))
    ) {
      await this.cancelBatch(batch);
      throw new Error("Attachment import was cancelled.");
    }
    batch.state = "committed";
    this.detachBatch(batch);
    try {
      await batch.registry.rendererImports.commit(
        batch.id,
        adoptedAttachmentIds,
        async (id) => await batch.registry.rollback(id),
      );
      if (this.commitResponseDelayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.commitResponseDelayMs);
        });
      }
    } catch (error) {
      batch.state = "cancelled";
      await batch.registry.rendererImports.rollback(
        batch.id,
        async (id) => await batch.registry.rollback(id),
      );
      throw error;
    }
  }

  async cancel(
    document: AttachmentImportDocument,
    batchId: unknown,
  ): Promise<void> {
    assertBatchId(batchId);
    const batch = this.batches.get(batchId);
    if (!batch) return;
    if (!sameDocument(batch.document, document)) {
      throw new Error("Attachment import batch is unavailable.");
    }
    await this.cancelBatch(batch);
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      await Promise.all([...this.batches.values()].map(
        async (batch) => await this.cancelBatch(batch),
      ));
    }
    await Promise.all(this.pendingCleanup);
  }

  private openOwnedBatch(
    document: AttachmentImportDocument,
    batchId: unknown,
  ): RendererAttachmentImportBatch {
    assertBatchId(batchId);
    const batch = this.batches.get(batchId);
    if (
      this.disposed
      || !batch
      || !sameDocument(batch.document, document)
      || batch.state !== "open"
    ) {
      throw new Error("Attachment import batch is unavailable.");
    }
    return batch;
  }

  private cancelBatch(batch: RendererAttachmentImportBatch): Promise<void> {
    if (batch.cleanup) return batch.cleanup;
    if (batch.state === "committed") return Promise.resolve();
    batch.state = "cancelled";
    batch.controller.abort();
    this.detachBatch(batch);
    const cleanup = (async (): Promise<void> => {
      await batch.inFlight?.catch(() => undefined);
      await batch.registry.rendererImports.rollback(
        batch.id,
        async (id) => await batch.registry.rollback(id),
      );
      batch.attachmentIds.clear();
    })();
    batch.cleanup = cleanup;
    this.pendingCleanup.add(cleanup);
    void cleanup.then(
      () => this.pendingCleanup.delete(cleanup),
      () => this.pendingCleanup.delete(cleanup),
    );
    return cleanup;
  }

  private detachBatch(batch: RendererAttachmentImportBatch): void {
    if (this.batches.get(batch.id) === batch) this.batches.delete(batch.id);
    const record = this.ownerRecords.get(batch.document.owner);
    record?.batchIds.delete(batch.id);
    if (record?.batchIds.size === 0) this.detachOwnerRecord(record);
    clearTimeout(batch.timer);
  }

  private createOwnerRecord(
    document: AttachmentImportDocument,
  ): RendererAttachmentImportOwnerRecord {
    let record!: RendererAttachmentImportOwnerRecord;
    const cancelAll = (): void => {
      for (const batchId of record.batchIds) {
        const batch = this.batches.get(batchId);
        if (batch) void this.cancelBatch(batch);
      }
    };
    const onDidStartNavigation: NavigationListener = (details): void => {
      if (details.isMainFrame && !details.isSameDocument) cancelAll();
    };
    record = {
      document,
      batchIds: new Set(),
      onDestroyed: cancelAll,
      onRenderProcessGone: cancelAll,
      onDidStartNavigation,
    };
    this.ownerRecords.set(document.owner, record);
    document.owner.on("destroyed", record.onDestroyed);
    document.owner.on("render-process-gone", record.onRenderProcessGone);
    document.owner.on("did-start-navigation", record.onDidStartNavigation);
    return record;
  }

  private detachOwnerRecord(record: RendererAttachmentImportOwnerRecord): void {
    if (this.ownerRecords.get(record.document.owner) === record) {
      this.ownerRecords.delete(record.document.owner);
    }
    record.document.owner.removeListener("destroyed", record.onDestroyed);
    record.document.owner.removeListener(
      "render-process-gone",
      record.onRenderProcessGone,
    );
    record.document.owner.removeListener(
      "did-start-navigation",
      record.onDidStartNavigation,
    );
  }
}

export function registerRendererAttachmentImportIpc(
  options: RendererAttachmentImportIpcOptions,
): void {
  options.ipcMain.handle(options.channels.begin, (event, ...args) => {
    options.assertTrusted(event, args.length);
    return options.coordinator.begin(attachmentImportDocumentFromEvent(event));
  });
  options.ipcMain.handle(options.channels.importOne, async (event, ...args) => {
    options.assertTrusted(event, args.length, 2);
    const [batchId, values] = args;
    if (!Array.isArray(values) || values.length !== 1) {
      throw new Error("Invalid attachments.");
    }
    try {
      return await options.coordinator.importOne(
        attachmentImportDocumentFromEvent(event),
        batchId,
        values,
      );
    } catch (error) {
      throw options.sanitizeError(error);
    }
  });
  options.ipcMain.handle(options.channels.commit, async (event, ...args) => {
    options.assertTrusted(event, args.length, 2);
    await options.coordinator.commit(
      attachmentImportDocumentFromEvent(event),
      args[0],
      args[1],
    );
  });
  options.ipcMain.handle(options.channels.cancel, async (event, ...args) => {
    options.assertTrusted(event, args.length, 1);
    await options.coordinator.cancel(
      attachmentImportDocumentFromEvent(event),
      args[0],
    );
  });
}
