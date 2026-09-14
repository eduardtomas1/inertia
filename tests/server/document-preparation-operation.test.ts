import { afterEach, describe, expect, it, vi } from "vitest";
import { performDocumentPreparation } from "../../src/server/runtime/attachments/document-preparation-operation";
import type { prepareDocumentAttachments } from "../../src/server/runtime/attachments/document-attachment-context";
import type { DocumentPreparationOperation } from "../../src/node/document-preparation";

const operation = (): DocumentPreparationOperation => ({ deadlineAt: Date.now() + 1_000,
  payloads: [{ id: "pdf", name: "Notes.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) }] });
const context = { attachmentId: "pdf", label: "PDF", content: "Page image 1", truncated: false };
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
afterEach(() => { vi.useRealTimers(); });

describe("document decoder operation", () => {
  it("keeps source and generated images as identities and bytes without real paths", async () => {
    const input = operation();
    input.payloads.push({ id: "image", name: "Picture.png", mimeType: "image/png", bytes: new Uint8Array([1]) });
    const prepare: typeof prepareDocumentAttachments = async (payloads, options) => {
      expect(payloads.map(({ attachment }) => attachment.path)).toEqual(["source:pdf", "source:image"]);
      const discarded = await options!.generatedAttachmentStore!.writeJpeg(jpeg);
      await options!.generatedAttachmentStore!.release([discarded]);
      const generated = await options!.generatedAttachmentStore!.writeJpeg(jpeg);
      return { contexts: [context], generatedImagePaths: [generated], imagePaths: [generated, "source:image"] };
    };
    const result = await performDocumentPreparation(input, prepare);
    expect(result.contexts).toEqual([context]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.bytes).toEqual(jpeg);
    expect(result.imageOrder).toEqual([{ generatedId: result.images[0]!.id }, { sourceId: "image" }]);
    expect(JSON.stringify(result)).not.toContain("source:");
    expect(JSON.stringify(result)).not.toContain("generated:");
  });

  it("rejects expired input before invoking any decoder", async () => {
    const prepare = vi.fn<typeof prepareDocumentAttachments>();
    await expect(performDocumentPreparation({ ...operation(), deadlineAt: Date.now() }, prepare)).rejects.toThrow("expired");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not return non-JPEG output even when the decoder reports successful rendering", async () => {
    const prepare: typeof prepareDocumentAttachments = async (_, options) => {
      const path = await options!.generatedAttachmentStore!.writeJpeg(new Uint8Array([1, 2, 3, 4]));
      return { contexts: [context], generatedImagePaths: [path], imagePaths: [path] };
    };
    await expect(performDocumentPreparation(operation(), prepare)).rejects.toThrow("safe bounds");
  });

  it("refuses results produced after the operation deadline", async () => {
    vi.useFakeTimers();
    const prepare: typeof prepareDocumentAttachments = async (_, options) => {
      await new Promise<void>((resolve) => { options!.signal!.addEventListener("abort", () => resolve(), { once: true }); });
      return { contexts: [context], generatedImagePaths: [], imagePaths: [] };
    };
    const outcome = expect(performDocumentPreparation(operation(), prepare)).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
  });
});
