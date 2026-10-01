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
    const input = { name: "partial.txt", mimeType: "text/plain", data: Uint8Array.of(65).buffer };
    await coordinator.importOne(document, batch, [{ ...input, stream: { size: 3, offset: 0, final: false } }]);
    await expect(coordinator.importOne(document, batch, [{ ...input, stream: { size: 3, offset: 2, final: true } }])).rejects.toThrow("Invalid attachment upload chunk");
    expect(await readdir(join(root, "uploads"))).toEqual([]);
    expect(registry.usage().records).toBe(0);
  });

  it("cancels a partial upload when its originating document is destroyed", async () => {
    const { root, coordinator, document } = await fixture();
    const batch = coordinator.begin(document);
    await coordinator.importOne(document, batch, [{ name: "partial.txt", mimeType: "text/plain", data: Uint8Array.of(65).buffer, stream: { size: 2, offset: 0, final: false } }]);
    (document.owner as unknown as EventEmitter).emit("destroyed");
    await coordinator.dispose();
    expect(await readdir(join(root, "uploads"))).toEqual([]);
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
