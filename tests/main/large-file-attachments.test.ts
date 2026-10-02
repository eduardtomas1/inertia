// @inertia-test-suite portable
import { EventEmitter } from "node:events";
import { createHash, randomFillSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentRegistry } from "../../src/main/attachment-registry";
import { RendererAttachmentImportCoordinator, type AttachmentImportBatchOwner } from "../../src/main/attachment-import-ipc";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { TrustedAttachmentResolver } from "../../src/server/runtime/attachments/trusted-attachment-resolver";
import { createBrokeredDocumentPreparer } from "../../src/server/runtime/attachments/brokered-document-preparation";
import { assembleTurnRequest } from "../../src/server/runtime/turns/request-context";
import { ATTACHMENT_UPLOAD_CHUNK_BYTES, ATTACHMENT_PREVIEW_BYTES, MAX_IMAGE_ATTACHMENT_BYTES, attachmentLimitError } from "../../src/shared/attachments";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inertia-stream-attachments-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const registry = new AttachmentRegistry(join(root, "uploads"));
  const coordinator = new RendererAttachmentImportCoordinator(() => registry);
  cleanups.push(() => coordinator.dispose());
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as AttachmentImportBatchOwner;
  return { root, registry, coordinator, document: { owner, processId: 1, frameId: 1, frameToken: "document" } };
}

function partialChunk(size: number) {
  return {
    name: "partial.log", mimeType: "text/plain", data: new Uint8Array(ATTACHMENT_UPLOAD_CHUNK_BYTES).fill(65).buffer,
    stream: { size, offset: 0, final: false },
  };
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]);
  clearTimeout(timer);
  return settled;
}

