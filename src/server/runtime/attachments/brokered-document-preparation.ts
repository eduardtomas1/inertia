import {
  DOCUMENT_PREPARATION_TIMEOUT_MS,
  type DocumentPreparationRunner,
} from "../../../node/document-preparation";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentKind,
  isExtractedDocumentAttachmentMimeType,
} from "../../../shared/attachments";
import { DocumentAttachmentError } from "./attachment-errors";
import { prepareDocumentAttachments } from "./document-attachment-context";
import type { ResolvedAttachmentPayload } from "./trusted-attachment-resolver";

function admitExtractedDocuments(
  payloads: readonly ResolvedAttachmentPayload[],
): ResolvedAttachmentPayload[] {
  let count = payloads.filter(({ source }) => !source).length;
  let bytes = payloads.reduce((total, payload) => total + (payload.source ? 0 : payload.bytes.byteLength), 0);
  return payloads.map((payload) => {
    if (!payload.source || payload.bytes.byteLength === 0) return payload;
    const admitted = isExtractedDocumentAttachmentMimeType(payload.attachment.mimeType)
      && payload.bytes.byteLength <= MAX_CHAT_ATTACHMENT_BYTES
      && count < MAX_CHAT_ATTACHMENTS
      && bytes + payload.bytes.byteLength <= MAX_CHAT_ATTACHMENT_TOTAL_BYTES;
    if (!admitted) return { ...payload, bytes: new Uint8Array() };
    count += 1;
    bytes += payload.bytes.byteLength;
    return payload;
  });
}

export function createBrokeredDocumentPreparer(runner: DocumentPreparationRunner): typeof prepareDocumentAttachments {
  return async (requested, options = {}) => {
    const payloads = admitExtractedDocuments(requested);
    const decoded = payloads.filter(({ attachment, bytes, source }) =>
      !source || (isExtractedDocumentAttachmentMimeType(attachment.mimeType) && bytes.byteLength > 0));
    if (!decoded.some(({ attachment, source }) =>
      source !== undefined || attachment.mimeType === "application/pdf")) {
      return await prepareDocumentAttachments(payloads, options);
    }
    const passedThrough = payloads.filter((payload) => !decoded.includes(payload));
    const decodedProducesImages = decoded.some(({ attachment }) =>
      chatAttachmentKind(attachment.mimeType) === "image" || attachment.mimeType === "application/pdf");
    if (decodedProducesImages && passedThrough.some(({ attachment }) => chatAttachmentKind(attachment.mimeType) === "image")) {
      throw new DocumentAttachmentError("These attachments cannot be prepared together. Send the images separately.");
    }
    const now = options.now ?? Date.now;
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity, now() + DOCUMENT_PREPARATION_TIMEOUT_MS);
    const checkPending = (): void => {
      if (options.signal?.aborted || now() >= deadlineAt) throw new DocumentAttachmentError("Document preparation was cancelled or expired.");
    };
    checkPending();
    const execution = runner({ deadlineAt, payloads: decoded.map(({ attachment, bytes }) => ({
      id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, bytes,
    })) }, options.signal);
    const stopped = execution.stopped.then(() => true, () => false);
    const adopted: string[] = [];
    try {
      const result = await execution.result;
      if (!await stopped) throw new DocumentAttachmentError("Document decoder shutdown is unconfirmed.");
      checkPending();
      if (result.images.length > 0 && !options.generatedAttachmentStore) {
        throw new DocumentAttachmentError("Scanned PDF pages require private generated-attachment storage.");
      }
      const generated = new Map<string, string>();
      for (const image of result.images) {
        checkPending();
        const path = await options.generatedAttachmentStore!.writeJpeg(image.bytes);
        adopted.push(path);
        generated.set(image.id, path);
      }
      checkPending();
      const source = new Map(payloads.map(({ attachment }) => [attachment.id, attachment.path]));
      const imagePaths = decodedProducesImages
        ? result.imageOrder.map((entry) => {
            const path = "sourceId" in entry ? source.get(entry.sourceId) : generated.get(entry.generatedId);
            if (!path) throw new DocumentAttachmentError("Document preparation returned an unknown image identity.");
            return path;
          })
        : passedThrough.flatMap(({ attachment }) =>
            chatAttachmentKind(attachment.mimeType) === "image" ? [attachment.path] : []);
      return { contexts: result.contexts, generatedImagePaths: imagePaths.filter((path) => adopted.includes(path)), imagePaths };
    } catch (error) {
      await stopped;
      await options.generatedAttachmentStore?.release(adopted).catch(() => undefined);
      throw error instanceof DocumentAttachmentError ? error : new DocumentAttachmentError("The document could not be prepared safely.");
    }
  };
}
