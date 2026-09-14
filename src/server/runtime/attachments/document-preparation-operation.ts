import { randomUUID } from "node:crypto";
import {
  DOCUMENT_PREPARATION_TIMEOUT_MS,
  documentPreparationResultMatches,
  parseDocumentPreparationOperation,
  parseDocumentPreparationResult,
  type DocumentPreparationOperation,
  type DocumentPreparationResult,
} from "../../../node/document-preparation";
import { MAX_CHAT_ATTACHMENTS, MAX_CHAT_ATTACHMENT_BYTES, MAX_CHAT_ATTACHMENT_TOTAL_BYTES } from "../../../shared/attachments";
import { DocumentAttachmentError } from "./attachment-errors";
import { prepareDocumentAttachments } from "./document-attachment-context";

/** Runs only in the decoder utility; generated images remain bytes until runtime adoption. */
export async function performDocumentPreparation(
  operation: DocumentPreparationOperation,
  prepare = prepareDocumentAttachments,
): Promise<DocumentPreparationResult> {
  if (!parseDocumentPreparationOperation(operation)) throw new DocumentAttachmentError("The document preparation input is invalid.");
  const remaining = Math.min(DOCUMENT_PREPARATION_TIMEOUT_MS, operation.deadlineAt - Date.now());
  if (remaining <= 0) throw new DocumentAttachmentError("Document preparation expired before decoding.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  timer.unref();
  const sourcePaths = new Map(operation.payloads.map((payload) => [`source:${payload.id}`, payload.id]));
  const generated = new Map<string, { id: string; bytes: Uint8Array }>();
  try {
    const prepared = await prepare(operation.payloads.map((payload) => ({
      attachment: { id: payload.id, name: payload.name, path: `source:${payload.id}`, mimeType: payload.mimeType, size: payload.bytes.byteLength },
      bytes: payload.bytes,
    })), {
      deadlineAt: operation.deadlineAt,
      signal: controller.signal,
      generatedAttachmentStore: {
        writeJpeg: async (bytes) => {
          if (controller.signal.aborted || generated.size >= MAX_CHAT_ATTACHMENTS
            || bytes.byteLength > MAX_CHAT_ATTACHMENT_BYTES
            || [...generated.values()].reduce((total, image) => total + image.bytes.byteLength, 0)
              + bytes.byteLength > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
            throw new DocumentAttachmentError("Generated document images exceed their bounded capacity.");
          }
          const id = randomUUID();
          const path = `generated:${id}`;
          generated.set(path, { id, bytes: new Uint8Array(bytes) });
          return path;
        },
        release: async (paths) => { for (const path of paths) generated.delete(path); },
      },
    });
    if (controller.signal.aborted) throw new DocumentAttachmentError("Document preparation exceeded its deadline.");
    const result: DocumentPreparationResult = {
      contexts: prepared.contexts,
      images: [...generated.values()],
      imageOrder: prepared.imagePaths.map((path) => {
        const sourceId = sourcePaths.get(path);
        if (sourceId !== undefined) return { sourceId };
        const image = generated.get(path);
        if (image) return { generatedId: image.id };
        throw new DocumentAttachmentError("The decoder returned an unknown image reference.");
      }),
    };
    if (!parseDocumentPreparationResult(result) || !documentPreparationResultMatches(operation, result)) {
      throw new DocumentAttachmentError("The decoder output exceeds its safe bounds.");
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