describe("file-backed attachments", () => {
  it("streams a large upload, retains full content across restart, and sends only its path", async () => {
    const { root, registry, coordinator, document } = await fixture();
    const batch = coordinator.begin(document);
    const size = 12 * 1024 * 1024 + 3;
    const marker = "PRIVATE_FILE_CONTENT_TO_READ_ON_DEMAND\n";
    const chunk = Buffer.alloc(ATTACHMENT_UPLOAD_CHUNK_BYTES, "a");
    chunk.write(marker);
    const expectedHash = createHash("sha256");
    let attachments: Awaited<ReturnType<typeof coordinator.importOne>> = [];
    for (let offset = 0; offset < size; offset += chunk.length) {
      const bytes = Uint8Array.from(chunk.subarray(0, Math.min(chunk.length, size - offset)));
      expectedHash.update(bytes);
      attachments = await coordinator.importOne(document, batch, [{
        name: "large.log", mimeType: "text/plain", data: bytes.buffer,
        stream: { size, offset, final: offset + bytes.length === size },
      }]);
      if (offset + bytes.length < size) expect(attachments).toEqual([]);
    }
    await coordinator.commit(document, batch, attachments.map(({ id }) => id));
    const preview = await registry.preview(attachments[0]!.id);
    expect(preview?.size).toBe(size);
    expect(preview?.bytes.length).toBe(ATTACHMENT_PREVIEW_BYTES);
    const resolver = new TrustedAttachmentResolver(join(root, "uploads"), {
      resolve: async (id) => await registry.resolve(id), release: async () => true,
      cleanup: async () => true, relinquish: async () => true,
    });
    const payloads = await resolver.resolvePayloads(attachments, randomUUID());
    expect(payloads[0]?.bytes.byteLength).toBe(0);
    expect(payloads[0]?.source?.digest).toBe(expectedHash.digest("hex"));
    const decode = vi.fn();
    expect(await createBrokeredDocumentPreparer(decode)(payloads)).toEqual({ contexts: [], imagePaths: [], generatedImagePaths: [] });
    expect(decode).not.toHaveBeenCalled();
    const store = await ConversationAttachmentStore.open(root);
    cleanups.push(() => store.close());
    const retained = await store.retain(payloads);
    expect(createHash("sha256").update(await readFile(retained[0]!.path)).digest("hex")).toBe(payloads[0]?.source?.digest);
    await registry.release(attachments[0]!.id);
    const reader = await ConversationAttachmentStore.open(root);
    cleanups.push(() => reader.close());
    expect((await reader.resolve(retained[0]!.id))?.bytes.length).toBe(0);
    expect((await reader.preview(retained[0]!.id))?.bytes.length).toBe(ATTACHMENT_PREVIEW_BYTES);
    const request = assembleTurnRequest({ cwd: root, visibleContent: "Search the attached log.", attachments: retained });
    const manifest = JSON.parse(request.executionPrompt.split("\n").at(-1)!);
    expect(manifest).toEqual([{ name: retained[0]!.name, path: retained[0]!.path, size }]);
    expect(request.executionPrompt).not.toContain(marker.trim());
  });

  it("rejects out-of-order chunks and reclaims partial files", async () => {
    const { root, registry, coordinator, document } = await fixture();
    const batch = coordinator.begin(document);
    const size = ATTACHMENT_UPLOAD_CHUNK_BYTES * 2 + 1;
    await coordinator.importOne(document, batch, [partialChunk(size)]);
    await expect(coordinator.importOne(document, batch, [{ ...partialChunk(size), stream: { size, offset: size - 1, final: true }, data: Uint8Array.of(65).buffer }])).rejects.toThrow("Invalid attachment upload chunk");
    expect(await readdir(join(root, "uploads"))).toEqual([]);
    expect(registry.usage().records).toBe(0);
  });

  it("requires every chunk before the last to fill the chunk size", async () => {
    const { root, registry, coordinator, document } = await fixture();
    const batch = coordinator.begin(document);
    await expect(coordinator.importOne(document, batch, [{
      name: "trickle.log", mimeType: "text/plain", data: Uint8Array.of(65).buffer,
      stream: { size: 2, offset: 0, final: false },
    }])).rejects.toThrow("Invalid attachment upload chunk");
    expect(await readdir(join(root, "uploads"))).toEqual([]);
    expect(registry.usage()).toEqual({ records: 0, bytes: 0 });
  });

  it("cancels a partial upload when its originating document is destroyed", async () => {
    const { root, coordinator, document } = await fixture();
    const batch = coordinator.begin(document);
    await coordinator.importOne(document, batch, [partialChunk(ATTACHMENT_UPLOAD_CHUNK_BYTES + 1)]);
    (document.owner as unknown as EventEmitter).emit("destroyed");
    await coordinator.dispose();
    expect(await readdir(join(root, "uploads"))).toEqual([]);
  });

  it("does not let one window's unfinished upload block other imports or send handoffs", async () => {
    const { registry, coordinator, document } = await fixture();
    const other = { ...document, owner: Object.assign(new EventEmitter(), { isDestroyed: () => false }) as AttachmentImportBatchOwner, processId: 2, frameToken: "other" };
    const ready = coordinator.begin(other);
    const [sendable] = await coordinator.importOne(other, ready, [{ name: "ready.txt", mimeType: "text/plain", data: new TextEncoder().encode("ready").buffer }]);
    await coordinator.commit(other, ready, [sendable!.id]);
    const stalled = coordinator.begin(document);
    await coordinator.importOne(document, stalled, [partialChunk(ATTACHMENT_UPLOAD_CHUNK_BYTES + 1)]);

    const later = coordinator.begin(other);
    const imported = coordinator.importOne(other, later, [{ name: "other.txt", mimeType: "text/plain", data: new TextEncoder().encode("other").buffer }]);
    const handoff = registry.prepareHandoff(randomUUID(), [sendable!.id], () => false);
    const settled = { imported: await settlesWithin(imported, 5_000), handoff: await settlesWithin(handoff, 1_000) };
    await coordinator.cancel(document, stalled);
    await Promise.allSettled([imported, handoff]);
    expect(settled).toEqual({ imported: true, handoff: true });
    await expect(imported).resolves.toHaveLength(1);
  });

  it("keeps concurrent unfinished uploads within the temporary storage quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-stream-quota-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const size = ATTACHMENT_UPLOAD_CHUNK_BYTES + 1;
    const registry = new AttachmentRegistry(join(root, "uploads"), { maxBytes: size * 2 });
    const coordinator = new RendererAttachmentImportCoordinator(() => registry);
    cleanups.push(() => coordinator.dispose());
    const windows = [1, 2, 3].map((processId) => ({
      owner: Object.assign(new EventEmitter(), { isDestroyed: () => false }) as AttachmentImportBatchOwner,
      processId, frameId: 1, frameToken: `window-${processId}`,
    }));
    const batches = windows.map((window) => coordinator.begin(window));
    const results = await Promise.allSettled(windows.map(async (window, index) =>
      await coordinator.importOne(window, batches[index]!, [partialChunk(size)])));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { message: "Temporary attachment storage is full. Remove an attachment and try again." },
    });
    expect(registry.usage()).toEqual({ records: 2, bytes: size * 2 });
    await Promise.all(windows.map(async (window, index) => await coordinator.cancel(window, batches[index]!)));
    expect(registry.usage()).toEqual({ records: 0, bytes: 0 });
    expect(await readdir(join(root, "uploads"))).toEqual([]);
  });

  it("reports a full temporary store to the uploading window instead of a cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-stream-full-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const registry = new AttachmentRegistry(join(root, "uploads"), { maxBytes: 4 });
    const coordinator = new RendererAttachmentImportCoordinator(() => registry);
    cleanups.push(() => coordinator.dispose());
    const document = { owner: Object.assign(new EventEmitter(), { isDestroyed: () => false }) as AttachmentImportBatchOwner, processId: 1, frameId: 1, frameToken: "document" };
    const batch = coordinator.begin(document);
    await expect(coordinator.importOne(document, batch, [{
      name: "big.log", mimeType: "text/plain", data: new TextEncoder().encode("12345678").buffer,
      stream: { size: 8, offset: 0, final: true },
    }])).rejects.toThrow("Temporary attachment storage is full. Remove an attachment and try again.");
  });

  it("keeps a streamed batch open while its chunks keep arriving", async () => {
    const { registry, coordinator, document } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanups.push(async () => vi.useRealTimers());
    const batch = coordinator.begin(document);
    const size = ATTACHMENT_UPLOAD_CHUNK_BYTES * 2;
    for (let index = 0; index < 3; index += 1) {
      for (let offset = 0; offset < size; offset += ATTACHMENT_UPLOAD_CHUNK_BYTES) {
        await coordinator.importOne(document, batch, [{
          name: `part-${index}.txt`, mimeType: "text/plain", data: new Uint8Array(ATTACHMENT_UPLOAD_CHUNK_BYTES).fill(65 + index).buffer,
          stream: { size, offset, final: offset + ATTACHMENT_UPLOAD_CHUNK_BYTES === size },
        }]);
        await vi.advanceTimersByTimeAsync(50_000);
      }
    }
    expect(registry.usage().records).toBe(3);
  });

  it("ends a waiting upload and reclaims its staged file when the registry is disposed", async () => {
    const { root, registry, coordinator, document } = await fixture();
    const batch = coordinator.begin(document);
    await coordinator.importOne(document, batch, [partialChunk(ATTACHMENT_UPLOAD_CHUNK_BYTES + 1)]);
    expect(await settlesWithin(registry.dispose(), 2_000)).toBe(true);
    expect(await readdir(join(root, "uploads"))).toEqual([]);
  });

  it("keeps a text file that fails text validation as an opaque file without a preview", async () => {
    const { root, registry } = await fixture();
    const log = Buffer.from("Step 1/9 : FROM node:22\n\x1b[1A\x1b[2K => [internal] load build definition 0.1s\n\x1b[KDone\n");
    const [opaque] = await registry.import([{ name: "docker-build.out", mimeType: "", data: log }]);
    expect(opaque?.mimeType).toBe("application/octet-stream");
    const [textLog] = await registry.import([{ name: "docker-build.log", mimeType: "text/plain", data: log }]);
    expect(textLog).toMatchObject({ name: "docker-build.log", mimeType: "application/octet-stream", size: log.length });
    const trusted = (await registry.resolve(textLog!.id))!;
    expect(trusted.path).toMatch(/\.bin$/u);
    expect(await readFile(trusted.path)).toEqual(log);
    const resolver = new TrustedAttachmentResolver(join(root, "uploads"), {
      resolve: async (id) => await registry.resolve(id), release: async () => true,
      cleanup: async () => true, relinquish: async () => true,
    });
    const store = await ConversationAttachmentStore.open(root);
    cleanups.push(() => store.close());
    const [retained] = await store.retain(await resolver.resolvePayloads([textLog!], randomUUID()));
    expect(retained).toMatchObject({ name: "docker-build.log", mimeType: "application/octet-stream" });
    expect(retained!.path).toMatch(/\.bin$/u);
  });

  it("detects content changes before copying a retained source", async () => {
    const { root, registry } = await fixture();
    const [file] = await registry.import([{ name: "file.txt", mimeType: "text/plain", data: Buffer.from("original") }]);
    const trusted = (await registry.resolve(file!.id))!;
    const store = await ConversationAttachmentStore.open(root);
    cleanups.push(() => store.close());
    await writeFile(trusted.path, "modified");
    await expect(store.retain([{ attachment: trusted, bytes: new Uint8Array(), source: { path: trusted.path, digest: trusted.digest } }])).rejects.toThrow();
  });

  it("normalizes oversized images inside the importer for native and streamed sources", async () => {
    const { registry } = await fixture();
    const canvas = createCanvas(8193, 1);
    canvas.getContext("2d").fillRect(0, 0, 8193, 1);
    const bytes = await canvas.encode("png");
    const imported = await registry.importFromWriter({ name: "wide.png", mimeType: "image/png", size: bytes.length, write: async (file) => { await file.writeFile(bytes); } });
    expect(imported?.mimeType).toBe("image/jpeg");
    expect(imported?.name).toBe("wide.jpg");
    expect(imported!.size).toBeLessThanOrEqual(MAX_IMAGE_ATTACHMENT_BYTES);
    expect((await registry.resolve(imported!.id))?.path).toMatch(/\.jpg$/u);
  });

  it("compresses an image larger than 10 MiB before publishing its capability", async () => {
    const { registry } = await fixture();
    const canvas = createCanvas(2048, 2048);
    const context = canvas.getContext("2d");
    const pixels = context.createImageData(2048, 2048);
    randomFillSync(pixels.data);
    context.putImageData(pixels, 0, 0);
    const source = await canvas.encode("png");
    expect(source.length).toBeGreaterThan(MAX_IMAGE_ATTACHMENT_BYTES);
    const [image] = await registry.import([{ name: "large.png", mimeType: "image/png", data: source }]);
    expect(image!.size).toBeLessThanOrEqual(MAX_IMAGE_ATTACHMENT_BYTES);
    expect(image!.mimeType).toBe("image/jpeg");
  });

  it("applies a separate image budget without a 20 MiB file budget", () => {
    expect(attachmentLimitError(Array.from({ length: 100 }, () => ({ mimeType: "text/plain", size: 50 * 1024 * 1024 })))).toBeNull();
    expect(attachmentLimitError(Array.from({ length: 9 }, () => ({ mimeType: "image/jpeg", size: MAX_IMAGE_ATTACHMENT_BYTES })))).toContain("80 MiB");
  });
});
