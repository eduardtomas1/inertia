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

describe("isolated extraction of office documents", () => {
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
  const retained = (id: string, size: number) => ({
    attachment: { id, name: `${id}.docx`, path: `/private/${id}.docx`, mimeType: DOCX, size },
    bytes: new Uint8Array(size).fill(1),
    source: { path: `/private/${id}.docx`, digest: "a".repeat(64) },
  });
  const image = {
    attachment: { id: "img", name: "shot.png", path: "/private/shot.png", mimeType: "image/png" as const, size: 4 },
    bytes: new Uint8Array(),
    source: { path: "/private/shot.png", digest: "b".repeat(64) },
  };
  const pdf = {
    attachment: { id: "pdf", name: "big.pdf", path: "/private/big.pdf", mimeType: "application/pdf" as const, size: 4 },
    bytes: new Uint8Array(),
    source: { path: "/private/big.pdf", digest: "c".repeat(64) },
  };
  const echoRunner = () => vi.fn<DocumentPreparationRunner>((operation) => ({
    result: Promise.resolve({
      contexts: operation.payloads.map(({ id }) => ({ attachmentId: id, label: "Word document", content: "Text", truncated: false })),
      images: [],
      imageOrder: [],
    }),
    stopped: Promise.resolve(),
    termination: Promise.resolve(),
  }));

  it("routes retained documents to the decoder and keeps other attachments as paths", async () => {
    const runner = echoRunner();
    const prepared = await createBrokeredDocumentPreparer(runner)([image, retained("a", 8), pdf]);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]![0].payloads.map(({ id }) => id)).toEqual(["a"]);
    expect(prepared).toEqual({
      contexts: [{ attachmentId: "a", label: "Word document", content: "Text", truncated: false }],
      generatedImagePaths: [],
      imagePaths: ["/private/shot.png"],
    });
  });

  it("admits documents only within the decoder's count and byte bounds", async () => {
    const runner = echoRunner();
    const nineMiB = 9 * 1024 * 1024;
    await createBrokeredDocumentPreparer(runner)([
      retained("a", nineMiB),
      retained("b", nineMiB),
      retained("c", nineMiB),
      ...Array.from({ length: 9 }, (_, index) => retained(`s${index}`, 16)),
    ]);
    expect(runner.mock.calls[0]![0].payloads.map(({ id }) => id))
      .toEqual(["a", "b", "s0", "s1", "s2", "s3", "s4", "s5"]);
  });

  it("does not leak unexpected decoder errors to the user", async () => {
    const runner: DocumentPreparationRunner = () => ({
      result: Promise.reject(new Error("ENOENT /home/someone/secret.docx")),
      stopped: Promise.resolve(),
      termination: Promise.resolve(),
    });
    await expect(createBrokeredDocumentPreparer(runner)([retained("a", 8)]))
      .rejects.toThrow("The document could not be prepared safely.");
  });
});
