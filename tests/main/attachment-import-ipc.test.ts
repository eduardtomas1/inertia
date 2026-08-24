import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AttachmentImportBatchOwner,
  type AttachmentImportDocument,
  registerRendererAttachmentImportIpc,
  RendererAttachmentImportCoordinator,
} from "../../src/main/attachment-import-ipc";
import type { ChatAttachment } from "../../src/shared/contracts";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const candidate = {
  name: "safe.pdf",
  mimeType: "application/pdf",
  data: new ArrayBuffer(1),
};

function attachment(id: string, name = "safe.pdf"): ChatAttachment {
  return {
    id,
    name,
    path: id,
    mimeType: "application/pdf",
    size: 1,
  };
}

class FakeOwner extends EventEmitter implements AttachmentImportBatchOwner {
  private destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }

  navigate(isMainFrame: boolean, isSameDocument: boolean): void {
    this.emit("did-start-navigation", { isMainFrame, isSameDocument });
  }

  crash(): void {
    this.emit("render-process-gone", {}, { reason: "crashed" });
  }
}

function document(
  owner = new FakeOwner(),
  frameToken = "frame-one",
): AttachmentImportDocument {
  return { owner, processId: 7, frameId: 9, frameToken };
}

function registry(options: {
  import?: (values: readonly unknown[], signal?: AbortSignal) => Promise<ChatAttachment[]>;
  commit?: (batchId: string, adoptedIds: readonly string[]) => Promise<void>;
} = {}) {
  const hold = vi.fn();
  const commit = vi.fn(options.commit ?? (async () => undefined));
  const rollbackBatch = vi.fn(async () => undefined);
  return {
    import: vi.fn(options.import ?? (async () => [attachment(firstId)])),
    rollback: vi.fn(async () => undefined),
    rendererImports: { hold, commit, rollback: rollbackBatch },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("renderer attachment import ownership", () => {
  it("holds each completed item before reply and reclaims its prefix on destroy", async () => {
    const page = document();
    const storage = registry();
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);

    await expect(coordinator.importOne(page, batchId, [candidate]))
      .resolves.toEqual([attachment(firstId)]);
    expect(storage.rendererImports.hold).toHaveBeenCalledExactlyOnceWith(
      batchId,
      [firstId],
    );
    (page.owner as FakeOwner).destroy();
    await coordinator.dispose();

    expect(storage.rendererImports.rollback).toHaveBeenCalledWith(
      batchId,
      expect.any(Function),
    );
    await expect(coordinator.importOne(page, batchId, [candidate]))
      .rejects.toThrow("batch is unavailable");
  });

  it.each(["navigation", "render-process-gone", "destroyed"] as const)(
    "holds a completed native selection and reclaims it on %s",
    async (lifecycle) => {
    const page = document();
    const storage = registry();
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);

    await expect(coordinator.importSelection(
      page,
      batchId,
      async () => [attachment(firstId), attachment(secondId, "second.pdf")],
    )).resolves.toHaveLength(2);
    expect(storage.rendererImports.hold).toHaveBeenNthCalledWith(
      1,
      batchId,
      [firstId],
    );
    expect(storage.rendererImports.hold).toHaveBeenNthCalledWith(
      2,
      batchId,
      [secondId],
    );

    if (lifecycle === "navigation") {
      (page.owner as FakeOwner).navigate(true, false);
    } else if (lifecycle === "render-process-gone") {
      (page.owner as FakeOwner).crash();
    } else {
      (page.owner as FakeOwner).destroy();
    }
    await coordinator.dispose();
    expect(storage.rendererImports.rollback).toHaveBeenCalledWith(
      batchId,
      expect.any(Function),
    );
  });

  it("commits only the exact adopted subset from a native selection", async () => {
    const page = document();
    const storage = registry();
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);
    await coordinator.importSelection(page, batchId, async () => [
      attachment(firstId),
      attachment(secondId, "second.pdf"),
    ]);

    await coordinator.commit(page, batchId, [secondId]);

    expect(storage.rendererImports.commit).toHaveBeenCalledWith(
      batchId,
      [secondId],
      expect.any(Function),
    );
    expect(storage.rendererImports.rollback).not.toHaveBeenCalled();
    await coordinator.dispose();
  });

  it("aborts native selection work when its originating renderer crashes", async () => {
    const page = document();
    const storage = registry();
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);
    let operationSignal!: AbortSignal;
    const importing = coordinator.importSelection(
      page,
      batchId,
      async (signal) => {
        operationSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(
            new Error("Attachment import was cancelled."),
          ), { once: true });
        });
        return [];
      },
    );
    await vi.waitFor(() => expect(operationSignal).toBeInstanceOf(AbortSignal));

    (page.owner as FakeOwner).crash();
    await expect(importing).rejects.toThrow("cancelled");
    await coordinator.dispose();
    expect(operationSignal.aborted).toBe(true);
    expect(storage.rendererImports.hold).not.toHaveBeenCalled();
  });

  it("cancels on a main-document navigation but ignores subframes and same-document navigation", async () => {
    const page = document();
    const storage = registry({
      import: async (_values, _signal) => [
        attachment(firstId),
      ],
    });
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);
    await coordinator.importOne(page, batchId, [candidate]);

    (page.owner as FakeOwner).navigate(false, false);
    (page.owner as FakeOwner).navigate(true, true);
    await expect(coordinator.importOne(page, batchId, [candidate]))
      .resolves.toEqual([attachment(firstId)]);
    (page.owner as FakeOwner).navigate(true, false);
    await coordinator.dispose();

    expect(storage.rendererImports.rollback).toHaveBeenCalledWith(
      batchId,
      expect.any(Function),
    );
  });

  it("cancels on renderer-process loss even when WebContents survives", async () => {
    const page = document();
    const storage = registry();
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);
    await coordinator.importOne(page, batchId, [candidate]);

    (page.owner as FakeOwner).crash();
    (page.owner as FakeOwner).destroy();
    await coordinator.dispose();

    expect(storage.rendererImports.rollback).toHaveBeenCalledOnce();
    expect(storage.rendererImports.rollback).toHaveBeenCalledWith(
      batchId,
      expect.any(Function),
    );
  });

  it("rejects reuse from a later document in the same WebContents", async () => {
    const owner = new FakeOwner();
    const original = document(owner, "original-frame");
    const replacement = document(owner, "replacement-frame");
    const storage = registry();
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(original);

    for (const changed of [
      document(new FakeOwner(), original.frameToken),
      replacement,
      { ...original, processId: original.processId + 1 },
      { ...original, frameId: original.frameId + 1 },
    ]) {
      await expect(coordinator.importOne(changed, batchId, [candidate]))
        .rejects.toThrow("batch is unavailable");
    }
    await expect(coordinator.cancel(replacement, batchId))
      .rejects.toThrow("batch is unavailable");
    await coordinator.cancel(original, batchId);
  });

  it("commits exactly the adopted subset before document-loss cleanup can run", async () => {
    const page = document();
    let invocation = 0;
    const storage = registry({
      import: async () => [attachment(invocation++ === 0 ? firstId : secondId)],
    });
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);
    await coordinator.importOne(page, batchId, [candidate]);
    await coordinator.importOne(page, batchId, [{ ...candidate, name: "second.pdf" }]);

    const committing = coordinator.commit(page, batchId, [secondId]);
    (page.owner as FakeOwner).destroy();
    await committing;
    await coordinator.dispose();

    expect(storage.rendererImports.commit).toHaveBeenCalledWith(
      batchId,
      [secondId],
      expect.any(Function),
    );
    expect(storage.rendererImports.rollback).not.toHaveBeenCalled();
    expect((page.owner as FakeOwner).listenerCount("destroyed")).toBe(0);
    expect((page.owner as FakeOwner).listenerCount("render-process-gone")).toBe(0);
    expect((page.owner as FakeOwner).listenerCount("did-start-navigation")).toBe(0);
  });

  it("fails closed when a caller commits an unowned subset", async () => {
    const page = document();
    const storage = registry();
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);
    await coordinator.importOne(page, batchId, [candidate]);

    await expect(coordinator.commit(page, batchId, [secondId]))
      .rejects.toThrow("cancelled");
    expect(storage.rendererImports.rollback).toHaveBeenCalledWith(
      batchId,
      expect.any(Function),
    );
  });

  it("rolls back a newly created record immediately when its hold fails", async () => {
    const page = document();
    const storage = registry();
    storage.rendererImports.hold.mockImplementation(() => {
      throw new Error("batch limit");
    });
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);

    await expect(coordinator.importOne(page, batchId, [candidate]))
      .rejects.toThrow("batch limit");
    expect(storage.rollback).toHaveBeenCalledExactlyOnceWith(firstId);
    expect(storage.rendererImports.rollback).toHaveBeenCalledWith(
      batchId,
      expect.any(Function),
    );
  });

  it("serializes one batch while allowing bounded split-composer batches", async () => {
    const page = document();
    let resolveImport!: (attachments: ChatAttachment[]) => void;
    const storage = registry({
      import: async () => await new Promise<ChatAttachment[]>((resolve) => {
        resolveImport = resolve;
      }),
    });
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const ids = Array.from({ length: 4 }, () => coordinator.begin(page));
    expect(() => coordinator.begin(page)).toThrow("unavailable");
    expect((page.owner as FakeOwner).listenerCount("destroyed")).toBe(1);
    expect((page.owner as FakeOwner).listenerCount("render-process-gone")).toBe(1);
    expect((page.owner as FakeOwner).listenerCount("did-start-navigation")).toBe(1);

    const importing = coordinator.importOne(page, ids[0]!, [candidate]);
    await expect(coordinator.importOne(page, ids[0]!, [candidate]))
      .rejects.toThrow("Invalid attachments");
    resolveImport([attachment(firstId)]);
    await importing;
    await coordinator.dispose();
    expect((page.owner as FakeOwner).listenerCount("destroyed")).toBe(0);
  });

  it("aborts a deferred import and captures its late record for coordinated rollback", async () => {
    const page = document();
    let resolveImport!: (attachments: ChatAttachment[]) => void;
    const storage = registry({
      import: async () => await new Promise<ChatAttachment[]>((resolve) => {
        resolveImport = resolve;
      }),
    });
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);
    const importing = coordinator.importOne(page, batchId, [candidate]);
    await vi.waitFor(() => expect(resolveImport).toBeTypeOf("function"));
    const cancelling = coordinator.cancel(page, batchId);
    resolveImport([attachment(firstId)]);

    await expect(importing).rejects.toThrow("cancelled");
    await cancelling;
    expect(storage.rendererImports.hold).toHaveBeenCalledExactlyOnceWith(
      batchId,
      [firstId],
    );
    expect(storage.rendererImports.rollback).toHaveBeenCalledWith(
      batchId,
      expect.any(Function),
    );
  });

  it("times out abandoned batches and removes every owner listener", async () => {
    vi.useFakeTimers();
    const page = document();
    const storage = registry();
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    const batchId = coordinator.begin(page);
    await coordinator.importOne(page, batchId, [candidate]);

    await vi.advanceTimersByTimeAsync(210_000);
    await coordinator.dispose();

    expect(storage.rendererImports.rollback).toHaveBeenCalledWith(
      batchId,
      expect.any(Function),
    );
    expect((page.owner as FakeOwner).listenerCount("destroyed")).toBe(0);
    expect((page.owner as FakeOwner).listenerCount("render-process-gone")).toBe(0);
    expect((page.owner as FakeOwner).listenerCount("did-start-navigation")).toBe(0);
  });

  it("binds IPC lifecycle operations to the exact sender, frame, and subset", async () => {
    const owner = new FakeOwner();
    const storage = registry();
    const coordinator = new RendererAttachmentImportCoordinator(() => storage);
    type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = new Map<string, Handler>();
    const assertTrusted = vi.fn();
    registerRendererAttachmentImportIpc({
      ipcMain: {
        handle: (channel, listener) => {
          handlers.set(channel, listener as Handler);
        },
      },
      channels: { begin: "begin", importOne: "import", commit: "commit", cancel: "cancel" },
      assertTrusted,
      coordinator,
      sanitizeError: (error) => error instanceof Error ? error : new Error("sanitized"),
    });
    const mainFrame = { frameToken: "frame-one" };
    const event = {
      sender: owner,
      processId: 7,
      frameId: 9,
      senderFrame: mainFrame,
    } as unknown as IpcMainInvokeEvent;
    Object.defineProperty(owner, "mainFrame", { value: mainFrame });

    const batchId = await handlers.get("begin")?.(event) as string;
    await expect(handlers.get("import")?.(event, batchId, [candidate]))
      .resolves.toEqual([attachment(firstId)]);
    await handlers.get("commit")?.(event, batchId, [firstId]);
    await handlers.get("cancel")?.(event, batchId);

    expect(assertTrusted.mock.calls.map(([, actual, expected]) => [actual, expected]))
      .toEqual([[0, undefined], [2, 2], [2, 2], [1, 1]]);
    expect(storage.rendererImports.commit).toHaveBeenCalledWith(
      batchId,
      [firstId],
      expect.any(Function),
    );
    expect(storage.rendererImports.rollback).not.toHaveBeenCalled();
    await expect(handlers.get("import")?.(event, batchId, [candidate]))
      .rejects.toThrow("batch is unavailable");
    await coordinator.dispose();
  });

  it("rejects missing and non-main IPC sender frames", async () => {
    const owner = new FakeOwner();
    const coordinator = new RendererAttachmentImportCoordinator(() => registry());
    type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = new Map<string, Handler>();
    registerRendererAttachmentImportIpc({
      ipcMain: {
        handle: (channel, listener) => handlers.set(channel, listener as Handler),
      },
      channels: { begin: "begin", importOne: "import", commit: "commit", cancel: "cancel" },
      assertTrusted: () => undefined,
      coordinator,
      sanitizeError: (error) => error instanceof Error ? error : new Error("sanitized"),
    });
    const mainFrame = { frameToken: "main" };
    Object.defineProperty(owner, "mainFrame", { value: mainFrame });
    const base = { sender: owner, processId: 7, frameId: 9 };

    expect(() => handlers.get("begin")?.({
      ...base,
      senderFrame: null,
    } as unknown as IpcMainInvokeEvent)).toThrow("unavailable");
    expect(() => handlers.get("begin")?.({
      ...base,
      senderFrame: { frameToken: "subframe" },
    } as unknown as IpcMainInvokeEvent)).toThrow("unavailable");
    await coordinator.dispose();
  });
});
