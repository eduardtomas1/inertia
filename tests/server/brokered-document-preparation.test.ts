import { describe, expect, it, vi } from "vitest";
import { createBrokeredDocumentPreparer } from "../../src/server/runtime/attachments/brokered-document-preparation";
import type { DocumentPreparationResult, DocumentPreparationRunner } from "../../src/node/document-preparation";

const payloads = [{ attachment: { id: "pdf", name: "Document.pdf", path: "/private/input.pdf", mimeType: "application/pdf" as const, size: 1 }, bytes: new Uint8Array([1]) }];
const result: DocumentPreparationResult = {
  contexts: [{ attachmentId: "pdf", label: "PDF", content: "Text with image 1.", truncated: false }],
  images: [{ id: "page", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }], imageOrder: [{ generatedId: "page" }],
};

describe("runtime adoption of isolated document output", () => {
  it("passes no filesystem authority to the decoder and writes images only after confirmed exit", async () => {
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
    const runner = vi.fn<DocumentPreparationRunner>(() => ({ result: Promise.resolve(result), stopped, termination: stopped }));
    const store = { writeJpeg: vi.fn(async () => "/private/generated/page.jpg"), release: vi.fn(async () => {}) };
    const pending = createBrokeredDocumentPreparer(runner)(payloads, { generatedAttachmentStore: store });
    expect(runner.mock.calls[0]![0].payloads).toEqual([{ id: "pdf", name: "Document.pdf", mimeType: "application/pdf", bytes: payloads[0]!.bytes }]);
    await Promise.resolve();
    expect(store.writeJpeg).not.toHaveBeenCalled();
    resolveStopped();
    await expect(pending).resolves.toEqual({ contexts: result.contexts,
      generatedImagePaths: ["/private/generated/page.jpg"], imagePaths: ["/private/generated/page.jpg"] });
  });

  it("rejects even an undefined cleanup failure and does not adopt any output", async () => {
    const runner: DocumentPreparationRunner = () => ({ result: Promise.resolve(result), stopped: Promise.reject(undefined), termination: new Promise(() => {}) });
    const store = { writeJpeg: vi.fn(async () => "/private/generated/page.jpg"), release: vi.fn(async () => {}) };
    await expect(createBrokeredDocumentPreparer(runner)(payloads, { generatedAttachmentStore: store })).rejects.toThrow("shutdown is unconfirmed");
    expect(store.writeJpeg).not.toHaveBeenCalled();
  });

  it("releases images written immediately before cancellation", async () => {
    const controller = new AbortController();
    const runner: DocumentPreparationRunner = () => ({ result: Promise.resolve(result), stopped: Promise.resolve(), termination: Promise.resolve() });
    const store = {
      writeJpeg: vi.fn(async () => { controller.abort(); return "/private/generated/page.jpg"; }),
      release: vi.fn(async () => {}),
    };
    await expect(createBrokeredDocumentPreparer(runner)(payloads, { generatedAttachmentStore: store, signal: controller.signal })).rejects.toThrow("cancelled or expired");
    expect(store.release).toHaveBeenCalledWith(["/private/generated/page.jpg"]);
  });

  it("keeps ordinary text extraction local and does not invoke the PDF decoder", async () => {
    const runner = vi.fn<DocumentPreparationRunner>();
    const bytes = new TextEncoder().encode("Plain text content.");
    const prepared = await createBrokeredDocumentPreparer(runner)([{ attachment: {
      id: "text", name: "Notes.txt", path: "/private/notes.txt", mimeType: "text/plain", size: bytes.byteLength,
    }, bytes }]);
    expect(prepared.contexts[0]?.content).toContain("Plain text content.");
    expect(runner).not.toHaveBeenCalled();
  });
});
